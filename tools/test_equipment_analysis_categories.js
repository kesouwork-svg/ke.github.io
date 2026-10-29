'use strict';
// Offline regression: synthetic/frozen graphs only. The fixed Git baseline is
// JavaScript source, not equipment data; no APP, user JSON, network or hardware.
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const core = require('../docs/equipment/js/equipment-analysis-core.js');
const BASE = 'd399bccfb5e05bff75419a1c40cd6914bba95650';
const baselineSource = execFileSync('git', [
    'show', BASE + ':docs/equipment/js/equipment-analysis-core.js'
], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true });
const baselineModule = { exports: {} };
vm.runInThisContext('(function(module){\n' + baselineSource + '\n})', {
    filename: 'synthetic-equipment-analysis-baseline-' + BASE + '.js'
})(baselineModule);
const baseline = baselineModule.exports;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function cloneGraph(value, seen = new Map()) {
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    const copy = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
    seen.set(value, copy);
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if ('value' in descriptor) descriptor.value = cloneGraph(descriptor.value, seen);
        Object.defineProperty(copy, key, descriptor);
    }
    return copy;
}
function freezeGraph(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if ('value' in descriptor) freezeGraph(descriptor.value, seen);
    }
    return Object.freeze(value);
}
// Compare descriptors instead of reading values through getters. Preserve cycles,
// aliasing, prototypes, symbols and frozen flags as well as every own input field.
function assertSameGraph(value, copy, seen = new Map()) {
    if (!value || typeof value !== 'object') { assert.ok(Object.is(value, copy)); return; }
    if (seen.has(value)) { assert.strictEqual(seen.get(value), copy); return; }
    seen.set(value, copy);
    assert.strictEqual(Object.getPrototypeOf(value), Object.getPrototypeOf(copy));
    assert.deepStrictEqual(Reflect.ownKeys(value), Reflect.ownKeys(copy));
    for (const key of Reflect.ownKeys(value)) {
        const left = Object.getOwnPropertyDescriptor(value, key);
        const right = Object.getOwnPropertyDescriptor(copy, key);
        assert.equal(left.enumerable, right.enumerable);
        assert.equal(left.configurable, right.configurable);
        assert.equal('value' in left, 'value' in right);
        if ('value' in left) {
            assert.equal(left.writable, right.writable);
            assertSameGraph(left.value, right.value, seen);
        } else {
            assert.strictEqual(left.get, right.get);
            assert.strictEqual(left.set, right.set);
        }
    }
}
function fault(id, reportAt = '2024-03-01', extra = {}) {
    return Object.assign({
        id, type: 'fault', no: 'SYN-WO-' + id, status: 'open', reportAt,
        expectedAt: '2024-03-20', doneAt: '', symptom: 'Synthetic symptom'
    }, extra);
}
function done(id, reportAt = '2024-03-01', extra = {}) {
    return fault(id, reportAt, Object.assign({
        status: 'done', doneAt: '2024-03-02', cost: 0,
        cause1: 'SYN-1', cause2: 'SYN-2', cause3: 'SYN-3'
    }, extra));
}
function equipment(code, records = [], extra = {}) {
    return Object.assign({ code, name: 'Synthetic ' + code, family: 'SYN-F', line: 'SYN-D1', records }, extra);
}
function mapOf(...rows) {
    const map = Object.create(null);
    for (const row of rows) map[row.code] = row;
    return map;
}
const GROUP_FIELDS = ['name', 'equipmentCount', 'activeEquipmentCount', 'newCount',
    'threeMonthNewCount', 'backlogCount', 'overdueCount', 'devices'];
