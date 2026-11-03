'use strict';
// Pure offline tests: built-in Node modules, synthetic records and fixed Git source only.
// No APP/API execution, real records/accounts, network, browser, hardware or file writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const time = require('../docs/equipment/js/equipment-time.js');
const core = require('../docs/equipment/js/equipment-analysis-core.js');
const root = path.resolve(__dirname, '..');
const helperSource = fs.readFileSync(path.join(root, 'docs/equipment/js/equipment-time.js'), 'utf8');
const coreSource = fs.readFileSync(path.join(root, 'docs/equipment/js/equipment-analysis-core.js'), 'utf8');
const controllerSource = fs.readFileSync(path.join(root, 'docs/equipment/js/equipment-analysis.js'), 'utf8');
const DAY = 86400000;
const tests = [];
function test(name, run) { tests.push({ name, run }); }
function ms(iso) { return Date.parse(iso); }
function fault(id, expectedAt, extra = {}) {
    return Object.assign({ id, type: 'fault', status: 'open', reportAt: '2024-03-01', expectedAt, doneAt: '' }, extra);
}
function equipment(code, records, extra = {}) {
    return Object.assign({ code, name: 'Synthetic ' + code, family: 'SYN-F', line: 'SYN-D', records }, extra);
}
function mapOf(...rows) { return Object.fromEntries(rows.map(row => [row.code, row])); }
function options(extra = {}) { return Object.assign({ asOf: '2024-03-31', start: '2024-03-01', end: '2024-03-31' }, extra); }
function analyze(records, extra = {}) { return core.analyze(mapOf(equipment('SYN-A', records)), options(extra)); }
function record(result, id) { return result.backlog.find(row => row.recordId === id); }
function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze); Object.freeze(value);
    }
    return value;
}

