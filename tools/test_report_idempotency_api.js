/* Offline report-idempotency regression. Real time/session/API/intent sources only.
 * node --unhandled-rejections=strict tools/test_report_idempotency_api.js
 * No APP, HTML, real user JSON, network, production services, hardware or login.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const FILES = ['docs/equipment/js/equipment-time.js', 'docs/js/session.js',
    'docs/equipment/js/equipment-report-intent.js', 'docs/equipment/js/equipment-api.js'];
const SOURCES = FILES.map(file => ({ file, text: fs.readFileSync(path.join(ROOT, file), 'utf8') }));
const JOURNAL = 'equip_report_journal_v1', LIST = 'equip_list_v2', AUDIT = 'equip_audit_v2';
const ACCOUNT = 'SYNTHETIC-reporter', CODE = 'SYNTHETIC-EQ', OTHER = 'SYNTHETIC-OTHER', GEN = 'GEN-D07';
const DEPT = '模具部', PAYLOAD = Object.freeze({ symptom: 'SYNTHETIC fault', place: 'SYNTHETIC place', reportBy: 'SYNTHETIC reporter' });
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const plain = value => JSON.parse(JSON.stringify(value));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const INITIAL = freeze({
    [CODE]: { code: CODE, name: 'SYNTHETIC equipment', line: DEPT, _recordsRev: 'SYNTHETIC-rev',
        photos: ['SYNTHETIC-photo'], cost: 12, records: [{ id: 'SYNTHETIC-old', no: 'WO261104-07', type: 'fault', status: 'done',
            symptom: 'SYNTHETIC historical', place: '', expectedAt: '2001-02-03', reportAt: '2001-02-02', doneAt: '2001-02-03',
            cost: 123, supplier: 'SYNTHETIC private supplier', parts: [{ name: 'SYNTHETIC part', qty: 2 }], custom: { unchanged: true } }] },
    [OTHER]: { code: OTHER, name: 'SYNTHETIC other', line: '注塑部', records: [], custom: { unchanged: true } },
    [GEN]: { code: GEN, name: 'SYNTHETIC generic', line: DEPT, records: [] }
});
const INITIAL_AUDIT = freeze([{ at: '2001/2/3 04:05:06', action: 'SYNTHETIC historical', custom: { unchanged: true } }]);
function storage(initial = {}, fault = () => false) {
    const data = new Map(Object.entries(initial)), writes = [], reads = [];
    const api = Object.freeze({
        get length() { if (fault('length')) throw Error('SYNTHETIC storage unavailable'); return data.size; },
        key(i) { if (fault('key', i)) throw Error('SYNTHETIC storage unavailable'); return Array.from(data.keys())[i] ?? null; },
        getItem(key) { key = String(key); reads.push(key); if (fault('get', key)) throw Error('SYNTHETIC storage unavailable'); return data.has(key) ? data.get(key) : null; },
        setItem(key, value) { key = String(key); if (fault('set', key)) throw Error('SYNTHETIC storage unavailable'); data.set(key, String(value)); writes.push(key); },
        removeItem(key) { key = String(key); if (fault('remove', key)) throw Error('SYNTHETIC storage unavailable'); data.delete(key); writes.push(key); }
    });
    return { api, data, writes, reads, snapshot: () => Object.fromEntries(data) };
}
function locks() {
    const tails = new Map();
    return Object.freeze({ request(name, callback) {
        const result = (tails.get(name) || Promise.resolve()).then(callback);
        tails.set(name, result.catch(() => {}));
        return result;
    } });
}
function harness(options = {}) {
    const now = Date.parse(options.now || '2026-11-03T16:15:00.000Z');
    class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
    const ls = options.ls || storage({ [LIST]: JSON.stringify(INITIAL), [AUDIT]: JSON.stringify(INITIAL_AUDIT), equip_seed_v2: 'SYNTHETIC-seeded', unrelated: 'SYNTHETIC untouched' });
    const ss = options.ss || storage(), calls = [], external = [];
    const forbidden = name => () => { external.push(name); throw Error('Forbidden external operation: ' + name); };
    let seq = options.sequence || 1000;
    const crypto = options.crypto === null ? undefined : options.crypto || Object.freeze({ randomUUID: () => uuid(++seq) });
    const fakeMath = Object.create(Math); fakeMath.random = forbidden('Math.random');
    const ctx = vm.createContext({ console, Date: FixedDate, localStorage: ls.api, sessionStorage: ss.api, crypto, Math: fakeMath,
        location: { search: '', pathname: '/SYNTHETIC/equipment/', href: 'about:blank' },
        navigator: { locks: options.noLocks ? undefined : options.locks || locks(), sendBeacon: forbidden('sendBeacon') },
        fetch: forbidden('fetch'), XMLHttpRequest: forbidden('XMLHttpRequest'), WebSocket: forbidden('WebSocket'),
        Image: forbidden('Image'), print: forbidden('print'), open: forbidden('window.open'), Notification: forbidden('Notification'),
        supabase: { createClient() { return { rpc(name, params) {
            calls.push({ name, params: plain(params) });
            return options.rpc ? options.rpc(name, params) : Promise.resolve({ data: { ok: true, code: params.p_code,
                recordId: 'SYNTHETIC-cloud-record', no: 'SYNTHETIC-cloud-no', expectedAt: '2026-11-05T00:15', replayed: false }, error: null });
        } }; } } });
    ctx.window = ctx;
    for (const { file, text } of SOURCES) vm.runInContext(text, ctx, { filename: file });
    ctx.EqConfig.cloud = !!options.cloud;
    const role = options.role || 'reporter', account = options.account || ACCOUNT;
    const tools = role === 'admin' ? ['equipment-admin'] : role === 'repairer' ? ['equipment'] : role === 'reporter' ? ['equipment-report'] : [];
    if (options.session !== false) ctx.SessionStore.write(JSON.stringify({ account, name: 'SYNTHETIC name',
        token: 'SYNTHETIC token', tools, dept: options.dept === undefined ? DEPT : options.dept, guest: role === 'guest' }));
    ls.writes.length = 0; ss.writes.length = 0;
    const h = { ctx, ls, ss, calls, external, intent: ctx.EquipReportIntent, report: (...args) => ctx.EquipApi.report(...args),
        data: () => plain(ctx.localGet()), audit: () => plain(ctx.localAudit()), journal: () => JSON.parse(ls.data.get(JOURNAL)) };
    return h;
}
function safe(h) {
    assert.deepEqual(h.external, []);
    assert.equal(h.ls.data.get('unrelated'), 'SYNTHETIC untouched');
    assert.deepEqual(INITIAL[CODE].records[0].custom, { unchanged: true });
    assert.equal(h.ctx.eqToken(), 'SYNTHETIC token');
}
function errorCode(fn, code) { assert.throws(fn, e => e && e.code === code); }
const tests = [], add = (name, fn) => tests.push({ name, fn });

add('load has no storage mutation, RPC or eager intent dependency', () => {
    const h = harness(); assert.deepEqual(h.ls.writes, []); assert.deepEqual(h.ss.writes, []);
    assert.equal(h.ls.data.has(JOURNAL), false); assert.deepEqual(h.data(), INITIAL); safe(h);
    const ctx = vm.createContext({ location: { search: '' }, window: {} });
    vm.runInContext(SOURCES.find(s => s.file.endsWith('equipment-api.js')).text, ctx);
    assert.equal(typeof ctx.EquipApi.report, 'function');
});
add('browser UMD and CommonJS exports; UUID syntax and crypto v4', () => {
    const h = harness(), intent = h.intent.create(ACCOUNT, CODE, PAYLOAD);
    assert.match(intent.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(h.intent.validateId(intent.requestId.toUpperCase()), true);
    for (const invalid of [undefined, null, {}, '', 'bad', intent.requestId + ' ', '00000000000040008000000000000001']) assert.equal(h.intent.validateId(invalid), false);
    const cjs = vm.createContext({ module: { exports: {} } });
    vm.runInContext(SOURCES.find(s => s.file.endsWith('equipment-report-intent.js')).text, cjs);
    assert.equal(typeof cjs.module.exports.create, 'function'); assert.equal(cjs.EquipReportIntent, undefined); safe(h);
});
add('getRandomValues v4 fallback never uses Math.random', () => {
    const h = harness({ crypto: { getRandomValues(bytes) { bytes.fill(255); return bytes; } } });
    assert.equal(h.intent.create(ACCOUNT, CODE, PAYLOAD).requestId, 'ffffffff-ffff-4fff-bfff-ffffffffffff'); safe(h);
});
add('missing secure crypto blocks creation before storing an intent', () => {
    const h = harness({ crypto: null }); errorCode(() => h.intent.create(ACCOUNT, CODE, PAYLOAD), 'CRYPTO_UNAVAILABLE');
    assert.deepEqual(h.ls.writes, []); assert.deepEqual(h.calls, []); safe(h);
});
add('intent whitelist, normalization, immutable payload and independent keys', () => {
    const h = harness(), item = h.intent.create(ACCOUNT, CODE, { symptom: ' SYNTHETIC fault ', place: '　SYNTHETIC place\t', reportBy: ' SYNTHETIC reporter ', token: 'NEVER STORE', cost: 999, expectedAt: 'FORGED' });
    assert.deepEqual(plain(item.payload), PAYLOAD); assert.deepEqual(Object.keys(item), ['requestId', 'account', 'code', 'payload', 'createdAt', 'state']);
    assert.equal(item.state, 'pending'); assert.equal(item.createdAt, '2026-11-03T16:15:00.000Z');
    const raw = h.ls.data.get('equip_report_intent_v1:' + ACCOUNT + ':' + item.requestId);
    assert.equal(raw.includes('NEVER STORE'), false); assert.equal(raw.includes('token'), false);
    item.payload.symptom = 'MUTATED'; assert.equal(h.intent.get(ACCOUNT, item.requestId).payload.symptom, PAYLOAD.symptom);
    h.intent.mark(ACCOUNT, item.requestId, 'uncertain', { payload: { symptom: 'OVERRIDE' } });
    assert.deepEqual(plain(h.intent.get(ACCOUNT, item.requestId).payload), PAYLOAD); safe(h);
});
add('two accounts and two tabs keep multiple GEN intentions without whole-map clobber', () => {
    const h = harness(), tab = harness({ ls: h.ls, locks: h.ctx.navigator.locks, sequence: 2000 });
    const a = h.intent.create(ACCOUNT, GEN, PAYLOAD), b = tab.intent.create(ACCOUNT, GEN, { ...PAYLOAD, symptom: 'SYNTHETIC second' });
    const other = tab.intent.create('SYNTHETIC-other-account', GEN, PAYLOAD);
    assert.notEqual(a.requestId, b.requestId); assert.equal(h.intent.list(ACCOUNT, GEN).length, 2);
    assert.equal(h.intent.list('SYNTHETIC-other-account').length, 1);
    assert.equal(h.intent.get(ACCOUNT, other.requestId), null);
    assert.equal(h.intent.get('SYNTHETIC-other-account', a.requestId), null); safe(h);
});
add('sessionStorage fallback recovers after refresh and alongside localStorage intentions', () => {
    let denied = true;
    const ls = storage({ [LIST]: JSON.stringify(INITIAL), unrelated: 'SYNTHETIC untouched' }, op => denied && op === 'set');
    const h = harness({ ls }), a = h.intent.create(ACCOUNT, CODE, PAYLOAD);
    assert.equal(h.ss.data.has('equip_report_intent_v1:' + ACCOUNT + ':' + a.requestId), true);
    denied = false;
    const reload = harness({ ls, ss: h.ss, sequence: 2000 });
    const b = reload.intent.create(ACCOUNT, GEN, PAYLOAD);
    assert.equal(reload.intent.list(ACCOUNT).length, 2);
    assert.equal(reload.intent.get(ACCOUNT, a.requestId).requestId, a.requestId);
    assert.equal(reload.intent.get(ACCOUNT, b.requestId).requestId, b.requestId);
    assert.equal(reload.intent.list(ACCOUNT, CODE).length, 1); safe(reload);
});
add('creation mirrors identical ID/payload to both real write paths and merges after refresh', () => {
    const h = harness(), item = h.intent.create(ACCOUNT, CODE, PAYLOAD);
    const key = 'equip_report_intent_v1:' + ACCOUNT + ':' + item.requestId;
    assert.equal(h.ls.data.get(key), h.ss.data.get(key));
    const reload = harness({ ls: h.ls, ss: h.ss });
    assert.equal(reload.intent.list(ACCOUNT).length, 1);
    assert.equal(reload.intent.get(ACCOUNT, item.requestId).requestId, item.requestId); safe(reload);
});
add('unreadable legacy local unknown plus empty session cannot become a silent new ID', () => {
    let unreadable = false;
    const ls = storage({ [LIST]: JSON.stringify(INITIAL), unrelated: 'SYNTHETIC untouched' }, op => unreadable && ['get', 'key', 'length'].includes(op));
    const h = harness({ ls }), item = h.intent.create(ACCOUNT, CODE, PAYLOAD);
    const key = 'equip_report_intent_v1:' + ACCOUNT + ':' + item.requestId;
    h.ss.data.delete(key); // Legacy single-copy intention, before this mirror repair.
    h.intent.mark(ACCOUNT, item.requestId, 'uncertain');
    const writes = h.ls.writes.length; unreadable = true;
    errorCode(() => h.intent.list(ACCOUNT), 'STORAGE_UNAVAILABLE');
    errorCode(() => h.intent.list(ACCOUNT, CODE), 'STORAGE_UNAVAILABLE');
    errorCode(() => h.intent.get(ACCOUNT, item.requestId), 'STORAGE_UNAVAILABLE');
    errorCode(() => h.intent.create(ACCOUNT, GEN, PAYLOAD), 'STORAGE_UNAVAILABLE');
    assert.equal(h.ls.writes.length, writes); assert.deepEqual(h.calls, []);
    unreadable = false; assert.equal(h.intent.list(ACCOUNT)[0].requestId, item.requestId); safe(h);
});
add('a readable session mirror recovers original ID while local access/get/enumeration fails', () => {
    let failure = '';
    const ls = storage({ [LIST]: JSON.stringify(INITIAL), unrelated: 'SYNTHETIC untouched' }, op => op === failure);
    const h = harness({ ls }), item = h.intent.create(ACCOUNT, CODE, PAYLOAD);
    for (const op of ['get', 'key', 'length']) {
        failure = op;
        assert.equal(h.intent.list(ACCOUNT, CODE)[0].requestId, item.requestId);
        assert.equal(h.intent.get(ACCOUNT, item.requestId).requestId, item.requestId);
        errorCode(() => h.intent.create(ACCOUNT, GEN, PAYLOAD), 'STORAGE_UNAVAILABLE');
    }
    failure = 'get'; h.intent.mark(ACCOUNT, item.requestId, 'uncertain');
    failure = ''; assert.equal(h.intent.list(ACCOUNT).length, 1);
    assert.equal(h.intent.get(ACCOUNT, item.requestId).state, 'uncertain');
    Object.defineProperty(h.ctx, 'localStorage', { configurable: true, get() { throw Error('SYNTHETIC access failure'); } });
    assert.equal(h.intent.get(ACCOUNT, item.requestId).requestId, item.requestId);
    assert.equal(h.intent.list(ACCOUNT, CODE).length, 1);
    errorCode(() => h.intent.list(ACCOUNT, GEN), 'STORAGE_UNAVAILABLE');
    errorCode(() => h.intent.create(ACCOUNT, GEN, PAYLOAD), 'STORAGE_UNAVAILABLE');
    Object.defineProperty(h.ctx, 'localStorage', { configurable: true, value: ls.api }); safe(h);
});
add('storage completely unavailable or readback mismatch blocks sending', () => {
    const ls = storage({}, () => true), ss = storage({}, () => true), h = harness({ ls, ss });
    errorCode(() => h.intent.create(ACCOUNT, CODE, PAYLOAD), 'STORAGE_UNAVAILABLE');
    errorCode(() => h.intent.list(ACCOUNT), 'STORAGE_UNAVAILABLE'); assert.deepEqual(h.calls, []);
    const discard = Object.freeze({ length: 0, key: () => null, getItem: () => null, setItem() {}, removeItem() {} });
    const h2 = harness({ ls: { api: discard, writes: [], data: new Map() }, ss: { api: discard, writes: [], data: new Map() } });
    errorCode(() => h2.intent.create(ACCOUNT, CODE, PAYLOAD), 'STORAGE_UNAVAILABLE'); assert.deepEqual(h2.calls, []);
});
add('unknown pending/uncertain intentions do not expire; only explicit removal clears one', () => {
    const h = harness(), a = h.intent.create(ACCOUNT, GEN, PAYLOAD), b = h.intent.create(ACCOUNT, GEN, PAYLOAD);
    h.intent.mark(ACCOUNT, a.requestId, 'uncertain');
    const reload = harness({ ls: h.ls, ss: h.ss, now: '2036-01-01T00:00:00.000Z' });
    assert.equal(reload.intent.list(ACCOUNT).length, 2); assert.equal(reload.intent.get(ACCOUNT, a.requestId).state, 'uncertain');
    reload.intent.remove(ACCOUNT, b.requestId); assert.equal(reload.intent.list(ACCOUNT).length, 1);
    assert.equal(reload.intent.get(ACCOUNT, a.requestId).state, 'uncertain'); safe(reload);
});
add('ID collision, invalid states and corrupt/conflicting copies never rewrite payload', () => {
    const h = harness({ crypto: { randomUUID: () => uuid(9) } }), item = h.intent.create(ACCOUNT, CODE, PAYLOAD);
    errorCode(() => h.intent.create(ACCOUNT, CODE, { ...PAYLOAD, symptom: 'SYNTHETIC replacement' }), 'ID_COLLISION');
    errorCode(() => h.intent.mark(ACCOUNT, item.requestId, 'success'), 'INVALID_STATE');
    assert.deepEqual(plain(h.intent.get(ACCOUNT, item.requestId).payload), PAYLOAD);
    const key = 'equip_report_intent_v1:' + ACCOUNT + ':' + item.requestId;
    h.ss.data.set(key, JSON.stringify({ ...plain(item), payload: { ...PAYLOAD, symptom: 'SYNTHETIC conflicting' } }));
    errorCode(() => h.intent.get(ACCOUNT, item.requestId), 'INTENT_CONFLICT');
    errorCode(() => h.intent.list(ACCOUNT), 'INTENT_CONFLICT');
    h.ss.data.set(key, 'SYNTHETIC not JSON'); errorCode(() => h.intent.list(ACCOUNT), 'INTENT_CORRUPT');
    assert.equal(h.ss.data.get(key), 'SYNTHETIC not JSON'); safe(h);
});
add('cloud missing/bad IDs reject before any RPC or storage mutation', async () => {
    const h = harness({ cloud: true });
    for (const id of [undefined, null, '', 'bad', {}, uuid(1) + ' ']) {
        const r = await h.report(CODE, PAYLOAD, id); assert.equal(r.ok, false); assert.match(r.msg, /请求编号无效/);
    }
    assert.deepEqual(h.calls, []); assert.deepEqual(h.ls.writes, []); safe(h);
});
add('cloud only calls once with exact seven arguments and normalized whitelist', async () => {
    const h = harness({ cloud: true }), id = uuid(8).toUpperCase();
    const r = await h.report(CODE, { symptom: ' SYNTHETIC fault　', place: ' SYNTHETIC place ', reportBy: ' SYNTHETIC reporter ', expectedAt: 'FORGED', cost: 999 }, id);
    assert.deepEqual(plain(r), { ok: true, code: CODE, recordId: 'SYNTHETIC-cloud-record', no: 'SYNTHETIC-cloud-no', expectedAt: '2026-11-05T00:15', replayed: false });
    assert.deepEqual(h.calls, [{ name: 'equipment_report_once', params: { p_token: 'SYNTHETIC token', p_code: CODE,
        p_symptom: PAYLOAD.symptom, p_expected: '', p_reportby: PAYLOAD.reportBy, p_place: PAYLOAD.place, p_request_id: uuid(8) } }]);
    assert.deepEqual(h.ls.writes, []); safe(h);
});
add('cloud exact code is not trimmed into another device', async () => {
    const h = harness({ cloud: true }); await h.report(' ' + CODE, PAYLOAD, uuid(1));
    assert.equal(h.calls[0].params.p_code, ' ' + CODE); safe(h);
});
for (const [label, rpc, uncertain] of [
    ['transport rejection', () => Promise.reject(Error('SYNTHETIC lost response')), true],
    ['transport error without code', () => Promise.resolve({ error: { message: 'SYNTHETIC failed fetch' } }), true],
    ['empty response', () => Promise.resolve({ data: null, error: null }), true],
    ['incomplete success', () => Promise.resolve({ data: { ok: true, no: 'SYNTHETIC partial' }, error: null }), true],
    ['receipt missing replay flag', () => Promise.resolve({ data: { ok: true, code: CODE, recordId: 'SYNTHETIC id', no: 'SYNTHETIC no', expectedAt: '2026-11-05T00:15' }, error: null }), true],
    ['receipt for another code', () => Promise.resolve({ data: { ok: true, code: OTHER, recordId: 'SYNTHETIC id', no: 'SYNTHETIC no', expectedAt: '2026-11-05T00:15', replayed: false }, error: null }), true],
    ['SQL known failure', () => Promise.resolve({ error: { message: 'SYNTHETIC database denied', code: 'P0001' } }), false],
    ['RPC not installed', () => Promise.resolve({ error: { message: 'SYNTHETIC missing function', code: 'PGRST202' } }), false]
]) add('cloud ' + label + ' preserves uncertainty and never falls back', async () => {
    const h = harness({ cloud: true, rpc }), intent = h.intent.create(ACCOUNT, CODE, PAYLOAD);
    const r = await h.report(CODE, intent.payload, intent.requestId); assert.equal(r.ok, false); assert.equal(!!r.uncertain, uncertain);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, 'equipment_report_once');
    assert.equal(h.intent.get(ACCOUNT, intent.requestId).requestId, intent.requestId); safe(h);
});
add('local same account+UUID+normalized payload has exactly one record/audit/number', async () => {
    const h = harness(), id = uuid(1), first = await h.report(CODE, PAYLOAD, id);
    assert.equal(first.ok, true); assert.equal(first.replayed, false); assert.equal(first.no, 'WO261104-08');
    assert.equal(first.code, CODE); assert.equal(first.expectedAt, '2026-11-05T00:15');
    const after = h.ls.data.get(JOURNAL), writes = h.ls.writes.length;
    const again = await h.report(CODE, { symptom: ' SYNTHETIC fault ', place: '　SYNTHETIC place ', reportBy: ' SYNTHETIC reporter ', expectedAt: 'FORGED' }, id.toUpperCase());
    assert.deepEqual(plain(again), { ...plain(first), replayed: true }); assert.equal(h.ls.data.get(JOURNAL), after);
    assert.equal(h.ls.writes.length, writes); assert.equal(h.data()[CODE].records.length, 2); assert.equal(h.audit().length, 2);
    assert.deepEqual(h.data()[CODE].records[0], INITIAL[CODE].records[0]); assert.deepEqual(h.data()[OTHER], INITIAL[OTHER]);
    assert.deepEqual(h.audit().at(-1), INITIAL_AUDIT[0]); safe(h);
});
add('local same ID different payload/code conflicts without another side effect', async () => {
    const h = harness(); await h.report(CODE, PAYLOAD, uuid(1)); const before = h.ls.snapshot();
    for (const [code, payload] of [[GEN, PAYLOAD], [CODE, { ...PAYLOAD, symptom: 'SYNTHETIC other' }], [CODE, { ...PAYLOAD, place: 'SYNTHETIC other' }], [CODE, { ...PAYLOAD, reportBy: 'SYNTHETIC other' }]]) {
        const r = await h.report(code, payload, uuid(1)); assert.equal(r.ok, false); assert.equal(r.code, 'REQUEST_ID_CONFLICT');
    }
    assert.deepEqual(h.ls.snapshot(), before); safe(h);
});
add('different IDs with identical faults create real new GEN orders and unique record IDs', async () => {
    const h = harness(); const a = await h.report(GEN, PAYLOAD, uuid(1)), b = await h.report(GEN, PAYLOAD, uuid(2));
    assert.equal(a.ok, true); assert.equal(b.ok, true); assert.notEqual(a.recordId, b.recordId); assert.notEqual(a.no, b.no);
    assert.equal(h.data()[GEN].records.length, 2); assert.equal(h.audit().length, 3); safe(h);
});
add('same UUID is account scoped without record ID collision', async () => {
    const h = harness(); const a = await h.report(GEN, PAYLOAD, uuid(1));
    const other = harness({ ls: h.ls, account: 'SYNTHETIC-second-account' });
    const b = await other.report(GEN, PAYLOAD, uuid(1)); assert.equal(b.replayed, false); assert.notEqual(a.recordId, b.recordId);
    assert.equal(other.data()[GEN].records.length, 2); assert.equal(other.journal().receipts.length, 2); safe(other);
});
add('local receipt survives refresh; deletion/movement does not resurrect the report', async () => {
    const h = harness(), first = await h.report(CODE, PAYLOAD, uuid(1));
    const reload = harness({ ls: h.ls, ss: h.ss });
    assert.equal((await reload.report(CODE, PAYLOAD, uuid(1))).replayed, true);
    let all = reload.data(), moved = all[CODE].records.pop(); all[GEN].records.push(moved); reload.ctx.localSet(all);
    reload.ctx.localPushAudit(GEN, 'SYNTHETIC-move', 'SYNTHETIC summary');
    const beforeMoveRetry = reload.ls.data.get(JOURNAL);
    assert.deepEqual(plain(await reload.report(CODE, PAYLOAD, uuid(1))), { ...plain(first), replayed: true });
    assert.equal(reload.ls.data.get(JOURNAL), beforeMoveRetry); assert.equal(reload.data()[GEN].records.length, 1);
    all = reload.data(); all[GEN].records = []; delete all[CODE]; reload.ctx.localSet(all);
    const beforeDeleteRetry = reload.ls.data.get(JOURNAL);
    assert.equal((await reload.report(CODE, PAYLOAD, uuid(1))).replayed, true);
    assert.equal(reload.ls.data.get(JOURNAL), beforeDeleteRetry); assert.equal(reload.data()[CODE], undefined);
    const next = await reload.report(GEN, PAYLOAD, uuid(2)); assert.equal(next.no, 'WO261104-09');
    assert.equal(reload.journal().receipts.length, 2); safe(reload);
});
add('real correct/supplement/reply/expected/save/remove APIs preserve journal receipts', async () => {
    const h = harness({ role: 'admin' }), first = await h.report(GEN, PAYLOAD, uuid(1));
    const moved = await h.ctx.EquipApi.correctReport(GEN, first.recordId, { targetCode: CODE, ...PAYLOAD,
        expected: { symptom: PAYLOAD.symptom, place: PAYLOAD.place }, reason: 'SYNTHETIC move' });
    assert.equal(moved.ok, true); assert.equal(moved.moved, true);
    assert.equal((await h.ctx.EquipApi.supplementReport(CODE, first.recordId, 'SYNTHETIC supplement')).ok, true);
    assert.equal((await h.ctx.EquipApi.reply(CODE, first.recordId, 'SYNTHETIC reply', '')).ok, true);
    assert.equal((await h.ctx.EquipApi.setExpected(CODE, first.recordId, '2026-11-06T12:34')).ok, true);
    assert.equal(h.journal().receipts.length, 1);
    const before = h.ls.data.get(JOURNAL);
    assert.deepEqual(plain(await h.report(GEN, PAYLOAD, uuid(1))), { ...plain(first), replayed: true });
    assert.equal(h.ls.data.get(JOURNAL), before);
    // Legacy trash IDs still use Math.random; freeze that unrelated pre-existing
    // implementation here, not the secure report/intent UUID path tested above.
    h.ctx.Math.random = () => 0.25;
    const device = h.data()[CODE]; device.records = device.records.filter(r => r.id !== first.recordId);
    assert.equal((await h.ctx.EquipApi.save(CODE, device, 'SYNTHETIC delete record')).ok, true);
    assert.equal((await h.report(GEN, PAYLOAD, uuid(1))).replayed, true);
    assert.equal(h.data()[GEN].records.length, 0); assert.equal(h.data()[CODE].records.length, 1);
    assert.equal((await h.ctx.EquipApi.remove(GEN)).ok, true);
    assert.equal((await h.report(GEN, PAYLOAD, uuid(1))).replayed, true);
    assert.equal(h.data()[GEN], undefined); assert.equal(h.journal().receipts.length, 1); safe(h);
});
add('local unavailable storage cannot silently report into memory/sessionStorage', async () => {
    let denied = false;
    const ls = storage({ [LIST]: JSON.stringify(INITIAL), [AUDIT]: JSON.stringify(INITIAL_AUDIT), unrelated: 'SYNTHETIC untouched' }, () => denied);
    const h = harness({ ls }); denied = true;
    const result = await h.report(CODE, PAYLOAD, uuid(1));
    assert.equal(result.ok, false); assert.equal(result.uncertain, true);
    assert.equal(ls.data.has(JOURNAL), false); assert.equal(h.ss.data.has(JOURNAL), false);
    assert.deepEqual(JSON.parse(ls.data.get(LIST)), INITIAL); assert.deepEqual(h.calls, []);
});
add('journal is authoritative when both compatibility projections fail', async () => {
    let failProjection = false;
    const ls = storage({ [LIST]: JSON.stringify(INITIAL), [AUDIT]: JSON.stringify(INITIAL_AUDIT), unrelated: 'SYNTHETIC untouched' },
        (op, key) => failProjection && op === 'set' && [LIST, AUDIT].includes(key));
    const h = harness({ ls }); failProjection = true;
    const first = await h.report(CODE, PAYLOAD, uuid(1)); assert.equal(first.ok, true);
    assert.equal(JSON.parse(ls.data.get(LIST))[CODE].records.length, 1);
    const reload = harness({ ls, ss: h.ss });
    assert.equal(reload.data()[CODE].records.length, 2); assert.equal(reload.audit().length, 2);
    assert.equal((await reload.report(CODE, PAYLOAD, uuid(1))).replayed, true); safe(reload);
});
add('failed journal write has no record/audit; failed post-write readback replays after refresh', async () => {
    let mode = 'write', committed = false;
    const ls = storage({ [LIST]: JSON.stringify(INITIAL), [AUDIT]: JSON.stringify(INITIAL_AUDIT), unrelated: 'SYNTHETIC untouched' },
        (op, key) => {
            if (key !== JOURNAL) return false;
            if (mode === 'write' && op === 'set') return true;
            if (mode === 'readback' && op === 'set') { committed = true; return false; }
            if (mode === 'readback' && op === 'get' && committed) return true;
            return false;
        });
    const h = harness({ ls }); const failed = await h.report(CODE, PAYLOAD, uuid(1));
    assert.equal(failed.ok, false); assert.equal(failed.uncertain, true); assert.equal(ls.data.has(JOURNAL), false);
    assert.deepEqual(JSON.parse(ls.data.get(LIST)), INITIAL); assert.deepEqual(JSON.parse(ls.data.get(AUDIT)), INITIAL_AUDIT);
    mode = 'readback'; const unknown = await h.report(CODE, PAYLOAD, uuid(1)); assert.equal(unknown.ok, false); assert.equal(unknown.uncertain, true);
    mode = 'normal'; const reload = harness({ ls, ss: h.ss });
    const retry = await reload.report(CODE, PAYLOAD, uuid(1)); assert.equal(retry.replayed, true);
    assert.equal(reload.data()[CODE].records.length, 2); assert.equal(reload.audit().length, 2); safe(reload);
});
add('cooperating tabs serialize same ID and conflicts with Web Locks; no locks fail closed', async () => {
    const h = harness(), tab = harness({ ls: h.ls, locks: h.ctx.navigator.locks });
    const results = await Promise.all([h.report(GEN, PAYLOAD, uuid(1)), tab.report(GEN, PAYLOAD, uuid(1))]);
    assert.equal(results.filter(r => r.ok && !r.replayed).length, 1); assert.equal(results.filter(r => r.replayed).length, 1);
    const conflict = await Promise.all([h.report(GEN, PAYLOAD, uuid(2)), tab.report(GEN, { ...PAYLOAD, symptom: 'SYNTHETIC other' }, uuid(2))]);
    assert.equal(conflict.filter(r => r.ok).length, 1); assert.equal(conflict.filter(r => r.code === 'REQUEST_ID_CONFLICT').length, 1);
    assert.equal(h.data()[GEN].records.length, 2);
    const noLocks = harness({ noLocks: true }), before = noLocks.ls.snapshot();
    const r = await noLocks.report(CODE, PAYLOAD, uuid(3)); assert.equal(r.ok, false); assert.match(r.msg, /本地报修锁/);
    assert.deepEqual(noLocks.ls.snapshot(), before); safe(h); safe(noLocks);
});
for (const role of ['admin', 'repairer', 'reporter']) add('local ' + role + ' keeps Beijing +24h and financial/profile boundaries', async () => {
    const h = harness({ role }); const r = await h.report(CODE, { ...PAYLOAD, cost: 999999, name: 'FORGED', expectedAt: 'FORGED', records: [] }, uuid(1));
    assert.equal(r.ok, true); const rec = h.data()[CODE].records.at(-1);
    assert.equal(rec.reportAt, '2026-11-04'); assert.equal(rec.expectedAt, '2026-11-05T00:15');
    assert.equal(rec.createdAt, '2026-11-04 00:15:00'); assert.equal(rec.cost, 0); assert.equal(rec.supplier, '');
    assert.equal(h.data()[CODE].name, INITIAL[CODE].name); assert.deepEqual(h.data()[CODE].records[0], INITIAL[CODE].records[0]);
    assert.equal(h.audit()[0].at, '2026/11/4 00:15:00');
    if (role === 'reporter') {
        const masked = await h.ctx.EquipApi.getDevice(CODE); assert.equal(masked.equipment.records[0].cost, undefined);
        assert.equal(masked.equipment.records[0].supplier, undefined); assert.equal(masked.equipment.photos, undefined);
    }
    safe(h);
});
for (const [label, options, code] of [['view', { role: 'view' }, CODE], ['guest', { role: 'guest' }, CODE],
    ['other department', {}, OTHER], ['missing department', { dept: '' }, CODE], ['missing equipment', {}, 'SYNTHETIC-NO-SUCH'],
    ['exact equipment code', {}, ' ' + CODE]]) add('local old permission/validation boundary: ' + label, async () => {
    const h = harness(options), before = h.ls.snapshot(), result = await h.report(code, PAYLOAD, uuid(1));
    assert.equal(result.ok, false); assert.deepEqual(h.ls.snapshot(), before); safe(h);
});
add('a session/account change while waiting for a lock cannot create for another account', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const h = harness({ locks: { request: (_name, fn) => gate.then(fn) } });
    const result = h.report(CODE, PAYLOAD, uuid(1));
    h.ctx.SessionStore.merge({ account: 'SYNTHETIC-next-account' }); release();
    const r = await result; assert.equal(r.ok, false); assert.match(r.msg, /账号已变化/); assert.equal(h.ls.data.has(JOURNAL), false);
});

(async () => {
    let passed = 0;
    for (const { name, fn } of tests) {
        try { await fn(); passed++; console.log('PASS ' + name); }
        catch (e) { console.error('FAIL ' + name + '\n' + e.stack); process.exitCode = 1; }
    }
    assert.deepEqual(JSON.parse(JSON.stringify(INITIAL)), INITIAL, 'Frozen source fixture unchanged');
    console.log('Report idempotency: ' + passed + '/' + tests.length + ' passed; all operations synthetic/offline.');
})().catch(e => { console.error(e.stack); process.exitCode = 1; });