const TOTAL_FIELDS = ['newCount', 'threeMonthNewCount', 'backlogCount', 'overdueCount'];
function assertGroupInvariants(result) {
    assert.ok(Array.isArray(result.priorityGroups));
    const all = [];
    for (const group of result.priorityGroups) {
        assert.deepStrictEqual(Object.keys(group), GROUP_FIELDS);
        assert.equal(typeof group.name, 'string');
        assert.ok(group.devices.length > 0);
        assert.equal(group.activeEquipmentCount, group.devices.length);
        assert.ok(Number.isInteger(group.equipmentCount));
        assert.ok(group.equipmentCount >= group.activeEquipmentCount);
        let lastIndex = -1;
        for (const row of group.devices) {
            const index = result.priority.indexOf(row);
            assert.ok(index > lastIndex, 'devices must be original priority rows in original order');
            assert.ok(!row.code.startsWith('GEN-'));
            lastIndex = index;
            all.push(row.code);
        }
        for (const field of TOTAL_FIELDS) {
            assert.equal(group[field], group.devices.reduce((total, row) => total + row[field], 0), field);
        }
    }
    assert.deepStrictEqual(all.sort(), result.priority.map(row => row.code).sort());
}
function analyze(map, extra = {}) {
    const options = Object.assign({
        asOf: '2024-03-31', start: '2024-03-01', end: '2024-03-31', department: '', family: ''
    }, extra);
    freezeGraph(map);
    freezeGraph(options);
    const before = cloneGraph(map), beforeOptions = cloneGraph(options);
    const expected = baseline.analyze(map, options);
    assertSameGraph(map, before);
    assertSameGraph(options, beforeOptions);
    const result = core.analyze(map, options);
    assertSameGraph(map, before);
    assertSameGraph(options, beforeOptions);
    const oldFields = {};
    for (const key of Object.keys(result)) if (key !== 'priorityGroups') oldFields[key] = result[key];
    assert.deepStrictEqual(oldFields, expected, 'all legacy result fields must match fixed baseline exactly');
    assertGroupInvariants(result);
    return result;
}
function group(result, name) {
    const found = result.priorityGroups.find(item => item.name === name);
    assert.ok(found, 'missing category ' + name);
    return found;
}
function counts(actual, expected) {
    for (const key of Object.keys(expected)) assert.deepStrictEqual(actual[key], expected[key], key);
}
function sharedFixture() {
    return mapOf(
        equipment('SYN-A', [fault('a')], { family: ' Pump ', line: 'SYN-D1', spec: 'SYN-SPEC-1' }),
        equipment('SYN-B', [fault('b-old', '2024-02-01', { expectedAt: '2024-02-10' }), done('b-new')],
            { family: 'Pump', line: 'SYN-D2', spec: 'SYN-SPEC-2' }),
        equipment('SYN-C', [], { family: 'Pump', line: 'SYN-D1', spec: 'SYN-SPEC-3' }),
        equipment('SYN-D', [done('d-old', '2023-01-01', { doneAt: '2023-01-02' })],
            { family: 'Pump', line: 'SYN-D3', spec: 'SYN-SPEC-4' }),
        equipment('SYN-E', [fault('e')], { family: 'Valve', line: 'SYN-D1' })
    );
}