// A deterministic signature compared in fresh processes, not by changing TZ mid-test.
function timezoneSignature() {
    return {
        defaultDue: time.defaultDue(ms('2024-02-28T16:15:59.456Z')),
        day: time.day(ms('2024-12-31T16:00:00Z')),
        date: time.parse('0099-12-31'), minute: time.parse('0004-02-29T23:59'),
        legacyEdge: [0, 1].map(n => time.overdueMs('2024-03-31', ms('2024-03-31T15:59:59.999Z') + n)),
        delay: time.delayDays('2024-02-29T10:11', '2024-03-01'),
        core: analyze([fault('minute', '2024-03-31T10:00'), fault('legacy', '2024-03-31')], {
            asOfTime: '2024-03-31T02:01:00Z'
        })
    };
}
if (process.argv.includes('--tz-child')) {
    process.stdout.write(JSON.stringify(timezoneSignature()));
} else {
    test('CommonJS exact API exports', () => {
        assert.deepEqual(Object.keys(time).sort(), ['parse', 'normalize', 'stamp', 'day', 'defaultDue', 'input', 'format', 'overdueMs', 'delayDays', 'isDelayed'].sort());
        Object.values(time).forEach(value => assert.equal(typeof value, 'function'));
    });
    test('browser UMD loads helper before core, no duplicated implementation', () => {
        const context = vm.createContext({ window: {} });
        vm.runInContext(helperSource, context);
        vm.runInContext(coreSource, context);
        assert.equal(context.window.EquipTime.stamp(0), '1970-01-01T08:00');
        assert.equal(context.window.EquipAnalysis.analyze({}, options()).summary.backlogCount, 0);
        assert.throws(() => vm.runInNewContext(coreSource, { window: {} }), /EquipTime is required/);
    });
    test('AMD helper and core explicitly wire one dependency', () => {
        let exported;
        const defineTime = (dependencies, factory) => { assert.deepEqual(Array.from(dependencies), []); exported = factory(); };
        defineTime.amd = {};
        vm.runInNewContext(helperSource, { define: defineTime });
        const defineCore = (dependencies, factory) => {
            assert.deepEqual(Array.from(dependencies), ['./equipment-time']);
            assert.equal(factory(exported).parseDate('2024-03-31'), ms('2024-03-31T00:00:00Z'));
        };
        defineCore.amd = {};
        vm.runInNewContext(coreSource, { define: defineCore });
    });
    test('strict minute result is a Beijing instant', () => {
        assert.deepEqual(time.parse('2024-02-29T09:07'), {
            kind: 'datetime', day: '2024-02-29', value: '2024-02-29T09:07',
            ms: ms('2024-02-29T01:07:00Z'), input: '2024-02-29T09:07'
        });
    });
    test('legacy stays a date with exact day-end cutoff and derived input', () => {
        assert.deepEqual(time.parse('2024-02-29'), {
            kind: 'date', day: '2024-02-29', value: '2024-02-29',
            ms: ms('2024-02-29T15:59:59.999Z'), input: '2024-02-29T23:59'
        });
        assert.equal(time.normalize('2024-02-29'), '2024-02-29');
        assert.equal(time.input('2024-02-29'), '2024-02-29T23:59');
    });
    test('default is precisely plus 24 hours before minute truncation', () => {
        const now = ms('2024-03-01T02:03:59.987Z');
        assert.equal(time.defaultDue(now), '2024-03-02T10:03');
        assert.equal(time.defaultDue(now), time.stamp(now + DAY));
        assert.equal(time.parse(time.defaultDue(now)).ms, now + DAY - 59987);
    });
    test('default handles cross-year and leap-day transitions', () => {
        const cases = [
            ['2023-12-31T15:59:00Z', '2024-01-01T23:59'],
            ['2024-02-28T16:15:00Z', '2024-03-01T00:15'],
            ['2024-02-27T16:15:00Z', '2024-02-29T00:15'],
            ['2023-02-27T16:15:00Z', '2023-03-01T00:15'],
            ['0099-12-31T15:59:00Z', '0100-01-01T23:59']
        ];
        cases.forEach(([iso, expected]) => assert.equal(time.defaultDue(ms(iso)), expected));
    });
    test('stamp/day use Beijing midnight, not host timezone', () => {
        assert.equal(time.stamp(ms('2024-03-31T15:59:59.999Z')), '2024-03-31T23:59');
        assert.equal(time.stamp(ms('2024-03-31T16:00:00Z')), '2024-04-01T00:00');
        assert.equal(time.day(ms('2024-03-31T16:00:00Z')), '2024-04-01');
        assert.equal(time.stamp(0), '1970-01-01T08:00');
    });
    test('years 0001 through 0099 never remap into 1900s', () => {
        for (let year = 1; year < 100; year++) {
            const prefix = String(year).padStart(4, '0');
            for (const suffix of ['-01-01T00:00', '-12-31T23:59']) {
                const value = prefix + suffix;
                assert.equal(time.parse(value).ms, ms(value + ':00+08:00'), value);
                assert.equal(time.stamp(time.parse(value).ms), value);
            }
        }
        assert.equal(time.parse('0001-01-01').ms, ms('0001-01-01T23:59:59.999+08:00'));
    });
    test('Gregorian leap rules and valid max year', () => {
        ['0004-02-29', '0096-02-29', '0400-02-29', '2000-02-29', '2024-02-29', '9999-12-31'].forEach(value => assert.ok(time.parse(value), value));
        ['0001-02-29', '0100-02-29', '1900-02-29', '2100-02-29'].forEach(value => assert.equal(time.parse(value), null, value));
        assert.equal(time.stamp(time.parse('9999-12-31T23:59').ms), '9999-12-31T23:59');
    });
    test('reject malformed dates/minutes without Date auto-normalization', () => {
        const bad = ['0000-01-01', '10000-01-01', '2023-02-29', '2024-02-30', '2024-04-31', '2024-00-01', '2024-13-01',
            '2024-01-00', '2024-01-32', '2024-2-01', '24-02-01', '2024/02/01', '2024-02-01 ', ' 2024-02-01',
            '2024-02-01t12:00', '2024-02-01T24:00', '2024-02-01T12:60', '2024-02-01T1:00', '2024-02-01T01:0',
            '2024-02-01T12:00:00', '2024-02-01T12:00Z', '2024-02-01T12:00+08:00', '2024-02-01T12:00.1',
            '2024-02-01\n', '2024-02-01T12:00\n', '0x123', 'Infinity', 'NaN', '', '   '];
        bad.forEach(value => assert.equal(time.parse(value), null, JSON.stringify(value)));
    });
    test('reject objects and primitives without coercion or side effects', () => {
        const evil = { toString() { throw Error('must not coerce'); }, valueOf() { throw Error('must not coerce'); } };
        [null, undefined, false, true, 0, 123, NaN, Infinity, -Infinity, {}, [], evil, new String('2024-01-01'), Symbol('date'), 1n].forEach(value => {
            assert.equal(time.parse(value), null);
            assert.equal(time.normalize(value), null);
            assert.equal(time.input(value), '');
            assert.equal(time.format(value), '');
            assert.equal(time.overdueMs(value, 0), 0);
        });
    });
    test('numeric APIs reject hex strings/nonfinite/coercible objects', () => {
        [null, undefined, false, true, '0', '0x10', '1700000000000', NaN, Infinity, -Infinity, {}, []].forEach(value => {
            assert.equal(time.stamp(value), ''); assert.equal(time.day(value), ''); assert.equal(time.defaultDue(value), '');
            assert.equal(time.overdueMs('2024-03-01', value), 0);
        });
        assert.equal(time.stamp(8.64e15), '');
        assert.equal(time.defaultDue(time.parse('9999-12-31T23:59').ms), '');
    });
    test('normalize empty is empty, valid remains exact, invalid is null', () => {
        assert.equal(time.normalize(''), ''); assert.equal(time.normalize(' '), null);
        assert.equal(time.normalize('2024-03-01T01:02'), '2024-03-01T01:02');
        assert.equal(time.normalize('2024-02-30'), null);
    });
    test('display/input preserve legacy; display preserves invalid raw string', () => {
        assert.equal(time.input('2024-03-01T01:02'), '2024-03-01T01:02');
        assert.equal(time.input('invalid'), '');
        assert.equal(time.format('2024-03-01T01:02'), '2024-03-01 01:02');
        assert.equal(time.format('2024-03-01'), '2024-03-01');
        const raw = '<img src=x onerror="attack()">';
        assert.equal(time.format(raw), raw); // UI caller is responsible for escaping.
    });
    test('minute cutoff has strict greater-than overdue boundary', () => {
        const due = time.parse('2024-03-31T10:20').ms;
        assert.equal(time.overdueMs('2024-03-31T10:20', due - 1), 0);
        assert.equal(time.overdueMs('2024-03-31T10:20', due), 0);
        assert.equal(time.overdueMs('2024-03-31T10:20', due + 1), 1);
        assert.equal(time.overdueMs('2024-03-31T10:20', due + 60000), 60000);
    });
    test('legacy cutoff includes final millisecond, no backfill', () => {
        const value = '2024-03-31', due = ms('2024-03-31T15:59:59.999Z');
        assert.equal(time.overdueMs(value, due), 0);
        assert.equal(time.overdueMs(value, due + 1), 1);
        assert.equal(value, '2024-03-31');
        assert.equal(time.parse(value).value, value);
    });
    test('completion delay is natural days, same date cannot imply hourly lateness', () => {
        [['2024-03-01T00:01', '2024-03-01', 0], ['2024-03-01T23:59', '2024-03-02', 1],
            ['2024-02-28T12:00', '2024-03-01', 2], ['2024-02-29', '2024-03-01', 1],
            ['2023-12-31T12:00', '2024-01-01', 1], ['0099-12-31', '0100-01-01', 1],
            ['2024-03-02', '2024-03-01', 0]].forEach(([due, done, days]) => {
            assert.equal(time.delayDays(due, done), days);
            assert.equal(time.isDelayed(due, done), days > 0);
        });
    });
    test('completion helper rejects bad dates and invented completion minutes', () => {
        [['invalid', '2024-03-01'], ['2024-02-30', '2024-03-01'], ['2024-02-28', '2024-02-30'],
            ['2024-03-01T01:00', '2024-03-02T02:00'], [null, null], ['2024-03-01', {}]].forEach(([due, done]) => {
            assert.equal(time.delayDays(due, done), 0); assert.equal(time.isDelayed(due, done), false);
        });
    });
    test('core legacy full output, priorityGroups and frozen data match fixed base', () => {
        const source = execFileSync('git', ['show', 'd5b2f8f:docs/equipment/js/equipment-analysis-core.js'], { cwd: root, encoding: 'utf8', windowsHide: true });
        const mod = { exports: {} };
        vm.runInThisContext('(function(module){\n' + source + '\n})', { filename: 'synthetic-equipment-analysis-base-d5b2f8f.js' })(mod);
        const data = freeze(mapOf(
            equipment('SYN-A', [fault('past', '2024-03-30'), fault('today', '2024-03-31'), fault('future', '2024-04-01')], { family: ' Pump ' }),
            equipment('SYN-B', [fault('done', '2024-03-15', { status: 'done', doneAt: '2024-03-16', cost: 0, cause1: 'SYN-1', cause2: 'SYN-2', cause3: 'SYN-3' }), fault('bad', '2024-02-30')], { family: 'Pump' }),
            equipment('SYN-IDLE', [], { family: 'Pump' }),
            equipment('GEN-SYN', [fault('generic', '')], { family: 'Pump' })
        ));
        const snapshot = JSON.stringify(data);
        for (const extra of [{}, { family: 'Pump' }, { family: ' Pump ' }, { department: 'none' }, { start: '2024-03-10', end: '2024-03-20' }]) {
            const opts = freeze(options(extra));
            assert.deepEqual(core.analyze(data, opts), mod.exports.analyze(data, opts));
        }
        assert.equal(JSON.stringify(data), snapshot);
    });
    test('core date-only fields reject trailing line breaks, no accidental dollar-anchor match', () => {
        assert.equal(core.parseDate('2024-03-31\n'), null);
        assert.throws(() => analyze([], { asOf: '2024-03-31\n' }), /asOf 日期无效/);
        const result = analyze([fault('report', '2024-03-31', { reportAt: '2024-03-01\n' }),
            fault('done', '2024-03-31', { status: 'done', doneAt: '2024-03-02\n' })]);
        assert.equal(result.quality.invalidDateCount, 2);
    });
    test('core minute is valid, date-only report/done remain strict', () => {
        const result = analyze([fault('valid', '2024-03-31T10:00'),
            fault('bad-report', '2024-03-31T10:00', { reportAt: '2024-03-01T01:00' }),
            fault('bad-done', '2024-03-31T10:00', { status: 'done', doneAt: '2024-03-02T01:00' })]);
        assert.equal(result.quality.invalidDateCount, 2);
        assert.equal(result.summary.unknownDueCount, 1);
        assert.equal(result.summary.completedCount, 0);
        assert.equal(record(result, 'valid').expectedAt, '2024-03-31T10:00');
    });
    test('core minute overdue uses asOfTime instant and exact edge', () => {
        const due = time.parse('2024-03-31T10:00').ms;
        for (const [delta, expected] of [[-1, 'not-overdue'], [0, 'not-overdue'], [1, 'overdue'], [60000, 'overdue']]) {
            const result = analyze([fault('edge', '2024-03-31T10:00')], { asOfTime: due + delta });
            assert.equal(record(result, 'edge').overdue, expected);
            assert.equal(record(result, 'edge').overdueDays, Math.max(0, delta) / DAY);
            assert.equal(result.summary.overdueCount, expected === 'overdue' ? 1 : 0);
            assert.equal(result.quality.invalidDateCount, 0);
        }
    });
    test('core ISO Z and offsets represent the same instant without host TZ', () => {
        const records = [fault('minute', '2024-03-31T10:00')];
        const expected = analyze(records, { asOfTime: ms('2024-03-31T02:01:02.003Z') });
        ['2024-03-31T02:01:02.003Z', '2024-03-31T10:01:02.003+08:00', '2024-03-30T22:01:02.003-04:00'].forEach(asOfTime => {
            assert.deepEqual(analyze(records, { asOfTime }), expected);
        });
        assert.equal(record(analyze(records, { asOfTime: '2024-03-31T02:01Z' }), 'minute').overdueDays, 60000 / DAY);
    });
    test('core invalid asOfTime rejects objects/hex/nonfinite/bad ISO', () => {
        [null, {}, [], true, NaN, Infinity, -Infinity, '0x123', '1711840000000', '',
            '2024-02-30T01:00Z', '2024-03-31T02:01', '2024-03-31', '2024-03-31T24:00Z',
            '2024-03-31T02:01:60Z', '2024-03-31T02:01+24:00', '2024-03-31T02:01+08:60',
            '2024-03-31T02:01Z\n', 8.64e15].forEach(asOfTime => {
            assert.throws(() => analyze([], { asOfTime }), /asOfTime/, String(asOfTime));
        });
    });
    test('core omitted instant is reproducible Beijing day-end, legacy remains unchanged', () => {
        const records = [fault('minute', '2024-03-31T23:59'), fault('legacy', '2024-03-31'), fault('past', '2024-03-30')];
        const result = analyze(records);
        assert.deepEqual(result, analyze(records, { asOfTime: '2024-03-31T23:59:59.999+08:00' }));
        assert.equal(record(result, 'minute').overdue, 'overdue');
        assert.equal(record(result, 'legacy').overdue, 'not-overdue');
        assert.equal(record(result, 'past').overdueDays, 1);
        const atMorning = analyze(records, { asOfTime: '2024-03-31T09:00+08:00' });
        assert.equal(record(atMorning, 'legacy').overdue, 'not-overdue');
        assert.equal(record(atMorning, 'past').overdueDays, 1);
        assert.equal(record(atMorning, 'minute').overdue, 'not-overdue');
    });
    test('core legacy cutoff also includes last millisecond under explicit asOfTime', () => {
        const result = analyze([fault('legacy', '2024-03-31')], { asOfTime: time.parse('2024-03-31').ms });
        assert.equal(record(result, 'legacy').overdue, 'not-overdue');
        const next = analyze([fault('legacy', '2024-03-31')], { asOf: '2024-04-01', asOfTime: time.parse('2024-03-31').ms + 1 });
        assert.equal(record(next, 'legacy').overdue, 'overdue');
        assert.equal(record(next, 'legacy').overdueDays, 1);
    });
    test('core retains invalid/missing/reversed due quality and exact family/GEN rules', () => {
        const data = freeze(mapOf(
            equipment('SYN-A', [fault('valid', '2024-03-31T10:00'), fault('bad', '2024-02-30T10:00'), fault('reversed', '2024-02-29T23:59'), fault('missing', '')], { family: ' Pump ' }),
            equipment('SYN-B', [fault('other', '2024-03-31T10:00')], { family: 'Pump' }),
            equipment('GEN-SYN', [fault('generic', '2024-03-31T10:00')], { family: ' Pump ' })
        ));
        const result = core.analyze(data, options({ family: ' Pump ', asOfTime: '2024-03-31T10:01+08:00' }));
        assert.equal(result.scope.equipmentCount, 2);
        assert.equal(result.quality.invalidDateCount, 2);
        assert.equal(result.summary.unknownDueCount, 3);
        assert.equal(result.summary.overdueCount, 2);
        assert.deepEqual(result.priority.map(row => row.code), ['SYN-A']);
        assert.deepEqual(result.priorityGroups.map(group => group.name), ['Pump']);
        assert.equal(result.priorityGroups[0].overdueCount, 1);
        assert.equal(result.generic[0].overdueCount, 1);
    });
    test('core completion/cycle use only registered dates, no completion timestamp output', () => {
        const result = analyze([fault('done', '2024-03-01T00:01', { status: 'done', doneAt: '2024-03-01', cost: 1 })]);
        assert.equal(result.summary.completedCount, 1);
        assert.equal(result.summary.cycleDays, 0);
        assert.equal(result.summary.overdueCount, 0);
        assert.equal(result.quality.invalidDateCount, 0);
        assert.equal(/completedAt|completionTimestamp|doneTimestamp|doneTime/.test(JSON.stringify(result)), false);
    });
    test('controller wires same snapshot instant and escapes formatted expected time', () => {
        assert.match(controllerSource, /asOfTime: state\.asOfTime/);
        assert.match(controllerSource, /state\.asOfTime = Date\.now\(\); state\.asOf = todayISO\(state\.asOfTime\)/);
        assert.match(controllerSource, /esc\(EquipTime\.format\(row\.expectedAt\)/);
        assert.match(controllerSource, /不能作小时级完工或及时性结论/);
        // Compile without executing or simulating business RPC or account state.
        new vm.Script(controllerSource, { filename: 'synthetic-controller-syntax.js' });
    });
    test('four independent host timezones produce identical helper/core results', () => {
        const expected = JSON.stringify(timezoneSignature());
        for (const TZ of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Pacific/Kiritimati']) {
            const output = execFileSync(process.execPath, [__filename, '--tz-child'], {
                cwd: root, env: Object.assign({}, process.env, { TZ }), encoding: 'utf8', windowsHide: true
            });
            assert.equal(output, expected, TZ);
        }
    });

    let failed = 0;
    for (const item of tests) {
        try { item.run(); console.log('[PASS] ' + item.name); }
        catch (error) { failed++; console.error('[FAIL] ' + item.name); console.error(error.stack || String(error)); }
    }
    console.log('\nEquipment time: ' + (tests.length - failed) + ' passed / ' + failed + ' failed (' + tests.length + ' scenarios)');
    if (failed) process.exitCode = 1;
}
