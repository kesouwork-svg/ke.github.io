/* Beijing default-generation regression: real time/session/API/app, frozen synthetic VM only.
 * Run: node --unhandled-rejections=strict tools/test_equipment_beijing_time.js
 * Four independent host TZ processes; no network, real storage, production JSON, printing or notifications.
 * Only these four JS sources are read. All session/equipment/audit values live in fake Maps.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ZONES = ['UTC', 'Asia/Shanghai', 'America/New_York', 'Pacific/Kiritimati'];
const ROOT = path.resolve(__dirname, '..');
const FILES = ['docs/equipment/js/equipment-time.js', 'docs/js/session.js',
    'docs/equipment/js/equipment-api.js', 'docs/equipment/js/equipment-app.js'];
const CODE = 'SYNTHETIC-EQ', OTHER = 'SYNTHETIC-OTHER', SAME = 'SYNTHETIC-SAME-DEPT';
const DEPT = 'SYNTHETIC department';
const plain = value => JSON.parse(JSON.stringify(value));
const omit = (value, keys) => Object.fromEntries(Object.entries(plain(value)).filter(([key]) => !keys.includes(key)));
const flush = () => new Promise(resolve => setImmediate(resolve));
const OLD_AUDIT = [{ at: '2001/2/3 04:05:06', account: 'SYNTHETIC-old', action: 'SYNTHETIC historical', custom: { keep: true } }];
const CASES = [
    { iso: '2026-11-03T16:15:00.000Z', day: '2026-11-04', minute: '2026-11-04 00:15', locale: '2026/11/4 00:15:00', prefix: 'WO261104-', next: 12, weekday: '三', due: '2026-11-05T00:15' },
    { iso: '2026-11-03T02:05:00.000Z', day: '2026-11-03', minute: '2026-11-03 10:05', locale: '2026/11/3 10:05:00', prefix: 'WO261103-', next: 13, weekday: '二', due: '2026-11-04T10:05' }
];
function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}
function record(id, extra = {}) {
    return Object.assign({ id, no: 'SYNTHETIC-' + id, type: 'fault', status: 'open',
        reportAt: '2001-02-03', expectedAt: '2099-12-31', doneAt: '', reportBy: 'SYNTHETIC reporter',
        symptom: 'SYNTHETIC symptom', place: 'SYNTHETIC place', createdAt: '2001/2/3 04:05:06',
        updatedAt: '2001-02-04 07:08', createdBy: 'SYNTHETIC old creator', updatedBy: 'SYNTHETIC old editor',
        _supplements: [{ at: '2001-02-03 04:05', account: 'SYNTHETIC-old', by: 'SYNTHETIC old', text: 'SYNTHETIC old supplement' }],
        _corrections: [{ at: '2001-02-04T07:08:09+08:00', summary: 'SYNTHETIC old correction' }],
        updates: [{ at: '2001/2/3 04:05:06', text: 'SYNTHETIC old progress' }], photos: ['SYNTHETIC-photo'],
        cause1: 'SYNTHETIC cause1', cause2: 'SYNTHETIC cause2', cause3: 'SYNTHETIC cause3', cause: 'SYNTHETIC cause',
        handleType: 'repair', repairMode: 'outer', supplier: 'SYNTHETIC supplier', cost: 19, delayReason: 'SYNTHETIC delay',
        action: 'SYNTHETIC action', remark: 'SYNTHETIC remark', parts: [{ name: 'SYNTHETIC part', qty: 2 }],
        custom: { stamp: 'UNMARKED historical value', untouched: true } }, extra);
}
function fixture() {
    return {
        [CODE]: { code: CODE, name: 'SYNTHETIC machine', line: DEPT, family: 'SYNTHETIC family', status: 'active',
            _recordsRev: 'SYNTHETIC-rev-0', photos: [], records: [
                record('open', { no: 'WO261103-07' }),
                record('untouched', { expectedAt: 'UNMARKED historical value', createdAt: '2001-02-03T04:05:06Z' }),
                record('done', { no: 'WO261104-03', status: 'done', doneAt: '2001-02-06' })] },
        [OTHER]: { code: OTHER, name: 'SYNTHETIC other', line: 'SYNTHETIC other department', _recordsRev: 'SYNTHETIC-other-rev',
            records: [record('serial3', { no: 'WO261103-12' }), record('serial4', { no: 'WO261104-11' })] },
        [SAME]: { code: SAME, name: 'SYNTHETIC same department', family: 'SYNTHETIC other family', line: DEPT,
            _recordsRev: 'SYNTHETIC-same-rev', records: [] }
    };
}
function storage(initial = {}) {
    const data = new Map(Object.entries(initial)), writes = [];
    return { data, writes, getItem: key => data.has(String(key)) ? data.get(String(key)) : null,
        setItem(key, value) { data.set(String(key), String(value)); writes.push(String(key)); },
        removeItem(key) { data.delete(String(key)); writes.push(String(key)); } };
}
function element() {
    const classes = new Set();
    return { value: '', textContent: '', innerHTML: '', disabled: false, style: {},
        classList: { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key) },
        addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, querySelector() { return null; } };
}
function create(sources, c, role = 'admin') {
    const initial = freeze(fixture()), initialJson = JSON.stringify(initial), now = Date.parse(c.iso);
    class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
    const localStorage = storage({ equip_list_v2: initialJson, equip_audit_v2: JSON.stringify(OLD_AUDIT), equip_seed_v2: 'SYNTHETIC-seeded' });
    const sessionStorage = storage(), external = [], events = [], rendered = [];
    const forbidden = name => () => { external.push(name); throw new Error('Forbidden external operation: ' + name); };
    const nodes = new Map();
    for (const id of ['toast', 'rf-type', 'rf-doneAt', 'rf-handler', 'rf-action', 'rf-remark', 'rf-c1', 'rf-c2', 'rf-c3',
        'rf-cause', 'rf-handle', 'rf-mode', 'rf-supplier', 'rf-cost', 'rf-delayReason']) nodes.set(id, element());
    const ctx = vm.createContext({ console, Date: FixedDate, localStorage, sessionStorage,
        location: { search: '', pathname: '/SYNTHETIC/equipment/', href: 'about:blank', reload: forbidden('reload') },
        navigator: { sendBeacon: forbidden('sendBeacon') }, crypto: { randomUUID: () => 'SYNTHETIC-revision-' + (++ctx.__revision) }, __revision: 0,
        setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: fn => fn(), scrollTo() {},
        fetch: forbidden('fetch'), XMLHttpRequest: forbidden('XMLHttpRequest'), WebSocket: forbidden('WebSocket'),
        Image: forbidden('Image'), print: forbidden('print'), open: forbidden('window.open'),
        Notification: forbidden('Notification'), alert: forbidden('alert'), confirm: forbidden('confirm'), prompt: forbidden('prompt'),
        supabase: { createClient: forbidden('supabase.createClient') },
        document: { getElementById: id => nodes.get(id) || null, querySelectorAll: () => [], querySelector: () => null,
            addEventListener: (...args) => events.push(args), createElement: forbidden('document.createElement') },
        addEventListener: (...args) => events.push(args), matchMedia: () => ({ matches: false }) });
    ctx.window = ctx;
    for (const source of sources) vm.runInContext(source.text, ctx, { filename: source.file });
    ctx.EqConfig.cloud = false;
    const seedLocal = ctx.seedLocal;
    ctx.seedLocal = () => {
        assert.equal(localStorage.getItem('equip_seed_v2'), 'SYNTHETIC-seeded', 'Real seed must take its existing no-op guard');
        return seedLocal();
    };
    // Only final rendering is observed; saveRecord and all permissions/API writes run unmodified.
    ctx.refreshLocal = code => rendered.push(code);
    ctx.refreshDevice = forbidden('unexpected refreshDevice');
    const tools = role === 'admin' ? ['equipment-admin'] : role === 'repairer' ? ['equipment'] : role === 'reporter' ? ['equipment-report'] : [];
    ctx.SessionStore.write(JSON.stringify({ account: 'SYNTHETIC-' + role, name: 'SYNTHETIC ' + role,
        token: 'SYNTHETIC-token-' + role, tools, dept: DEPT, level: 1 }));
    ctx.ROLE = ctx.EquipApi.role(); ctx.EQ = plain(initial); ctx.currentCode = CODE;
    localStorage.writes.length = 0; sessionStorage.writes.length = 0;
    return { ctx, initial, initialJson, external, rendered, localStorage, sessionStorage,
        node: id => { assert(nodes.has(id), 'Unknown synthetic form control ' + id); return nodes.get(id); },
        data: () => JSON.parse(localStorage.getItem('equip_list_v2')),
        audit: () => JSON.parse(localStorage.getItem('equip_audit_v2')),
        cached: plain(ctx.EQ) };
}
function safe(h) {
    assert.deepEqual(h.external, [], 'No external operation may even be attempted');
    assert.equal(JSON.stringify(h.initial), h.initialJson, 'Original source fixture must remain unchanged');
    assert.deepEqual(h.sessionStorage.writes, [], 'No session changes after setup');
    assert(h.localStorage.writes.every(key => ['equip_list_v2', 'equip_audit_v2'].includes(key)), 'Only fake equipment/audit Maps may change');
    assert.deepEqual(h.audit().slice(-OLD_AUDIT.length), OLD_AUDIT, 'Historical audit timestamps/entries are immutable');
}
function audit(h, c, count = 1) {
    assert.equal(h.audit().length, OLD_AUDIT.length + count);
    for (const entry of h.audit().slice(0, count)) assert.equal(entry.at, c.locale);
    safe(h);
}
function preserved(h, before, edited = 'open') {
    const after = h.data();
    assert.deepEqual(after[OTHER], before[OTHER]);
    for (const rec of before[CODE].records) if (rec.id !== edited) {
        assert.deepEqual(after[CODE].records.find(r => r.id === rec.id), rec);
        assert.deepEqual(plain(h.ctx.EQ[CODE].records.find(r => r.id === rec.id)), h.cached[CODE].records.find(r => r.id === rec.id));
    }
}
function form(h, c) {
    const values = { 'rf-type': 'maintain', 'rf-doneAt': c.day, 'rf-handler': 'SYNTHETIC handler',
        'rf-action': ' SYNTHETIC new action ', 'rf-remark': 'SYNTHETIC new remark', 'rf-c1': 'SYNTHETIC new cause1',
        'rf-c2': 'SYNTHETIC new cause2', 'rf-c3': 'SYNTHETIC new cause3', 'rf-cause': 'SYNTHETIC new cause',
        'rf-handle': 'replace', 'rf-mode': 'inner', 'rf-supplier': 'SYNTHETIC new supplier', 'rf-cost': '99',
        'rf-delayReason': 'SYNTHETIC new delay reason' };
    for (const [id, value] of Object.entries(values)) h.node(id).value = value;
    h.ctx._parts = [{ name: ' SYNTHETIC new part ', qty: 3 }];
}
function correction(h, code = CODE, id = 'open', targetCode = code) {
    const rec = h.data()[code].records.find(r => r.id === id);
    return { targetCode, symptom: 'SYNTHETIC corrected symptom', place: 'SYNTHETIC corrected place', reason: 'SYNTHETIC reason',
        expected: { symptom: rec.symptom, place: rec.place }, cost: 99999, expectedAt: '9999-12-31', createdAt: 'FORGED', reportAt: 'FORGED' };
}
async function run() {
    // Loading happens here, after all constants are initialized, and reads no equipment data files.
    const sources = FILES.map(file => ({ file, text: fs.readFileSync(path.join(ROOT, file), 'utf8') }));
    const tests = [], add = (name, fn) => tests.push({ name, fn });
    for (const c of CASES) {
        const title = c.iso + ' ';
        add(title + 'real frozen helper/session/API/app; read-only historical load', () => {
            const h = create(sources, c);
            assert.equal(h.ctx.Date.now(), Date.parse(c.iso)); assert.equal(new h.ctx.Date().toISOString(), c.iso);
            assert.equal(h.ctx.EquipTime.day(h.ctx.Date.now()), c.day);
            assert.equal(h.ctx.EquipTime.stamp(h.ctx.Date.now()), c.minute.replace(' ', 'T'));
            assert.equal(h.ctx.today(), c.day); assert.equal(h.ctx.eqRole(), 'admin');
            assert.equal(h.ctx.SessionStore.savedAt(), Date.parse(c.iso));
            assert.deepEqual(h.data(), h.initial); assert.deepEqual(plain(h.ctx.EQ), h.initial);
            assert.deepEqual(h.localStorage.writes, []); safe(h);
        });
        add(title + 'localNextNo Beijing prefix, cross-equipment maximum and serial width', () => {
            const h = create(sources, c), before = h.data();
            assert.equal(h.ctx.localNextNo(before), c.prefix + c.next);
            assert.equal(h.ctx.localNextNo({}), c.prefix + '01');
            assert.equal(h.ctx.localNextNo({ SYNTHETIC: { records: [{ no: c.prefix + '99' }, { no: 'WO991231-999' }] } }), c.prefix + '100');
            assert.deepEqual(h.data(), before); assert.deepEqual(h.localStorage.writes, []); safe(h);
        });
        for (const role of ['admin', 'repairer', 'reporter']) add(title + role + ' report retains +24h defaults and old records', async () => {
            const h = create(sources, c, role), before = h.data();
            const result = await h.ctx.EquipApi.report(CODE, { symptom: 'SYNTHETIC new fault', place: 'SYNTHETIC new place', expectedAt: 'FORGED' });
            assert.equal(result.ok, true); assert.equal(result.no, c.prefix + c.next);
            const after = h.data(), rec = after[CODE].records.at(-1);
            assert.equal(rec.reportAt, c.day); assert.equal(rec.expectedAt, c.due);
            assert.equal(rec.createdAt, c.minute + ':00');
            assert.deepEqual(after[CODE].records.slice(0, -1), before[CODE].records);
            assert.deepEqual(after[OTHER], before[OTHER]); assert.deepEqual(plain(h.ctx.EQ), h.cached);
            assert.equal(h.ctx.localNextNo(after), c.prefix + (c.next + 1)); audit(h, c);
        });
        for (const role of ['admin', 'reporter']) {
            add(title + role + ' supplement appends Beijing minute only; historical fields/cache unchanged', async () => {
                const h = create(sources, c, role), before = h.data(), old = before[CODE].records[0];
                const result = await h.ctx.EquipApi.supplementReport(CODE, 'open', ' SYNTHETIC new supplement ');
                assert.equal(result.ok, true); const rec = h.data()[CODE].records[0];
                assert.deepEqual(rec._supplements.slice(0, -1), old._supplements);
                assert.equal(rec._supplements.at(-1).at, c.minute); assert.equal(rec.updatedAt, c.minute);
                assert.equal(rec._supplements.at(-1).text, 'SYNTHETIC new supplement');
                assert.deepEqual(omit(rec, ['_supplements', 'updatedAt', 'updatedBy']), omit(old, ['_supplements', 'updatedAt', 'updatedBy']));
                assert.deepEqual(plain(h.ctx.EQ), h.cached); preserved(h, before); audit(h, c);
                if (role === 'reporter') {
                    const masked = result.equipment.records.find(r => r.id === 'open');
                    assert.equal(masked.supplements.at(-1).at, c.minute); assert.equal(masked.cost, undefined);
                    assert.equal(masked.createdAt, undefined); assert.equal(masked.supplements.at(-1).account, undefined);
                }
            });
            add(title + role + ' correction appends Beijing minute; forged fields ignored/history retained', async () => {
                const h = create(sources, c, role), before = h.data(), old = before[CODE].records[0];
                const result = await h.ctx.EquipApi.correctReport(CODE, 'open', correction(h));
                assert.equal(result.ok, true); assert.equal(result.moved, false);
                const rec = h.data()[CODE].records[0];
                assert.equal(rec.updatedAt, c.minute); assert.equal(rec._corrections.at(-1).at, c.minute);
                assert.deepEqual(rec._corrections.slice(0, -1), old._corrections);
                assert.deepEqual(omit(rec, ['symptom', 'place', '_corrections', 'updatedAt', 'updatedBy']),
                    omit(old, ['symptom', 'place', '_corrections', 'updatedAt', 'updatedBy']));
                assert.deepEqual(plain(h.ctx.EQ), h.cached); preserved(h, before); audit(h, c);
                if (role === 'reporter') {
                    const masked = result.equipments[CODE].records.find(r => r.id === 'open');
                    assert.equal(masked.corrections.at(-1).at, c.minute); assert.equal(masked.cost, undefined);
                    assert.equal(masked.corrections.at(-1).account, undefined);
                }
            });
        }
        add(title + 'correction move preserves identity/old timestamps and uses Beijing audits on both devices', async () => {
            const h = create(sources, c, 'reporter'), before = h.data(), old = before[CODE].records[0];
            const result = await h.ctx.EquipApi.correctReport(CODE, 'open', correction(h, CODE, 'open', SAME));
            assert.equal(result.ok, true); assert.equal(result.moved, true);
            const after = h.data(), rec = after[SAME].records[0];
            assert.equal(after[CODE].records.some(r => r.id === 'open'), false); assert.equal(rec.id, old.id); assert.equal(rec.no, old.no);
            assert.equal(rec.createdAt, old.createdAt); assert.equal(rec.updatedAt, c.minute);
            assert.deepEqual(rec._supplements, old._supplements); assert.deepEqual(rec._corrections.slice(0, -1), old._corrections);
            assert.deepEqual(after[CODE].records, before[CODE].records.slice(1)); assert.deepEqual(after[OTHER], before[OTHER]);
            assert.deepEqual(plain(h.ctx.EQ), h.cached); audit(h, c, 2);
        });
        for (const role of ['admin', 'repairer']) {
            add(title + role + ' manual new record has Beijing created/updated seconds, old records immutable', async () => {
                const h = create(sources, c, role), before = h.data(); form(h, c);
                h.ctx.currentRecordId = ''; h.ctx.saveRecord(); await flush();
                const after = h.data(), rec = after[CODE].records.at(-1);
                assert.equal(rec.createdAt, c.locale); assert.equal(rec.updatedAt, c.locale);
                assert.equal(rec.createdBy, 'SYNTHETIC ' + role); assert.equal(rec.updatedBy, 'SYNTHETIC ' + role);
                assert.equal(rec.id, 'r' + Date.parse(c.iso)); assert.equal(rec.no, '');
                assert.equal(rec.doneAt, c.day); assert.equal(rec.status, 'done'); assert.equal(rec.action, 'SYNTHETIC new action');
                assert.deepEqual(after[CODE].records.slice(0, -1), before[CODE].records);
                assert.deepEqual(plain(h.ctx.EQ[CODE].records.slice(0, -1)), h.cached[CODE].records);
                assert.deepEqual(after[OTHER], before[OTHER]); assert.deepEqual(h.rendered, [CODE]); audit(h, c);
                if (role === 'repairer') { assert.equal(rec.cost, 0); assert.equal(rec.cause1, ''); assert.equal(rec.supplier, ''); }
                else assert.equal(rec.cost, 99);
            });
            add(title + role + ' manual completion retains old createdAt/history and permission fields', async () => {
                const h = create(sources, c, role), before = h.data(), old = before[CODE].records[0]; form(h, c);
                h.ctx.currentRecordId = 'open'; h.ctx.saveRecord(); await flush();
                const rec = h.data()[CODE].records[0];
                assert.equal(rec.createdAt, old.createdAt); assert.equal(rec.createdBy, old.createdBy); assert.equal(rec.updatedAt, c.locale);
                assert.equal(rec.reportAt, old.reportAt); assert.equal(rec.expectedAt, old.expectedAt);
                assert.deepEqual(rec._supplements, old._supplements); assert.deepEqual(rec._corrections, old._corrections);
                assert.deepEqual(rec.updates, old.updates); assert.deepEqual(rec.custom, old.custom);
                assert.equal(rec.status, 'done'); assert.equal(rec.doneAt, c.day); preserved(h, before); audit(h, c);
                if (role === 'repairer') for (const key of ['cause1', 'cause2', 'cause3', 'cause', 'handleType', 'repairMode', 'supplier', 'cost', 'delayReason']) assert.deepEqual(rec[key], old[key]);
                else assert.equal(rec.cost, 99);
            });
            add(title + role + ' existing reply and setExpected remain Beijing and historical-safe', async () => {
                const h = create(sources, c, role), before = h.data(), old = before[CODE].records[0];
                const reply = await h.ctx.EquipApi.reply(CODE, 'open', ' SYNTHETIC new progress ', '');
                assert.equal(reply.ok, true); assert.equal(reply.update.at, c.minute);
                let rec = h.data()[CODE].records[0]; assert.deepEqual(rec.updates.slice(0, -1), old.updates);
                assert.equal(rec.createdAt, old.createdAt); assert.equal(rec.updatedAt, old.updatedAt);
                const result = await h.ctx.EquipApi.setExpected(CODE, 'open', c.due);
                assert.equal(result.ok, true); rec = h.data()[CODE].records[0];
                assert.equal(rec.expectedAt, c.due); assert.equal(rec.updatedAt, c.minute); assert.equal(rec.createdAt, old.createdAt);
                assert.deepEqual(rec._supplements, old._supplements); assert.deepEqual(rec._corrections, old._corrections);
                preserved(h, before); assert.deepEqual(plain(h.ctx.EQ), h.cached); audit(h, c, 2);
            });
        }
        add(title + 'todo heading/date clock Beijing; legacy selection/count/sample left intact', async () => {
            const h = create(sources, c), before = h.data();
            const preview = h.ctx.buildTodoMsg({ SYNTHETIC: { name: 'SYNTHETIC', records: [
                record('past', { expectedAt: '2026-11-02' }), record('today', { expectedAt: c.day }),
                record('future', { expectedAt: '2026-11-05' }), record('closed', { expectedAt: c.day, status: 'done' }),
                record('minute', { expectedAt: '2026-11-02T12:00' }), record('empty', { expectedAt: '' })] } });
            assert(preview.msg.startsWith('【今日待办】' + c.day.slice(5) + ' 周' + c.weekday + '\n'));
            // Preserve the existing local discrepancy: minute expectedAt is counted but unclassified.
            assert.equal(preview.total, 3); assert.equal(preview.overdue, 1); assert.equal(preview.dueToday, 1);
            assert.equal(preview.sample, false); assert(!preview.msg.includes('SYNTHETIC-future'));
            const sample = h.ctx.buildTodoMsg({}, { test: true });
            assert(sample.msg.startsWith('【测试】【今日待办】' + c.day.slice(5) + ' 周' + c.weekday));
            assert.equal(sample.total, 5); assert.equal(sample.overdue, 2); assert.equal(sample.dueToday, 1); assert.equal(sample.sample, true);
            assert.equal((sample.msg.match(/^\d\. /gm) || []).length, 3, 'Existing three sample rows / total five retained');
            const result = await h.ctx.EquipApi.dailyTodoTest(); assert.equal(result.ok, true); assert.equal(result.local, true);
            assert(result.preview.startsWith('【测试】【今日待办】' + c.day.slice(5) + ' 周' + c.weekday));
            assert.deepEqual(h.data(), before); assert.deepEqual(h.localStorage.writes, []); safe(h);
        });
        add(title + 'role/department/completed/stale boundaries deny without writes', async () => {
            for (const role of ['admin', 'repairer', 'reporter', 'view']) {
                const h = create(sources, c, role), before = h.data();
                if (role === 'repairer' || role === 'view') {
                    assert.equal((await h.ctx.EquipApi.supplementReport(CODE, 'open', 'SYNTHETIC')).ok, false);
                    assert.equal((await h.ctx.EquipApi.correctReport(CODE, 'open', correction(h))).ok, false);
                }
                if (role === 'reporter' || role === 'view') {
                    form(h, c); h.ctx.currentRecordId = 'open'; h.ctx.saveRecord(); await flush();
                    assert.equal((await h.ctx.EquipApi.reply(CODE, 'open', 'SYNTHETIC', '')).ok, false);
                    assert.equal((await h.ctx.EquipApi.setExpected(CODE, 'open', c.due)).ok, false);
                    assert.equal((await h.ctx.EquipApi.dailyTodoTest()).ok, false);
                }
                if (role === 'reporter') {
                    for (const [code, id] of [[OTHER, 'serial3'], [CODE, 'done']]) {
                        assert.equal((await h.ctx.EquipApi.supplementReport(code, id, 'SYNTHETIC')).ok, false);
                        assert.equal((await h.ctx.EquipApi.correctReport(code, id, correction(h, code, id))).ok, false);
                    }
                    assert.equal((await h.ctx.EquipApi.report(OTHER, { symptom: 'SYNTHETIC', place: 'SYNTHETIC' })).ok, false);
                    assert.equal((await h.ctx.EquipApi.correctReport(CODE, 'open', correction(h, CODE, 'open', OTHER))).ok, false);
                }
                if (role === 'view') assert.equal((await h.ctx.EquipApi.report(CODE, { symptom: 'SYNTHETIC', place: 'SYNTHETIC' })).ok, false);
                const stale = correction(h); stale.expected.symptom = 'SYNTHETIC stale';
                assert.equal((await h.ctx.EquipApi.correctReport(CODE, 'open', stale)).ok, false);
                assert.deepEqual(h.data(), before); assert.deepEqual(plain(h.ctx.EQ), h.cached);
                assert.deepEqual(h.localStorage.writes, []); safe(h);
            }
        });
    }
    add('nonzero seconds retained from the same absolute sample; minute-only fields do not gain seconds', async () => {
        const c = { ...CASES[0], iso: '2026-11-03T16:15:37.456Z', locale: '2026/11/4 00:15:37' };
        const h = create(sources, c); form(h, c); h.ctx.saveRecord(); await flush();
        const rec = h.data()[CODE].records.at(-1); assert.equal(rec.createdAt, c.locale); assert.equal(rec.updatedAt, c.locale); audit(h, c);
        const s = create(sources, c); assert.equal((await s.ctx.EquipApi.supplementReport(CODE, 'open', 'SYNTHETIC')).ok, true);
        assert.equal(s.data()[CODE].records[0]._supplements.at(-1).at, c.minute); audit(s, c);
        const r = create(sources, c); await r.ctx.EquipApi.report(CODE, { symptom: 'SYNTHETIC', place: 'SYNTHETIC' });
        assert.equal(r.data()[CODE].records.at(-1).createdAt, c.minute + ':00', 'Already-Beijing report precision must not change'); audit(r, c);
    });
    let passed = 0;
    for (const test of tests) {
        try { await test.fn(); passed++; }
        catch (error) { error.message = '[' + process.env.TZ + '] ' + test.name + ': ' + error.message; throw error; }
    }
    console.log('PASS ' + passed + '/' + tests.length + ' Beijing generation scenarios in TZ=' + process.env.TZ);
}
if (!process.argv.includes('--host')) {
    for (const TZ of ZONES) {
        const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', __filename, '--host'], {
            env: { ...process.env, TZ }, stdio: 'inherit'
        });
        if (child.error) throw child.error;
        assert.equal(child.status, 0, 'Beijing generation regression failed in ' + TZ);
    }
    console.log('PASS Beijing generation: four host timezones; synthetic VM only.');
} else {
    run().catch(error => { console.error(error); process.exitCode = 1; });
}