test('empty result adds exactly an empty priorityGroups array', () => {
    assert.deepStrictEqual(analyze(mapOf()).priorityGroups, []);
    assert.equal(typeof core.groupKeyOf, 'function');
});
test('list-compatible family/name/category precedence, raw name and empty family fallback', () => {
    const cases = [
        [{ family: '  Pump\t', name: 'ignored', category: 'admin' }, 'Pump'],
        [{ family: '', name: '  raw name  ', category: 'admin' }, '  raw name  '],
        [{ family: '', name: '' }, '生产设备'], [{}, '生产设备'],
        [{ category: 'prod' }, '生产设备'], [{ category: 'admin' }, '行政设施'],
        [{ category: 'facility' }, '系统设施'], [{ category: 'misc' }, '事务杂项'],
        [{ category: 'unknown' }, '未分类'], [{ category: '__proto__' }, '未分类'],
        [{ category: 'constructor' }, '未分类'], [{ category: '' }, '生产设备']
    ];
    for (const [input, expected] of cases) {
        freezeGraph(input);
        const before = cloneGraph(input);
        assert.equal(core.groupKeyOf(input), expected);
        assertSameGraph(input, before);
    }
});
test('whitespace-only family remains an empty key, not name/category fallback', () => {
    const result = analyze(mapOf(
        equipment('SYN-A', [fault('a')], { family: ' \t ', name: 'Name A' }),
        equipment('SYN-B', [fault('b')], { family: '\n ', name: 'Name B' }),
        equipment('SYN-IDLE', [], { family: '  ' })
    ));
    counts(group(result, ''), { equipmentCount: 3, activeEquipmentCount: 2, newCount: 2 });
    assert.deepStrictEqual(result.priorityGroups.map(item => item.name), ['']);
});
test('safe truthy primitive family uses String/trim without object coercion', () => {
    assert.equal(core.groupKeyOf(freezeGraph({ family: 23, name: 'ignored' })), '23');
    assert.equal(core.groupKeyOf(freezeGraph({ family: true })), 'true');
    assert.equal(core.groupKeyOf(freezeGraph({ family: 12n })), '12');
    assert.equal(core.groupKeyOf(freezeGraph({ family: Symbol('SYN') })), 'Symbol(SYN)');
    assert.equal(core.groupKeyOf(freezeGraph({ family: 0, name: 'Name' })), 'Name');
});
test('family category merges across specifications and departments with all-equipment denominator', () => {
    const result = analyze(sharedFixture());
    const pump = group(result, 'Pump');
    counts(pump, { equipmentCount: 4, activeEquipmentCount: 2, newCount: 2,
        threeMonthNewCount: 3, backlogCount: 2, overdueCount: 2 });
    assert.deepStrictEqual(pump.devices.map(row => row.code), ['SYN-B', 'SYN-A']);
    assert.deepStrictEqual(result.priorityGroups.map(item => item.name), ['Pump', 'Valve']);
    assert.equal(result.priority[0].family, 'Pump');
    assert.equal(result.priority.find(row => row.code === 'SYN-A').family, ' Pump ');
});
test('department filter keeps its exact legacy meaning and limits category denominator', () => {
    const result = analyze(sharedFixture(), { department: 'SYN-D1' });
    counts(group(result, 'Pump'), { equipmentCount: 2, activeEquipmentCount: 1, newCount: 1 });
    assert.ok(result.priority.every(row => row.department === 'SYN-D1'));
    assert.deepStrictEqual(analyze(sharedFixture(), { department: 'SYN-NONE' }).priorityGroups, []);
});
test('family filter remains raw/exact, not the trimmed grouping key', () => {
    const raw = analyze(sharedFixture(), { family: ' Pump ' });
    counts(group(raw, 'Pump'), { equipmentCount: 1, activeEquipmentCount: 1 });
    assert.deepStrictEqual(group(raw, 'Pump').devices.map(row => row.code), ['SYN-A']);
    const trimmed = analyze(sharedFixture(), { family: 'Pump' });
    counts(group(trimmed, 'Pump'), { equipmentCount: 3, activeEquipmentCount: 1 });
    assert.deepStrictEqual(group(trimmed, 'Pump').devices.map(row => row.code), ['SYN-B']);
    assert.deepStrictEqual(analyze(sharedFixture(), { department: 'SYN-D1', family: 'Pump' }).priorityGroups, []);
});
test('whitespace family filters remain raw/exact even though category key is empty', () => {
    const map = mapOf(
        equipment('SYN-A', [fault('a')], { family: ' ' }),
        equipment('SYN-B', [fault('b')], { family: '\t' })
    );
    counts(group(analyze(map, { family: ' ' }), ''), { equipmentCount: 1, activeEquipmentCount: 1 });
    counts(group(analyze(map, { family: '\t' }), ''), { equipmentCount: 1, activeEquipmentCount: 1 });
});
test('empty family uses raw name without inferring fault classification or specification', () => {
    const result = analyze(mapOf(
        equipment('SYN-A', [fault('a', '2024-03-01', { cause1: 'Not category', cause2: 'Not category' })],
            { family: '', name: 'Raw Name', spec: 'Shared specification' }),
        equipment('SYN-B', [fault('b')], { family: '', name: ' Raw Name ', spec: 'Shared specification' }),
        equipment('SYN-C', [fault('c')], { family: '', name: 'Raw Name', spec: 'Different specification' })
    ));
    counts(group(result, 'Raw Name'), { equipmentCount: 2, activeEquipmentCount: 2 });
    counts(group(result, ' Raw Name '), { equipmentCount: 1, activeEquipmentCount: 1 });
});
test('first-level category fallback is exact and never trusts object prototype keys', () => {
    const values = ['prod', 'admin', 'facility', 'misc', 'unknown', '__proto__', 'constructor'];
    const rows = values.map((category, i) => equipment('SYN-' + i, [fault('r-' + i)],
        { family: '', name: '', category }));
    rows.push(equipment('SYN-DEFAULT', [], { family: '', name: '' }));
    const result = analyze(mapOf(...rows));
    counts(group(result, '生产设备'), { equipmentCount: 2, activeEquipmentCount: 1 });
    counts(group(result, '未分类'), { equipmentCount: 3, activeEquipmentCount: 3 });
    assert.ok(result.priorityGroups.some(item => item.name === '行政设施'));
    assert.ok(result.priorityGroups.some(item => item.name === '系统设施'));
    assert.ok(result.priorityGroups.some(item => item.name === '事务杂项'));
});
test('GEN is excluded from every category and denominator even when it has a matching family', () => {
    const result = analyze(mapOf(
        equipment('SYN-A', [fault('a')]), equipment('SYN-IDLE', []),
        equipment('GEN-SYN-A', [fault('g1'), fault('g2')]), equipment('GEN-SYN-IDLE', [])
    ));
    counts(group(result, 'SYN-F'), { equipmentCount: 2, activeEquipmentCount: 1, newCount: 1, backlogCount: 1 });
    assert.equal(result.summary.newCount, 3);
    assert.equal(result.scope.equipmentCount, 4);
    assert.equal(result.generic[0].family, 'SYN-F');
    assert.deepStrictEqual(analyze(mapOf(equipment('GEN-SYN-ONLY', [fault('g')]))).priorityGroups, []);
});
test('empty/maintenance/old/unknown/malformed records count as equipment but do not invent faults', () => {
    const result = analyze(mapOf(
        equipment('SYN-ACTIVE', [fault('active')]), equipment('SYN-EMPTY', []),
        equipment('SYN-MAINTAIN', [fault('maintain', '2024-03-01', { type: 'maintain' })]),
        equipment('SYN-OLD', [done('old', '2023-01-01', { doneAt: '2023-01-02' })]),
        equipment('SYN-UNKNOWN', [fault('unknown', '2024-03-01', { type: 'SYN-UNKNOWN' })]),
        equipment('SYN-BAD-RECORDS', null),
        equipment('SYN-INACTIVE-CATEGORY', [], { family: 'Inactive category' })
    ));
    counts(group(result, 'SYN-F'), { equipmentCount: 6, activeEquipmentCount: 1, newCount: 1, backlogCount: 1 });
    assert.equal(result.priorityGroups.length, 1);
    assert.equal(result.quality.malformedEquipmentCount, 1);
    assert.equal(result.quality.unknownTypeCount, 1);
    assert.equal(result.scope.equipmentCount, 7);
});
test('missing and accessor records count in the denominator before the old early return', () => {
    let calls = 0;
    const missing = equipment('SYN-MISSING'); delete missing.records;
    const accessor = equipment('SYN-ACCESSOR');
    Object.defineProperty(accessor, 'records', { get() { calls++; throw new Error('records getter ran'); }, enumerable: true });
    const result = analyze(mapOf(equipment('SYN-ACTIVE', [fault('active')]), missing, accessor));
    counts(group(result, 'SYN-F'), { equipmentCount: 3, activeEquipmentCount: 1 });
    assert.equal(result.quality.malformedEquipmentCount, 2);
    assert.equal(calls, 0);
});
test('malformed equipment/map accessors are not valid denominator objects', () => {
    let calls = 0;
    const map = mapOf(equipment('SYN-A', [fault('a')]));
    Object.assign(map, { 'SYN-NULL': null, 'SYN-NUMBER': 12, 'SYN-ARRAY': [], 'SYN-FUNCTION': function () {} });
    Object.defineProperty(map, 'SYN-GETTER', { enumerable: true, get() { calls++; throw new Error('map getter ran'); } });
    const result = analyze(map);
    counts(group(result, 'SYN-F'), { equipmentCount: 1, activeEquipmentCount: 1 });
    assert.equal(result.quality.malformedEquipmentCount, 5);
    assert.equal(calls, 0);
});
test('duplicate/conflicting IDs use exactly the old per-device resolution before grouping', () => {
    const repeated = fault('shared');
    const result = analyze(mapOf(
        equipment('SYN-A', [repeated, cloneGraph(repeated), fault('conflict'),
            fault('conflict', '2024-03-02'), fault('survivor')]),
        equipment('SYN-B', [fault('shared')]),
        equipment('SYN-C', [fault('only-conflict'), fault('only-conflict', '2024-03-02')])
    ));
    counts(group(result, 'SYN-F'), { equipmentCount: 3, activeEquipmentCount: 2,
        newCount: 3, threeMonthNewCount: 3, backlogCount: 3 });
    assert.equal(result.quality.duplicateCount, 1);
    assert.equal(result.quality.conflictCount, 2);
});
test('missing IDs and cross-device shared IDs retain independent old fallback counts', () => {
    const noId = fault('removed'); delete noId.id;
    const result = analyze(mapOf(
        equipment('SYN-A', [noId, cloneGraph(noId), fault('shared')]),
        equipment('SYN-B', [fault('shared')])
    ));
    counts(group(result, 'SYN-F'), { newCount: 4, backlogCount: 4, activeEquipmentCount: 2 });
    assert.equal(result.quality.missingIdCount, 2);
    assert.equal(result.quality.duplicateCount, 0);
});
test('current backlog is never clipped to selected month or three-month reports', () => {
    const result = analyze(mapOf(equipment('SYN-A', [
        fault('ancient', '2020-01-01', { expectedAt: '2020-01-02' }),
        fault('future', '2024-04-01', { expectedAt: '2024-04-02' })
    ])), { start: '2024-03-31', end: '2024-03-31' });
    counts(group(result, 'SYN-F'), { newCount: 0, threeMonthNewCount: 0, backlogCount: 2, overdueCount: 1 });
    assert.equal(result.summary.unknownDueCount, 1);
});
test('completed-in-period priority rows survive even with zero group count fields', () => {
    const result = analyze(mapOf(equipment('SYN-A', [done('completed', '2020-01-01')])));
    counts(group(result, 'SYN-F'), { equipmentCount: 1, activeEquipmentCount: 1,
        newCount: 0, threeMonthNewCount: 0, backlogCount: 0, overdueCount: 0 });
    assert.equal(result.priority[0].completedCount, 1);
    assert.equal(Object.hasOwn(result.priorityGroups[0], 'completedCount'), false);
});
test('long custom interval does not expand old priority eligibility to newCount alone', () => {
    const result = analyze(mapOf(
        equipment('SYN-OLD-NEW-ONLY', [done('old', '2023-05-01', { doneAt: '' })]),
        equipment('SYN-RECENT', [fault('recent')])
    ), { start: '2023-01-01' });
    assert.equal(result.summary.newCount, 2);
    assert.deepStrictEqual(result.priority.map(row => row.code), ['SYN-RECENT']);
    counts(group(result, 'SYN-F'), { equipmentCount: 2, activeEquipmentCount: 1, newCount: 1 });
    assert.deepStrictEqual(analyze(mapOf(equipment('SYN-OLD', [done('old', '2023-05-01', { doneAt: '' })])),
        { start: '2023-01-01' }).priorityGroups, []);
});
test('category order uses threeMonth/backlog/new/name, never list/manual/denominator priority', () => {
    const old = Array.from({ length: 10 }, (_, i) => fault('old-' + i, '2020-01-01'));
    const result = analyze(mapOf(
        equipment('SYN-01', [fault('x1'), fault('x2')], { family: 'C-new' }),
        equipment('SYN-02', [fault('x1', '2024-01-01'), fault('x2')], { family: 'B-new' }),
        equipment('SYN-03', [fault('x1'), fault('x2'), ...old], { family: 'A-backlog' }),
        equipment('SYN-04', [done('x1', '2024-01-01'), done('x2', '2024-02-01'), done('x3')], { family: 'Z-three' }),
        equipment('SYN-05', [fault('x')], { family: 'B-name' }),
        equipment('SYN-06', [fault('x')], { family: 'A-name' }),
        equipment('SYN-07', old, { family: 'A-old-backlog' }),
        equipment('SYN-IDLE1', [], { family: 'B-name' }), equipment('SYN-IDLE2', [], { family: 'B-name' })
    ));
    assert.deepStrictEqual(result.priorityGroups.map(item => item.name),
        ['Z-three', 'A-backlog', 'C-new', 'B-new', 'A-name', 'B-name', 'A-old-backlog']);
});
test('merged category totals determine rank and original priority row/code order is preserved', () => {
    const rows = [
        equipment('SYN-Z', [fault('z1'), fault('z2')], { family: 'Merged' }),
        equipment('SYN-C', [fault('c1'), fault('c2'), fault('c3')], { family: 'Single' }),
        equipment('SYN-A', [fault('a1'), fault('a2')], { family: 'Merged' })
    ];
    const first = analyze(mapOf(...rows)), second = analyze(mapOf(...rows.slice().reverse()));
    assert.deepStrictEqual(first, second);
    assert.deepStrictEqual(first.priority.map(row => row.code), ['SYN-C', 'SYN-A', 'SYN-Z']);
    assert.deepStrictEqual(first.priorityGroups.map(item => item.name), ['Merged', 'Single']);
    assert.deepStrictEqual(group(first, 'Merged').devices.map(row => row.code), ['SYN-A', 'SYN-Z']);
    assert.strictEqual(group(first, 'Merged').devices[0], first.priority[1]);
});
test('prototype-like and HTML family/name keys remain inert distinct plain data', () => {
    const attack = '<img src=x onerror="global.__categoryAttack=1"><script>global.__categoryAttack=2</script>';
    const names = ['__proto__', 'constructor', 'toString', attack];
    const rows = [];
    names.forEach((name, i) => {
        rows.push(equipment('SYN-F-' + i, [fault('f-' + i)], { family: name }));
        rows.push(equipment('SYN-N-' + i, [fault('n-' + i)], { family: '', name }));
    });
    const map = mapOf(...rows), proto = Object.getPrototypeOf(map);
    global.__categoryAttack = 0;
    try {
        const result = analyze(map);
        for (const name of names) counts(group(result, name), { equipmentCount: 2, activeEquipmentCount: 2 });
        assert.equal(global.__categoryAttack, 0);
        assert.strictEqual(Object.getPrototypeOf(map), proto);
        assert.equal(Object.prototype.polluted, undefined);
    } finally { delete global.__categoryAttack; }
});
test('own prototype-like equipment codes cannot collide with group indexes', () => {
    const map = {};
    for (const code of ['__proto__', 'constructor', 'toString']) {
        Object.defineProperty(map, code, { enumerable: true, configurable: true, writable: true,
            value: equipment(code, [fault('r')], { family: '__proto__' }) });
    }
    const result = analyze(map);
    counts(group(result, '__proto__'), { equipmentCount: 3, activeEquipmentCount: 3, backlogCount: 3 });
    assert.deepStrictEqual(group(result, '__proto__').devices.map(row => row.code), ['__proto__', 'constructor', 'toString']);
});
test('metadata getters are never executed and safe fallback honors own data fields', () => {
    let calls = 0;
    const getter = function () { calls++; throw new Error('metadata getter ran'); };
    const a = equipment('SYN-A', [fault('a')], { category: 'admin' });
    for (const key of ['family', 'name', 'line']) Object.defineProperty(a, key, { enumerable: true, get: getter });
    const b = equipment('SYN-B', [fault('b')]);
    for (const key of ['family', 'name', 'category']) Object.defineProperty(b, key, { enumerable: true, get: getter });
    const result = analyze(mapOf(a, b));
    counts(group(result, '行政设施'), { equipmentCount: 1, activeEquipmentCount: 1 });
    counts(group(result, '生产设备'), { equipmentCount: 1, activeEquipmentCount: 1 });
    assert.equal(calls, 0);
});
test('inherited equipment and inherited metadata/getters are ignored, never trusted', () => {
    let calls = 0;
    const proto = {};
    for (const key of ['family', 'name', 'category', 'line']) {
        Object.defineProperty(proto, key, { get() { calls++; throw new Error('inherited getter ran'); } });
    }
    const own = Object.create(proto);
    Object.assign(own, { code: 'SYN-OWN', records: [fault('own')] });
    const map = Object.create({ 'SYN-INHERITED': equipment('SYN-INHERITED', [fault('inherited')]) });
    map['SYN-OWN'] = own;
    const result = analyze(map);
    counts(group(result, '生产设备'), { equipmentCount: 1, activeEquipmentCount: 1 });
    assert.equal(result.scope.equipmentCount, 1);
    assert.deepStrictEqual(analyze(map, { department: 'SYN-D1' }).priorityGroups, []);
    assert.equal(calls, 0);
    const inheritedData = Object.create({ family: 'Inherited family', name: 'Inherited name', category: 'admin' });
    assert.equal(core.groupKeyOf(inheritedData), '生产设备');
});
test('non-enumerable own metadata remains visible without executing accessors', () => {
    const row = equipment('SYN-A', [fault('a')]);
    Object.defineProperty(row, 'family', { value: ' Hidden own family ', enumerable: false, configurable: true });
    counts(group(analyze(mapOf(row)), 'Hidden own family'), { equipmentCount: 1, activeEquipmentCount: 1 });
});
test('cyclic/malicious family, name and category objects are never coerced or mutated', () => {
    let calls = 0;
    const poison = Object.create(null);
    poison.self = poison;
    poison.toString = function () { calls++; throw new Error('toString ran'); };
    poison.valueOf = function () { calls++; throw new Error('valueOf ran'); };
    Object.defineProperty(poison, Symbol.toPrimitive, { get() { calls++; throw new Error('toPrimitive getter ran'); } });
    const badFunction = function () { calls++; throw new Error('family function ran'); };
    badFunction.toString = poison.toString;
    const result = analyze(mapOf(
        equipment('SYN-A', [fault('a')], { family: poison, name: poison, category: poison }),
        equipment('SYN-B', [fault('b')], { family: poison, name: 'Safe name' }),
        equipment('SYN-C', [fault('c')], { family: badFunction, name: '', category: 'misc' })
    ));
    counts(group(result, '未分类'), { equipmentCount: 1, activeEquipmentCount: 1 });
    counts(group(result, 'Safe name'), { equipmentCount: 1, activeEquipmentCount: 1 });
    counts(group(result, '事务杂项'), { equipmentCount: 1, activeEquipmentCount: 1 });
    assert.equal(calls, 0);
});
test('cyclic duplicate records and record getters keep original dedup/quality semantics', () => {
    let calls = 0;
    const a = fault('cyclic'); a.custom = { parent: a };
    Object.defineProperty(a, 'privateGetter', { enumerable: true, get() { calls++; throw new Error('record getter ran'); } });
    const result = analyze(mapOf(equipment('SYN-A', [a, cloneGraph(a)])));
    counts(group(result, 'SYN-F'), { equipmentCount: 1, activeEquipmentCount: 1, newCount: 1 });
    assert.equal(result.quality.duplicateCount, 1);
    assert.equal(calls, 0);
});
test('deterministic synthetic matrix preserves every legacy field across filters and periods', () => {
    let seed = 0x5eed2024;
    const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const families = ['SYN-X', ' SYN-X ', 'SYN-Y', '', ' \t ', '__proto__', 'constructor'];
    const dates = ['2020-01-01', '2023-12-31', '2024-01-01', '2024-02-29', '2024-03-01', '2024-03-31', '2024-04-01', '', '2024-02-30'];
    const types = ['fault', 'fault', 'maintain', 'overhaul', 'modify', 'inspect', 'SYN-UNKNOWN'];
    const rows = [];
    for (let i = 0; i < 18; i++) {
        const records = [];
        for (let j = 0; j < 8; j++) {
            const record = fault('r-' + j, dates[random(dates.length)], {
                type: types[random(types.length)], status: ['open', 'done', ''][random(3)],
                doneAt: dates[random(dates.length)], expectedAt: dates[random(dates.length)],
                cost: [0, '12.5', '', null, false, -1, 'SYN-INVALID'][random(7)]
            });
            records.push(record);
            if (j === 1) records.push(cloneGraph(record));
            if (j === 3) records.push(Object.assign({}, record, { symptom: 'SYN-CONFLICT' }));
        }
        rows.push(equipment((i % 7 === 0 ? 'GEN-SYN-' : 'SYN-') + i, records, {
            family: families[random(families.length)], line: ['SYN-D1', 'SYN-D2', ''][random(3)],
            name: i % 3 ? 'Synthetic name ' + i : '', category: ['prod', 'admin', 'facility', 'misc', 'SYN-UNKNOWN'][random(5)]
        }));
    }
    const map = mapOf(...rows);
    const filters = [{}, { department: 'SYN-D1' }, { department: 'SYN-D2' }, { family: 'SYN-X' },
        { family: ' SYN-X ' }, { family: ' \t ' }, { department: 'SYN-D1', family: 'SYN-Y' }, { family: 'SYN-NONE' }];
    const periods = [{}, { start: '2024-02-01', end: '2024-02-29' }, { start: '2023-01-01' }];
    let comparisons = 0;
    for (const filter of filters) for (const period of periods) {
        analyze(map, Object.assign({}, filter, period)); comparisons++;
    }
    assert.equal(comparisons, 24);
});

let passed = 0, failed = 0;
for (const item of tests) {
    try { item.fn(); passed++; console.log('[PASS] ' + item.name); }
    catch (error) { failed++; console.error('[FAILED] ' + item.name); console.error(error.stack || String(error)); }
}
console.log('\nEquipment analysis categories: ' + passed + ' passed / ' + failed + ' failed (' + tests.length + ' scenarios; fixed baseline ' + BASE + ')');
if (failed) process.exitCode = 1;
// Optional TZ matrix: UTC, Asia/Shanghai, America/New_York, Pacific/Kiritimati.
