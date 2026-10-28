'use strict';
/* Run: node tools/test_report_correction.js
 * Offline contract regression: real SessionStore + EquipApi, isolated localStorage/VM.
 * No login, network, hardware, printing, SQL execution, or persistent fixture writes.
 * SQL assertions below inspect source only; they do NOT validate a deployed DB.
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SESSION = read('docs/js/session.js');
const API = read('docs/equipment/js/equipment-api.js');
const SOURCE = 'PS04-10', TARGET = 'PS04-20', GENERIC = 'GEN-D07', CROSS = 'PS41-17';
const DEPT = '模具部', OTHER_DEPT = '注塑部', ID = 'record-full';
let passed = 0, failed = 0, suites = 0;
const failures = [];
function check(name, value) {
    if (value) passed++;
    else { failed++; failures.push(name); console.error('FAIL ' + name); }
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
        return out;
    }
    return value;
}
function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function omit(value, fields) { const out = copy(value); fields.forEach(k => { delete out[k]; }); return out; }
async function suite(name, fn) {
    suites++;
    try { await fn(); }
    catch (e) { check(name + ': unexpected exception: ' + (e && e.stack || e), false); }
}
function record(id, patch) {
    return Object.assign({
        id, no: 'WO261020-' + id, type: 'fault', status: 'open', reportAt: '2026-10-20',
        reportBy: '另一位报修人', place: '旧位置', symptom: '原故障现象', expectedAt: '2026-11-02',
        doneAt: '', handler: '维修甲', cause1: '一级', cause2: '二级', cause3: '三级',
        cause: '内部诊断', action: '已检查', handleType: 'repair', repairMode: 'outer',
        supplier: 'PRIVATE_SUPPLIER', parts: [{name: 'PRIVATE_PART', qty: 2, price: 463.19, unknown: {keep: true}}],
        cost: 987654.32, delayReason: '延期说明', remark: 'PRIVATE_REMARK',
        photos: [{url: 'offline://photo', unknown: ['opaque', 17]}],
        updates: [{at: '2026-10-21 08:00', by: '维修乙', text: '等待备件', unknown: {keep: 'update'}}],
        createdAt: '2026-10-20 07:59', createdBy: '其他账号', updatedAt: '2026-10-21 08:00', updatedBy: '维修乙',
        unknownProps: {nested: [null, false, 0, '', {keep: 'opaque'}]},
        _asset: {tag: 'record-asset', unknown: ['unchanged']},
        _corrections: [{at: '2026-10-20 08:00', reason: '既往更正', opaque: {keep: true}}]
    }, patch || {});
}
function equipment(code, line, records) {
    return {code, name: code === GENERIC ? '通用报修' : '磨床 ' + code, number: code, line,
        category: 'prod', family: '磨床', status: 'active', owner: '设备责任人', model: 'M-1',
        vendor: '原厂', installDate: '2024-01-01', remark: '设备备注', photos: ['offline://equipment'],
        _asset: {original: {cost: 123456.78, purchased: '2024-01-01'}, unknown: [0, false]},
        unknownEquipment: {nested: ['keep', {opaque: true}]}, _recordsRev: 'fixture-' + code, records};
}
function fixture() {
    return {
        [SOURCE]: equipment(SOURCE, DEPT, [record('before'), record(ID),
            record('done', {status: 'done', doneAt: '2026-10-22'}),
            record('oldemptyplace', {place: '', symptom: '历史空位置'}), record('after')]),
        [TARGET]: equipment(TARGET, DEPT, [record('target-first'), record('target-last')]),
        [GENERIC]: equipment(GENERIC, DEPT, [record('generic-existing')]),
        [CROSS]: equipment(CROSS, OTHER_DEPT, [record('cross-record')])
    };
}
const ROLE_TOOLS = {admin: ['equipment-admin'], repairer: ['equipment'], reporter: ['equipment-report'], view: []};
function context(role = 'admin', options = {}) {
    const all = copy(options.all || fixture());
    const store = {
        equip_list_v2: JSON.stringify(all), equip_seed_v2: '1',
        equip_audit_v2: JSON.stringify([{code: CROSS, action: 'fixture', summary: '保留已有审计'}]),
        equip_trash_v1: JSON.stringify([{id: 'trash-keep', kind: 'record', snapshot: {opaque: true}, purge_at: '2099-01-01'}]),
        unrelated: JSON.stringify({keep: ['unchanged']})
    };
    if (role !== 'none') store.roi_session = JSON.stringify(Object.assign({
        token: 'offline-only-token', account: 'test-' + role, name: '测试' + role, level: 2,
        tools: ROLE_TOOLS[role] || [], dept: DEPT
    }, options.session || {}));
    const calls = {rpc: [], forbidden: [], writes: [], numbers: 0};
    const deny = name => function () { calls.forbidden.push(name); throw Error('FORBIDDEN: ' + name); };
    const storage = {
        getItem: k => Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null,
        setItem: (k, v) => { calls.writes.push(k); store[k] = String(v); },
        removeItem: k => { calls.writes.push(k); delete store[k]; }
    };
    const ctx = {
        console: {log() {}, warn() {}, error() {}}, localStorage: storage, sessionStorage: storage,
        location: {search: '', href: '', pathname: '/equipment/'},
        navigator: {sendBeacon: deny('sendBeacon'), bluetooth: {requestDevice: deny('bluetooth')},
            usb: {requestDevice: deny('usb')}, serial: {requestPort: deny('serial')}},
        fetch: deny('fetch'), XMLHttpRequest: deny('XMLHttpRequest'), WebSocket: deny('WebSocket'),
        EventSource: deny('EventSource'), print: deny('print'), open: deny('window.open'),
        setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        addEventListener() {}, document: {addEventListener() {}, querySelectorAll: () => [], getElementById: () => null}
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(SESSION, ctx, {filename: 'docs/js/session.js'});
    vm.runInContext(API, ctx, {filename: 'docs/equipment/js/equipment-api.js'});
    ctx.EqConfig.cloud = !!options.cloud;
    ctx.eqRpc = (name, args) => {
        calls.rpc.push({name, args: copy(args)});
        return Promise.resolve(copy(options.rpcResult || {ok: true, code: TARGET, source_code: SOURCE,
            no: all[SOURCE].records[1].no, moved: true, equipments: {[SOURCE]: all[SOURCE], [TARGET]: all[TARGET]}}));
    };
    const nextNo = ctx.localNextNo;
    ctx.localNextNo = function () { calls.numbers++; return nextNo.apply(this, arguments); };
    return {ctx, store, calls, data: () => JSON.parse(store.equip_list_v2), audit: () => JSON.parse(store.equip_audit_v2)};
}
function payload(t, code = SOURCE, id = ID, targetCode = TARGET) {
    const rec = t.data()[code].records.find(r => r.id === id);
    return {targetCode, symptom: '  更正后现象　', place: '　新位置 \t', reason: '  设备扫码选择错误　',
        expected: {symptom: rec.symptom, place: rec.place}};
}
function correct(t, code = SOURCE, id = ID, p = payload(t, code, id)) {
    if (typeof t.ctx.EquipApi.correctReport !== 'function') throw Error('EquipApi.correctReport is not implemented');
    return t.ctx.EquipApi.correctReport(code, id, p);
}
function changedRecord(before, after) {
    return same(omit(before, ['symptom', 'place', 'updatedAt', 'updatedBy', '_corrections']),
        omit(after, ['symptom', 'place', 'updatedAt', 'updatedBy', '_corrections']));
}
function revChanged(before, after) { return after != null && after !== '' && !same(before, after); }
function safeResponse(value) {
    if (Array.isArray(value)) return value.every(safeResponse);
    if (!value || typeof value !== 'object') return true;
    const privateFields = ['cost', 'parts', 'supplier', 'cause', 'cause1', 'cause2', 'cause3', 'action',
        'repairMode', 'handleType', 'delayReason', 'remark', 'photos', '_asset', 'unknownProps', 'unknownEquipment', '_corrections'];
    return Object.keys(value).every(k => !privateFields.includes(k) && safeResponse(value[k]));
}
async function rejectCase(name, options = {}) {
    await suite('reject ' + name, async () => {
        const t = context(options.role || 'admin', options);
        if (options.mutate) { const all = t.data(); options.mutate(all); t.store.equip_list_v2 = JSON.stringify(all); }
        const code = options.code || SOURCE, id = options.id || ID;
        const p = payload(t);
        if (options.patch) Object.assign(p, options.patch);
        if (options.removeExpected) delete p.expected;
        const before = copy(t.store), beforePayload = copy(p);
        const result = await correct(t, code, id, p);
        check(name + ': returns rejection', result && result.ok === false);
        check(name + ': all storage/audit/trash/session unchanged', same(t.store, before));
        check(name + ': rejection performs zero storage writes', t.calls.writes.length === 0);
        check(name + ': no order number, RPC, hardware or network', t.calls.numbers === 0 && !t.calls.rpc.length && !t.calls.forbidden.length);
        check(name + ': input payload unchanged', same(p, beforePayload));
    });
}
async function successCase(name, role, code, id, targetCode, options = {}) {
    await suite(name, async () => {
        const t = context(role, options), before = t.data(), beforeStore = copy(t.store);
        const original = before[code].records.find(r => r.id === id), p = payload(t, code, id, targetCode), originalPayload = copy(p);
        const result = await correct(t, code, id, p), after = t.data();
        const target = after[targetCode], found = target.records.filter(r => r.id === id), moved = code !== targetCode;
        check(name + ': accepted', result && result.ok === true);
        check(name + ': exact routing/no/moved contract', result && result.code === targetCode && result.source_code === code && result.no === original.no && result.moved === moved);
        check(name + ': complete source/target response mapped by actual code', result && result.equipments && result.equipments[code] && result.equipments[targetCode]);
        check(name + ': exactly one destination record', found.length === 1);
        const current = found[0] || {};
        check(name + ': trimmed symptom/location', current.symptom === '更正后现象' && current.place === '新位置');
        check(name + ': stable id/no and full opaque record preservation', current.id === original.id && current.no === original.no && changedRecord(original, current));
        check(name + ': source removes exactly one or keeps same count', after[code].records.length === before[code].records.length - (moved ? 1 : 0));
        check(name + ': target inserts exactly one or keeps same count', target.records.length === before[targetCode].records.length + (moved ? 1 : 0));
        check(name + ': no source duplicate after move', !moved || !after[code].records.some(r => r.id === id));
        const expectedSource = before[code].records.filter(r => !moved || r.id !== id);
        const actualSource = after[code].records.filter(r => moved || r.id !== id);
        check(name + ': all other source records unchanged/in order', same(actualSource, moved ? expectedSource : before[code].records.filter(r => r.id !== id)));
        check(name + ': all other destination records unchanged/in order', !moved || same(target.records.filter(r => r.id !== id), before[targetCode].records));
        check(name + ': same-device correction does not reorder', moved || same(after[code].records.map(r => r.id), before[code].records.map(r => r.id)));
        check(name + ': source equipment metadata intact', same(omit(after[code], ['records', '_recordsRev']), omit(before[code], ['records', '_recordsRev'])));
        check(name + ': target equipment metadata intact', same(omit(target, ['records', '_recordsRev']), omit(before[targetCode], ['records', '_recordsRev'])));
        check(name + ': unrelated equipment unchanged', Object.keys(before).filter(c => c !== code && c !== targetCode).every(c => same(before[c], after[c])));
        const allRecords = all => Object.values(all).flatMap(e => e.records).map(r => [r.id, r.no]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        check(name + ': global id/no multiset unchanged', same(allRecords(before), allRecords(after)));
        check(name + ': never allocates an order number or calls RPC/hardware/network', !t.calls.numbers && !t.calls.rpc.length && !t.calls.forbidden.length);
        check(name + ': trash and unrelated/session storage untouched', same(omit(t.store, ['equip_list_v2', 'equip_audit_v2']), omit(beforeStore, ['equip_list_v2', 'equip_audit_v2'])));
        const history = current._corrections || [];
        check(name + ': correction history appended without losing previous entries', history.length === original._corrections.length + 1 && same(history.slice(0, -1), original._corrections));
        const last = history[history.length - 1] || {}, serialized = JSON.stringify(last);
        check(name + ': history captures reason, old/new values and source/target', ['设备扫码选择错误', original.symptom, '更正后现象', original.place, '新位置', code, targetCode].every(s => serialized.includes(s)));
        check(name + ': history contains actor and timestamp', Object.values(last).some(v => typeof v === 'string' && /test-|测试/.test(v)) && /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(serialized));
        const logs = t.audit(), oldLogs = JSON.parse(beforeStore.equip_audit_v2);
        const added = logs.slice(0, logs.length - oldLogs.length);
        check(name + ': existing audit preserved', same(logs.slice(added.length), oldLogs));
        check(name + ': source and destination audited', added.some(a => a.code === code) && added.some(a => a.code === targetCode));
        check(name + ': audit identifies correction and record/reason', added.every(a => /correct|更正/.test(JSON.stringify(a))) && added.some(a => JSON.stringify(a).includes(original.no)) && added.some(a => JSON.stringify(a).includes('设备扫码选择错误')));
        check(name + ': source records revision refreshed', revChanged(before[code]._recordsRev, after[code]._recordsRev));
        check(name + ': target records revision refreshed', revChanged(before[targetCode]._recordsRev, target._recordsRev));
        check(name + ': correction payload not mutated', same(p, originalPayload));
        if (role === 'reporter') {
            check(name + ': reporter response recursively excludes private/cost fields', safeResponse(result));
            check(name + ': reporter response excludes private money/supplier/parts values', !/987654\.32|123456\.78|PRIVATE_/.test(JSON.stringify(result)));
            check(name + ': reporter still receives corrected public record', result.equipments && result.equipments[targetCode] && result.equipments[targetCode].records.some(r => r.id === id && r.symptom === '更正后现象' && r.place === '新位置'));
            check(name + ': storage retains private cost/parts', current.cost === original.cost && same(current.parts, original.parts));
        } else {
            check(name + ': admin response retains full stored source/target', result.equipments && same(result.equipments[code], after[code]) && same(result.equipments[targetCode], target));
        }
    });
}
function sqlFunction(source, name) {
    const match = source.match(new RegExp('create or replace function public\\.' + name + '\\([\\s\\S]*?\\nend \\$\\$;', 'i'));
    return match ? match[0].replace(/\r\n/g, '\n') : '';
}
async function main() {
    await suite('real session and API entry', async () => {
        for (const role of ['admin', 'repairer', 'reporter', 'view', 'none']) {
            const t = context(role);
            check('SessionStore/EquipApi derive real ' + role + ' role', t.ctx.EquipApi.role() === role);
            check('VM starts offline without demo session ' + role, t.ctx.EqConfig.cloud === false && t.ctx._demoSession === null);
        }
        check('correctReport entry exists', typeof context().ctx.EquipApi.correctReport === 'function');
    });
    await successCase('admin moves full record', 'admin', SOURCE, ID, TARGET);
    await successCase('admin corrects done record', 'admin', SOURCE, 'done', TARGET);
    await successCase('admin corrects across departments', 'admin', CROSS, 'cross-record', TARGET);
    await successCase('builtin admin fallback', 'admin', SOURCE, ID, TARGET, {session: {account: 'admin', tools: []}});
    await successCase('same-device stable order', 'admin', SOURCE, ID, SOURCE);
    await successCase('reporter corrects another author in own workshop', 'reporter', SOURCE, ID, TARGET);
    await successCase('reporter moves to GEN', 'reporter', SOURCE, ID, GENERIC);
    await successCase('reporter moves from GEN', 'reporter', GENERIC, 'generic-existing', TARGET);
    await successCase('historical empty location corrected', 'reporter', SOURCE, 'oldemptyplace', SOURCE);
    const withoutRev = fixture(); Object.values(withoutRev).forEach(e => { delete e._recordsRev; });
    await successCase('legacy records acquire revisions', 'admin', SOURCE, ID, TARGET, {all: withoutRev});
    for (const role of ['repairer', 'view', 'none']) await rejectCase(role + ' forbidden', {role});
    await rejectCase('guest admin forbidden', {session: {account: 'admin', guest: true}});
    await rejectCase('reporter done forbidden', {role: 'reporter', id: 'done', patch: {expected: {symptom: '原故障现象', place: '旧位置'}}});
    await rejectCase('reporter legacy doneAt forbidden', {role: 'reporter', mutate: all => { const r = all[SOURCE].records.find(r => r.id === ID); delete r.status; r.doneAt = '2026-10-22'; }});
    await rejectCase('reporter open status with doneAt forbidden', {role: 'reporter', mutate: all => { all[SOURCE].records[1].doneAt = '2026-10-22'; }});
    await rejectCase('reporter cross-department source forbidden', {role: 'reporter', code: CROSS, id: 'cross-record'});
    await rejectCase('reporter cross-department target forbidden', {role: 'reporter', patch: {targetCode: CROSS}});
    await rejectCase('reporter missing workshop forbidden', {role: 'reporter', session: {dept: ''}});
    await rejectCase('source missing', {code: 'MISSING'});
    await rejectCase('record missing', {id: 'MISSING'});
    await rejectCase('target missing', {patch: {targetCode: 'MISSING'}});
    await rejectCase('target duplicate id', {mutate: all => { all[TARGET].records.push(record(ID, {no: 'OTHER-NUMBER'})); }});
    await rejectCase('target duplicate no', {mutate: all => { all[TARGET].records.push(record('OTHER-ID', {no: all[SOURCE].records[1].no})); }});
    await rejectCase('expected omitted', {removeExpected: true});
    for (const value of [null, [], 'bad', {}, {symptom: '原故障现象'}, {place: '旧位置'}, {symptom: null, place: '旧位置'}, {symptom: '原故障现象', place: 7}]) {
        await rejectCase('invalid expected ' + JSON.stringify(value), {patch: {expected: value}});
    }
    await rejectCase('invalid expected null cannot match historical empty place', {id: 'oldemptyplace', patch: {expected: {symptom: '历史空位置', place: null}}});
    await rejectCase('invalid expected number cannot match stored numeric text', {mutate: all => { all[SOURCE].records[1].place = '7'; }, patch: {expected: {symptom: '原故障现象', place: 7}}});
    await rejectCase('stale expected symptom', {patch: {expected: {symptom: '别人已改现象', place: '旧位置'}}});
    await rejectCase('stale expected place', {patch: {expected: {symptom: '原故障现象', place: '别人已改位置'}}});
    for (const field of ['symptom', 'place']) for (const value of [undefined, null, '', ' \t\r\n　\u00a0\ufeff ']) {
        await rejectCase('blank ' + field + ' ' + String(value), {patch: {[field]: value}});
    }
    await suite('cloud RPC wire contract without network', async () => {
        const t = context('reporter', {cloud: true}), p = payload(t), before = copy(t.store);
        const result = await correct(t, SOURCE, ID, p), call = t.calls.rpc[0];
        check('cloud invokes exactly equipment_report_correct once', t.calls.rpc.length === 1 && call.name === 'equipment_report_correct');
        check('cloud transmits exactly the agreed RPC arguments', call && same(call.args, {
            p_token: 'offline-only-token', p_code: SOURCE, p_record_id: ID, p_target_code: TARGET,
            p_symptom: p.symptom, p_place: p.place, p_reason: p.reason, p_expected: p.expected
        }));
        check('cloud returns the success routing contract', result && result.ok && result.code === TARGET && result.source_code === SOURCE && result.moved === true);
        check('cloud mock leaves storage and all I/O untouched', same(t.store, before) && !t.calls.forbidden.length && !t.calls.writes.length);
    });
    await suite('correction invalidates old source/target snapshots before trash/audit', async () => {
        const t = context(), old = t.data();
        await correct(t);
        const corrected = t.data();
        for (const code of [SOURCE, TARGET]) {
            const stale = copy(old[code]);
            // A stale target loses the moved record; a stale source resurrects it.
            const before = copy(t.store), writes = t.calls.writes.length;
            const result = await t.ctx.EquipApi.save(code, stale, 'stale overwrite attempt');
            check('stale save rejected ' + code, result && result.ok === false);
            check('stale save zero mutation/audit/trash ' + code, same(t.store, before) && t.calls.writes.length === writes);
            check('stale save keeps input snapshot unchanged ' + code, same(stale, old[code]));
        }
        check('both corrected equipments still intact after stale attempts', same(t.data(), corrected));
        const fresh = (await t.ctx.EquipApi.getDevice(TARGET)).equipment;
        const oldRev = fresh._recordsRev;
        fresh.records[0].action = 'fresh normal edit';
        const result = await t.ctx.EquipApi.save(TARGET, fresh, 'fresh snapshot');
        const saved = t.data()[TARGET];
        check('fresh snapshot save succeeds', result && result.ok === true);
        check('fresh save revision refreshed and returned', result && revChanged(oldRev, result.recordsRev) && same(result.recordsRev, saved._recordsRev));
        check('fresh save synchronizes input revision', same(fresh._recordsRev, saved._recordsRev) && same(fresh._recordsRev, result.recordsRev));
        check('fresh save retains moved record and applies normal edit', saved.records.some(r => r.id === ID) && saved.records[0].action === 'fresh normal edit');
        const secondRev = fresh._recordsRev;
        const second = await t.ctx.EquipApi.save(TARGET, fresh, 'same synchronized input reused');
        check('same input can be saved again with another fresh returned revision', second && second.ok && revChanged(secondRev, second.recordsRev) && same(fresh._recordsRev, second.recordsRev));
    });
    for (const operation of ['report', 'reply']) await suite(operation + ' refreshes existing records revision', async () => {
        const t = context(), old = (await t.ctx.EquipApi.getDevice(SOURCE)).equipment, originalRev = old._recordsRev;
        const result = operation === 'report' ? await t.ctx.EquipApi.report(SOURCE, {symptom: '新增故障', place: '新增位置'}) :
            await t.ctx.EquipApi.reply(SOURCE, ID, '新维修进度', '2026-11-03');
        const after = t.data()[SOURCE];
        check(operation + ': succeeds and refreshes existing revision', result && result.ok && revChanged(originalRev, after._recordsRev));
        check(operation + ': operation actually updates records', operation === 'report' ? after.records.length === old.records.length + 1 : after.records.find(r => r.id === ID).updates.length === old.records.find(r => r.id === ID).updates.length + 1);
        const before = copy(t.store), writes = t.calls.writes.length;
        const stale = await t.ctx.EquipApi.save(SOURCE, old, 'stale after ' + operation);
        check(operation + ': old snapshot rejected', stale && stale.ok === false);
        check(operation + ': stale rejection adds no writes, trash or audit', same(t.store, before) && writes === t.calls.writes.length);
    });
    await suite('cloud save returned recordsRev synchronizes caller input', async () => {
        const t = context('admin', {cloud: true, rpcResult: {ok: true, recordsRev: 'server-new-revision'}});
        const input = t.data()[SOURCE], result = await t.ctx.EquipApi.save(SOURCE, input, 'cloud save');
        check('cloud save returns server recordsRev', result && result.ok && result.recordsRev === 'server-new-revision');
        check('cloud save synchronizes input _recordsRev', input._recordsRev === 'server-new-revision');
        check('cloud save stays on mocked RPC only', t.calls.rpc.length === 1 && t.calls.rpc[0].name === 'equipment_save' && !t.calls.forbidden.length);
    });
    await suite('SQL source contracts only (NOT executed against a DB)', async () => {
        const schema = read('supabase/schema.sql'), raw = sqlFunction(schema, 'equipment_report_correct');
        const sql = raw.replace(/--[^\n]*/g, '');
        check('SQL static: correction function exists with all eight parameters', !!raw && ['p_token text', 'p_code text', 'p_record_id text', 'p_target_code text', 'p_symptom text', 'p_place text', 'p_reason text', 'p_expected jsonb'].every(s => raw.includes(s)));
        check('SQL static: authenticated SECURITY DEFINER role resolution', /security definer/i.test(sql) && sql.includes('_get_user_by_token(p_token)') && sql.includes('_equip_role(p_token)'));
        check('SQL static: correction only allows admin/reporter', /role\s+not\s+in\s*\(\s*'admin'\s*,\s*'reporter'\s*\)/i.test(sql));
        const lockStatements = sql.match(/\b(?:select|perform)\b[^;]*\bfor\s+update\b/gi) || [];
        check('SQL static: source and destination are locked together in deterministic order', lockStatements.some(s => /public\.equipments/i.test(s) && /\bp_code\b/.test(s) && /\bp_target_code\b/.test(s) && /\border\s+by\s+(?:\w+\.)?code\b/i.test(s) && /\b(?:in\s*\(|any\s*\()/i.test(s)));
        const write = sql.search(/\b(?:update\s+public\.equipments|insert\s+into\s+public\.(?:equipments|equip_audit))\b/i);
        const expectedGuard = sql.indexOf('p_expected', sql.indexOf('begin'));
        check('SQL static: authentication, role and expected guards precede first mutation', write > 0 && sql.indexOf('_get_user_by_token') < write && sql.indexOf('role not in') < write && expectedGuard > 0 && expectedGuard < write && /jsonb_typeof\s*\(\s*p_expected\s*\)/.test(sql));
        check('SQL static: workshop and closed checks precede first mutation', write > 0 && sql.slice(0, write).includes('dept') && sql.slice(0, write).includes('done'));
        check('SQL static: full JSON records/history/revisions retained in one function', sql.includes('jsonb_set') && sql.includes('jsonb_array_elements') && sql.includes('_corrections') && sql.includes('_recordsRev'));
        check('SQL static: no new order number, trash, internal commit or swallowed exception', !!sql && !/_equip_next_no|_trash_push|\bcommit\b|exception\s+when\s+others/i.test(sql));
        check('SQL static: reporter response uses server mask', sql.includes('_mask_equip_report'));
        check('SQL static: success includes agreed routing and code-keyed equipment map', ['source_code', 'code', 'no', 'moved', 'equipments'].every(k => sql.includes("'" + k + "'")) && /jsonb_build_object\s*\(\s*p_code\s*,/.test(sql) && /jsonb_build_object\s*\(\s*p_target_code\s*,/.test(sql));
        const save = sqlFunction(schema, 'equipment_save').replace(/--[^\n]*/g, '');
        const saveGuard = save.indexOf('_recordsRev'), trash = save.indexOf('_trash_push');
        check('SQL static: save revision guard precedes trash and audit/storage writes', saveGuard > 0 && trash > saveGuard && save.search(/\binsert\s+into\s+public\.equipments/i) > saveGuard && save.includes("'recordsRev'"));
        for (const name of ['equipment_report', 'equipment_reply']) {
            const body = sqlFunction(schema, name);
            check('SQL static: ' + name + ' refreshes existing records revision', body.includes('_recordsRev') && /for\s+update/i.test(body));
        }
        const deltaPath = path.join(ROOT, 'supabase', 'delta_report_correction.sql');
        if (fs.existsSync(deltaPath)) {
            const delta = fs.readFileSync(deltaPath, 'utf8');
            check('SQL static: optional migration matches canonical correction RPC', !!raw && sqlFunction(delta, 'equipment_report_correct') === raw);
            check('SQL static: optional migration is transactional', /(?:^|\n)begin;/i.test(delta) && /commit;\s*$/i.test(delta));
        }
    });
    console.log('Report correction: ' + passed + ' passed / ' + failed + ' failed / ' + (passed + failed) + ' assertions in ' + suites + ' suites.');
    console.log('Offline VM + static SQL source checks only; no network, account login, hardware, printing, or live database verification.');
    process.exitCode = failed ? 1 : 0;
}
main().catch(e => { console.error(e && e.stack || e); console.log('Report correction aborted: ' + passed + ' passed / ' + failed + ' failed.'); process.exitCode = 1; });
