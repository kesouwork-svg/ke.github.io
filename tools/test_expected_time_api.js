require('./equipment_report_test_preload.cjs');
/* Isolated expected-time regression: real helper/session/API/app, synthetic VM only.
 * Run: node --unhandled-rejections=strict tools/test_expected_time_api.js
 * No browser, network, production JSON, account, notification, hardware or file writes.
 * HTML is read only to model declared controls; this is not a layout/browser test.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sources = ['docs/equipment/js/equipment-time.js', 'docs/js/session.js',
    'docs/equipment/js/equipment-api.js', 'docs/equipment/js/equipment-app.js'].map(file => ({ file, text: read(file) }));
const html = read('docs/equipment/index.html');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const CODE = 'SYNTHETIC-EQ', OTHER = 'SYNTHETIC-OTHER';
const NOW = Date.parse('2024-02-28T16:17:45.678Z'); // Beijing leap day 00:17; +24h is March 1.
const DUE = '2024-03-01T00:17';
const NEW_DUE = '2024-03-02T15:26';
const roles = ['admin', 'repairer', 'reporter', 'view'];
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function record(id, extra) {
    return Object.assign({ id, no: 'SYNTHETIC-' + id, type: 'fault', status: 'open', reportAt: '2024-02-20',
        expectedAt: '2024-02-29', doneAt: '', symptom: 'SYNTHETIC symptom', place: 'SYNTHETIC location',
        reportBy: 'SYNTHETIC reporter', updates: [{ at: '2024-02-21 09:10', by: 'SYNTHETIC repairer', text: 'SYNTHETIC progress' }],
        _supplements: [{ at: '2024-02-21 10:00', by: 'SYNTHETIC reporter', text: 'SYNTHETIC supplement' }],
        _corrections: [{ at: '2024-02-22 10:00', summary: 'SYNTHETIC correction' }],
        action: 'SYNTHETIC action', cost: 7, cause1: 'SYNTHETIC classification', cause3: 'SYNTHETIC category',
        photos: [], parts: [{ name: 'SYNTHETIC part', qty: 1 }], custom: { untouched: true } }, extra || {});
}
function fixture() {
    return {
        [CODE]: { code: CODE, name: 'SYNTHETIC machine', line: 'SYNTHETIC department', family: 'SYNTHETIC family',
            status: 'active', category: 'prod', _recordsRev: 'SYNTHETIC-rev-0', photos: [], records: [
                record('open'), record('done', { status: 'done', doneAt: '2024-02-27', expectedAt: '2024-02-26' }),
                record('bad', { expectedAt: 'SYNTHETIC invalid historical value' }), record('empty', { expectedAt: '' })] },
        [OTHER]: { code: OTHER, name: 'SYNTHETIC other machine', line: 'SYNTHETIC other department',
            _recordsRev: 'SYNTHETIC-other-rev', records: [record('other')] }
    };
}
function storage(initial) {
    const data = new Map(Object.entries(initial || {}));
    const writes = [];
    return { data, writes, getItem: key => data.has(String(key)) ? data.get(String(key)) : null,
        setItem(key, value) { data.set(String(key), String(value)); writes.push({ key: String(key), value: String(value) }); },
        removeItem(key) { data.delete(String(key)); writes.push({ key: String(key), removed: true }); } };
}
function element(id, attrs) {
    const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    return { id, type: attrs.type || '', step: attrs.step || '', value: '', textContent: '', innerHTML: '',
        disabled: false, hidden: false, open: false, style: {}, attributes: Object.assign({}, attrs),
        classList: { add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)),
            contains: name => classes.has(name), toggle(name) { if (classes.has(name)) { classes.delete(name); return false; } classes.add(name); return true; } },
        setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name] || null; },
        addEventListener() {}, focus() {}, contains() { return false; }, querySelector() { return null; }, querySelectorAll() { return []; },
        getBoundingClientRect() { return { top: 0, height: 0 }; } };
}
function create(role = 'admin', options = {}) {
    let clock = options.now == null ? NOW : options.now;
    class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
    const initial = options.data || fixture();
    const localStorage = storage({ equip_list_v2: JSON.stringify(initial), equip_audit_v2: '[]', equip_seed_v2: 'SYNTHETIC-seeded' });
    const sessionStorage = storage();
    const nodes = new Map();
    for (const match of html.matchAll(/<[a-z][^>]*\bid="([^"]+)"[^>]*>/gi)) {
        const attrs = {};
        for (const attr of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]] = attr[2];
        nodes.set(match[1], element(match[1], attrs));
    }
    const rpcCalls = [], effects = [], events = [];
    let rpcHandler = () => ({ ok: false, msg: 'SYNTHETIC unconfigured response' });
    const forbidden = what => () => { throw new Error('Forbidden external operation: ' + what); };
    const ctx = vm.createContext({ console, Date: FixedDate, localStorage, sessionStorage,
        location: { search: '', pathname: '/synthetic/equipment/index.html', href: 'about:blank', reload: forbidden('reload') },
        navigator: {}, crypto: { randomUUID: () => 'SYNTHETIC-rev-' + (++ctx.__revision) }, __revision: 0,
        setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: fn => fn(), scrollTo() {},
        fetch: forbidden('fetch'), XMLHttpRequest: forbidden('XMLHttpRequest'), WebSocket: forbidden('WebSocket'),
        Image: forbidden('Image'), print: forbidden('print'), open: forbidden('window.open'),
        document: { getElementById: id => nodes.get(id) || null,
            querySelectorAll: selector => selector === '.view' ? [...nodes.values()].filter(n => n.classList.contains('view')) : [],
            querySelector: () => null, addEventListener: (...args) => events.push(args),
            createElement: forbidden('document.createElement'), documentElement: { clientWidth: 1000 }, body: { clientWidth: 1000 } },
        addEventListener: (...args) => events.push(args), matchMedia: () => ({ matches: false }),
        supabase: { createClient(url, key) {
            assert.equal(url, 'https://synthetic.invalid'); assert.equal(key, 'SYNTHETIC-only');
            return { rpc(name, args) { rpcCalls.push({ name, args: plain(args) });
                return Promise.resolve().then(() => rpcHandler(name, args)).then(data => ({ data, error: null })); }
            };
        } }
    });
    ctx.window = ctx;
    for (const source of sources) vm.runInContext(source.text, ctx, { filename: source.file });
    ctx.EqConfig.cloud = false;
    ctx.EqConfig.supabaseUrl = 'https://synthetic.invalid'; ctx.EqConfig.supabaseKey = 'SYNTHETIC-only';
    // A production/demo seed body must never execute, even if a test accidentally calls a list entry.
    ctx.seedLocal = forbidden('production/demo seed');
    // Preserve all real form/permission/submit/navigation invalidation logic. Only final rendering is observed.
    ctx.renderList = () => effects.push({ type: 'list' });
    ctx.openDetail = (code, cached) => effects.push({ type: 'detail', code, cached });
    ctx.refreshDevice = code => effects.push({ type: 'refresh', code });
    ctx.positionDetail = () => {};
    function identity(nextRole, token = 'SYNTHETIC-token-' + nextRole) {
        const tools = nextRole === 'admin' ? ['equipment-admin'] : nextRole === 'repairer' ? ['equipment'] : nextRole === 'reporter' ? ['equipment-report'] : [];
        ctx.SessionStore.write(JSON.stringify({ account: 'SYNTHETIC-' + nextRole, name: 'SYNTHETIC ' + nextRole,
            tools, token, dept: 'SYNTHETIC department', level: 1 }));
        ctx.ROLE = ctx.EquipApi.role();
    }
    identity(role);
    ctx.EQ = plain(initial); ctx.currentCode = CODE;
    localStorage.writes.length = 0; sessionStorage.writes.length = 0;
    return { ctx, nodes, effects, rpcCalls, localStorage, identity,
        node: id => { assert(nodes.has(id), 'Missing declared HTML control ' + id); return nodes.get(id); },
        data: () => JSON.parse(localStorage.getItem('equip_list_v2')),
        audits: () => JSON.parse(localStorage.getItem('equip_audit_v2')),
        writes: () => localStorage.writes.filter(w => w.key.startsWith('equip_')),
        rpc(fn) { ctx.EqConfig.cloud = true; rpcHandler = fn; },
        time(ms) { clock = ms; } };
}
function success(h, expected = NEW_DUE, id = 'open') {
    const equipment = plain(h.ctx.EQ[CODE]); equipment.records.find(r => r.id === id).expectedAt = expected;
    return { ok: true, code: CODE, expectedAt: expected, equipment };
}
function openExpected(h, id = 'open', value = NEW_DUE) {
    h.ctx.setExpected(id); h.node('et-expected').value = value;
}
function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }

for (const role of ['admin', 'repairer', 'reporter']) {
    test(role + ' report: forged expected ignored, Beijing +24h, historical records untouched', async () => {
        const h = create(role), before = h.data();
        const r = await h.ctx.EquipApi.report(CODE, { symptom: 'SYNTHETIC new fault', place: ' SYNTHETIC new place ', expectedAt: '9999-12-31T23:59' },'10000000-0000-4000-8000-000000000019');
        assert.equal(r.ok, true); const after = h.data(), created = after[CODE].records.at(-1);
        assert.deepEqual(after[CODE].records.slice(0, -1), before[CODE].records); assert.deepEqual(after[OTHER], before[OTHER]);
        assert.equal(created.expectedAt, DUE); assert.equal(created.reportAt, '2024-02-29');
        assert.equal(created.createdAt, '2024-02-29 00:17:00'); assert.equal(created.doneAt, ''); assert.equal(created.status, 'open');
        assert.notEqual(after[CODE]._recordsRev, before[CODE]._recordsRev); assert.equal(h.audits().length, 1);
    });
    test(role + ' cloud report forwards blank p_expected, never the forged payload', async () => {
        const h = create(role); h.rpc(() => ({ ok: true,code:CODE,recordId:'SYNTHETIC-id',no:'SYNTHETIC-no',expectedAt:DUE,replayed:false }));
        const r = await h.ctx.EquipApi.report(CODE, { symptom: 'SYNTHETIC fault', place: 'SYNTHETIC place', expectedAt: { malicious: true } },'10000000-0000-4000-8000-000000000020');
        assert.equal(r.ok, true); assert.equal(h.rpcCalls.length, 1);
        assert.equal(h.rpcCalls[0].name, 'equipment_report_once'); assert.match(h.rpcCalls[0].args.p_request_id,/^[0-9a-f-]{36}$/i); assert.equal(h.rpcCalls[0].args.p_expected, ''); assert.equal(h.writes().length, 0);
    });
}
test('report +24h crosses Beijing new year independently of browser local date', async () => {
    const h = create('admin', { now: Date.parse('2024-12-31T15:59:59.999Z') });
    await h.ctx.EquipApi.report(CODE, { symptom: 'SYNTHETIC fault', place: 'SYNTHETIC place' },'10000000-0000-4000-8000-000000000021');
    const r = h.data()[CODE].records.at(-1); assert.equal(r.reportAt, '2024-12-31'); assert.equal(r.expectedAt, '2025-01-01T23:59');
});
test('view report and cross-department reporter report are denied with no writes', async () => {
    for (const [role, code] of [['view', CODE], ['reporter', OTHER]]) {
        const h = create(role), before = h.data();
        assert.equal((await h.ctx.EquipApi.report(code, { symptom: 'SYNTHETIC', place: 'SYNTHETIC' },'10000000-0000-4000-8000-000000000022')).ok, false);
        assert.deepEqual(h.data(), before); assert.equal(h.writes().length, 0);
    }
});
for (const role of ['admin', 'repairer']) {
    test(role + ' setExpected patches completed record only, revision plus exactly one audit, no reopening', async () => {
        const h = create(role), before = h.data();
        const r = await h.ctx.EquipApi.setExpected(CODE, 'done', NEW_DUE);
        assert.equal(r.ok, true); const after = h.data();
        const expected = plain(before); expected[CODE].records[1].expectedAt = NEW_DUE;
        expected[CODE].records[1].updatedAt = '2024-02-29 00:17'; expected[CODE].records[1].updatedBy = 'SYNTHETIC ' + role;
        expected[CODE]._recordsRev = after[CODE]._recordsRev;
        assert.notEqual(after[CODE]._recordsRev, before[CODE]._recordsRev); assert.deepEqual(after, expected);
        assert.equal(after[CODE].records[1].doneAt, '2024-02-27'); assert.equal(after[CODE].records[1].status, 'done');
        assert.equal(h.audits().length, 1); assert.equal(h.audits()[0].action, 'expected');
        assert.deepEqual(h.writes().map(w => w.key), ['equip_list_v2', 'equip_audit_v2']);
        assert.equal(r.code, CODE); assert.deepEqual(plain(r.equipment), after[CODE]);
    });
    test(role + ' setExpected cloud uses only dedicated patch RPC and raw response', async () => {
        const h = create(role), response = success(h); h.rpc(() => response);
        const r = await h.ctx.EquipApi.setExpected(CODE, 'open', NEW_DUE);
        assert.deepEqual(plain(r), response); assert.deepEqual(h.rpcCalls, [{ name: 'equipment_set_expected',
            args: { p_token: 'SYNTHETIC-token-' + role, p_code: CODE, p_record_id: 'open', p_expected: NEW_DUE } }]);
        assert.equal(h.writes().length, 0);
    });
    test(role + ' reply can change expected, blank/omitted keep original legacy date', async () => {
        for (const expected of [NEW_DUE, '', undefined]) {
            const h = create(role), before = h.data();
            const r = await h.ctx.EquipApi.reply(CODE, 'open', ' SYNTHETIC reply ', expected);
            assert.equal(r.ok, true); const after = h.data(), rec = after[CODE].records[0];
            assert.equal(rec.expectedAt, expected || before[CODE].records[0].expectedAt);
            assert.equal(rec.updates.length, 2); assert.equal(rec.updates[1].text, 'SYNTHETIC reply');
            assert.equal(rec.status, 'open'); assert.equal(rec.doneAt, '');
            assert.deepEqual(after[CODE].records.slice(1), before[CODE].records.slice(1));
            assert.notEqual(after[CODE]._recordsRev, before[CODE]._recordsRev); assert.equal(h.audits().length, 1);
        }
    });
}
test('setExpected clear is explicit; unlike reply blank actually clears', async () => {
    const h = create(); assert.equal((await h.ctx.EquipApi.setExpected(CODE, 'open', '')).ok, true);
    assert.equal(h.data()[CODE].records[0].expectedAt, ''); assert.equal(h.audits().length, 1);
});
test('setExpected rejects reporter/view/no-session before local write or cloud RPC', async () => {
    for (const role of ['reporter', 'view', 'none']) for (const cloud of [false, true]) {
        const h = create(role), before = h.data(); if (role === 'none') { h.ctx.SessionStore.clear(); h.localStorage.writes.length = 0; }
        if (cloud) h.rpc(() => ({ ok: true }));
        assert.equal((await h.ctx.EquipApi.setExpected(CODE, 'open', NEW_DUE)).ok, false);
        assert.deepEqual(h.data(), before); assert.equal(h.writes().length, 0); assert.equal(h.rpcCalls.length, 0);
    }
});
test('setExpected strict invalid values and duplicate/missing ids cause zero writes', async () => {
    const invalid = ['2023-02-29', '2024-02-30T12:10', '2024-01-01T24:00', '2024-01-01T00:60', '2024-01-01T12:00Z',
        '2024-01-01\n', ' 2024-01-01', '0x1234', null, undefined, {}, [], Infinity, NaN];
    for (const value of invalid) for (const cloud of [false, true]) {
        const h = create(), before = h.data(); if (cloud) h.rpc(() => ({ ok: true }));
        assert.equal((await h.ctx.EquipApi.setExpected(CODE, 'open', value)).ok, false, String(value));
        assert.deepEqual(h.data(), before); assert.equal(h.writes().length, 0); assert.equal(h.rpcCalls.length, 0);
    }
    for (const id of ['', 'missing', 'open']) {
        const data = fixture(); if (id === 'open') data[CODE].records.push(record('open'));
        const h = create('admin', { data }), before = h.data();
        assert.equal((await h.ctx.EquipApi.setExpected(CODE, id, NEW_DUE)).ok, false);
        assert.deepEqual(h.data(), before); assert.equal(h.writes().length, 0);
    }
});
test('reply invalid expected writes nothing, including no progress/audit/version; completed reply remains denied', async () => {
    for (const value of ['2024-02-30', '2024-02-29T24:00', {}, '2024-02-29\n']) for (const cloud of [false, true]) {
        const h = create(), before = h.data(); if (cloud) h.rpc(() => ({ ok: true }));
        assert.equal((await h.ctx.EquipApi.reply(CODE, 'open', 'SYNTHETIC reply', value)).ok, false);
        assert.deepEqual(h.data(), before); assert.equal(h.writes().length, 0); assert.equal(h.rpcCalls.length, 0);
    }
    const h = create(), before = h.data(); assert.equal((await h.ctx.EquipApi.reply(CODE, 'done', 'SYNTHETIC reply', NEW_DUE)).ok, false);
    assert.deepEqual(h.data(), before); assert.equal(h.writes().length, 0);
});
test('reply malformed containers and duplicate ids reject before expected/progress/audit writes', async () => {
    for (const role of ['admin', 'repairer']) for (const kind of ['records-null', 'records-object', 'duplicate', 'updates-null', 'updates-object', 'updates-string', 'updates-false']) {
        const data = fixture();
        if (kind === 'records-null') data[CODE].records = null;
        else if (kind === 'records-object') data[CODE].records = {};
        else if (kind === 'duplicate') data[CODE].records.push(record('open'));
        else data[CODE].records[0].updates = { 'updates-null': null, 'updates-object': {}, 'updates-string': '', 'updates-false': false }[kind];
        const h = create(role, { data }), before = h.data();
        assert.equal((await h.ctx.EquipApi.reply(CODE, 'open', 'SYNTHETIC reply', NEW_DUE)).ok, false, role + '/' + kind);
        assert.deepEqual(h.data(), before); assert.equal(h.writes().length, 0); assert.equal(h.rpcCalls.length, 0);
    }
});
test('reply done truthiness matches original APP without reopening or altering original status/doneAt', async () => {
    for (const role of ['admin', 'repairer']) for (const status of [undefined, null, '', false, 0, 'done', 'open', 'pending', {}, []]) for (const doneAt of [null, false, 0, '', '2024-02-27', [], {}]) {
        const data = fixture(); data[CODE].records[0].status = status; data[CODE].records[0].doneAt = doneAt;
        const h = create(role, { data }), before = h.data();
        const done = (status || (doneAt ? 'done' : 'open')) === 'done';
        const result = await h.ctx.EquipApi.reply(CODE, 'open', 'SYNTHETIC reply', NEW_DUE);
        assert.equal(result.ok, !done, JSON.stringify({ role, status, doneAt }));
        if (done) { assert.deepEqual(h.data(), before); assert.equal(h.writes().length, 0); }
        else {
            const after = h.data()[CODE].records[0];
            assert.deepEqual(after.status, before[CODE].records[0].status); assert.deepEqual(after.doneAt, before[CODE].records[0].doneAt);
            assert.equal(after.updates.length, before[CODE].records[0].updates.length + 1); assert.equal(after.expectedAt, NEW_DUE);
        }
    }
});
test('save validates changed expected only; unchanged invalid historical strings and objects do not block unrelated edits', async () => {
    for (const role of ['admin', 'repairer']) for (const value of ['SYNTHETIC invalid history', { synthetic: ['invalid', 4] }, '2023-02-29', null]) {
        const data = fixture(); data[CODE].records[0].expectedAt = value;
        const h = create(role, { data }), incoming = plain(data[CODE]); incoming.records[0].action = 'SYNTHETIC unrelated handling edit';
        assert.equal((await h.ctx.EquipApi.save(CODE, incoming, 'SYNTHETIC edit')).ok, true);
        assert.deepEqual(h.data()[CODE].records[0].expectedAt, value);
    }
});
test('save rejects newly introduced invalid expected with no side effects, accepts changed valid minute and legacy date', async () => {
    for (const role of ['admin', 'repairer']) for (const value of ['2024-02-30', '2024-02-29T24:00', { fake: true }, '2024-02-29\n', NEW_DUE, '2024-02-29', '']) {
        const h = create(role), before = h.data(), incoming = plain(before[CODE]); incoming.records[0].expectedAt = value;
        const r = await h.ctx.EquipApi.save(CODE, incoming, 'SYNTHETIC edit');
        if (typeof value === 'string' && ['', NEW_DUE, '2024-02-29'].includes(value)) {
            assert.equal(r.ok, true); assert.equal(h.data()[CODE].records[0].expectedAt, value);
        } else { assert.equal(r.ok, false); assert.deepEqual(h.data(), before); assert.equal(h.writes().length, 0); }
    }
});
test('dedicated expected patch invalidates stale whole-device save instead of clobbering newer expected', async () => {
    const h = create(), stale = plain(h.data()[CODE]); await h.ctx.EquipApi.setExpected(CODE, 'open', NEW_DUE);
    const afterPatch = h.data(), count = h.writes().length;
    assert.equal((await h.ctx.EquipApi.save(CODE, stale, 'SYNTHETIC stale edit')).ok, false);
    assert.deepEqual(h.data(), afterPatch); assert.equal(h.writes().length, count); assert.equal(h.audits().length, 1);
});
test('UI caps expose setExpected only to admin/repairer, still deny reporter/view entry', () => {
    for (const role of roles) {
        const h = create(role), allowed = ['admin', 'repairer'].includes(role);
        assert.equal(h.ctx.caps().setExpected, allowed); h.ctx.setExpected('open');
        assert.equal(Boolean(h.ctx.expectedEdit), allowed); assert.equal(h.node('view-expected').classList.contains('show'), allowed);
        assert.equal(h.rpcCalls.length, 0); assert.equal(h.writes().length, 0);
    }
});
test('UI dedicated form opens datetime-local minute input, raw original remains date, no edit until submit', () => {
    const h = create('repairer'), before = plain(h.ctx.EQ); h.ctx.setExpected('open');
    assert.equal(h.node('et-expected').type, 'datetime-local'); assert.equal(h.node('et-expected').step, '60');
    assert.equal(h.node('et-expected').value, '2024-02-29T23:59'); assert.equal(h.ctx.expectedEdit.original, '2024-02-29');
    assert.match(h.node('et-legacy').textContent, /历史记录仅有日期/); assert.deepEqual(plain(h.ctx.EQ), before); assert.equal(h.writes().length, 0);
});
test('UI unchanged dedicated legacy input sends original date, not artificial 23:59 datetime', async () => {
    const h = create(); h.rpc(() => success(h, '2024-02-29')); h.ctx.setExpected('open'); h.ctx.submitExpected(); await flush();
    assert.equal(h.rpcCalls.length, 1); assert.equal(h.rpcCalls[0].args.p_expected, '2024-02-29');
    assert.equal(h.ctx.EQ[CODE].records[0].expectedAt, '2024-02-29'); assert.equal(h.ctx.expectedEdit, null);
});
test('UI completed timeline has a direct dedicated expected entry for both handling roles', () => {
    for (const role of ['admin', 'repairer']) {
        const h = create(role); h.ctx.tlYear = 2024; h.ctx.tlYearOnly = true; h.ctx.renderManageDetail(h.ctx.EQ[CODE]);
        const rendered = h.node('detail-content').innerHTML;
        assert(rendered.includes('onclick="setExpected(\'done\')"')); assert(!rendered.includes('onclick="openReplyForm(\'done\')"'));
        vm.runInContext("setExpected('done')", h.ctx); assert.equal(h.ctx.expectedEdit.id, 'done');
        assert.equal(h.node('view-expected').classList.contains('show'), true);
    }
});
for (const role of ['admin', 'repairer']) {
    test(role + ' UI reply changed/unchanged/cleared input sends correct expected without legacy conversion', async () => {
        for (const value of [NEW_DUE, '2024-02-29T23:59', '']) {
            const h = create(role); h.rpc(() => ({ ok: true })); h.ctx.openReplyForm('open');
            assert.equal(h.node('rp-expected').type, 'datetime-local'); assert.equal(h.node('rp-expected').disabled, false);
            h.node('rp-text').value = 'SYNTHETIC reply'; h.node('rp-expected').value = value; h.ctx.submitReply(); await flush();
            assert.equal(h.rpcCalls.length, 1); assert.equal(h.rpcCalls[0].name, 'equipment_reply');
            assert.equal(h.rpcCalls[0].args.p_expected, value === NEW_DUE ? NEW_DUE : ''); assert.equal(h.effects.filter(e => e.type === 'refresh').length, 1);
        }
    });
}
test('UI invalid dedicated/reply expected submits no RPC and no local write', async () => {
    for (const form of ['expected', 'reply']) {
        const h = create(); h.rpc(() => ({ ok: true }));
        if (form === 'expected') { openExpected(h, 'open', '2024-02-30T12:00'); h.ctx.submitExpected(); }
        else { h.ctx.openReplyForm('open'); h.node('rp-text').value = 'SYNTHETIC reply'; h.node('rp-expected').value = '2024-02-30T12:00'; h.ctx.submitReply(); }
        await flush(); assert.equal(h.rpcCalls.length, 0); assert.equal(h.writes().length, 0); assert.match(h.node('toast').textContent, /有效/);
    }
});
test('UI dedicated busy blocks duplicate submit and cancel; success refresh uses returned single-device data', async () => {
    const h = create(), d = deferred(); h.rpc(() => d.promise); openExpected(h); h.ctx.submitExpected(); h.ctx.submitExpected();
    const form = h.ctx.expectedEdit; h.ctx.cancelExpected(); assert.equal(h.ctx.expectedEdit, form);
    assert.equal(h.node('et-save').disabled, true); assert.equal(h.node('et-cancel').disabled, true); await flush(); assert.equal(h.rpcCalls.length, 1);
    d.resolve(success(h)); await flush();
    assert.equal(h.ctx.EQ[CODE].records[0].expectedAt, NEW_DUE); assert.equal(h.ctx.expectedEdit, null);
    assert.deepEqual(h.effects, [{ type: 'list' }, { type: 'detail', code: CODE, cached: true }]);
});
test('UI dedicated clear explicitly submits empty string', async () => {
    const h = create(); h.rpc(() => success(h, '')); openExpected(h, 'open', ''); h.ctx.submitExpected(); await flush();
    assert.equal(h.rpcCalls[0].args.p_expected, ''); assert.equal(h.ctx.EQ[CODE].records[0].expectedAt, '');
});
test('UI dedicated late response after leaving cannot overwrite cache or navigate back', async () => {
    const h = create(), before = plain(h.ctx.EQ), d = deferred(); h.rpc(() => d.promise); openExpected(h); h.ctx.submitExpected(); await flush();
    h.ctx.switchView('list'); assert.equal(h.ctx.expectedEdit, null); d.resolve(success(h)); await flush();
    assert.deepEqual(plain(h.ctx.EQ), before); assert.deepEqual(h.effects, []); assert.equal(h.node('view-expected').classList.contains('show'), false);
});
test('UI dedicated late response after token change or role downgrade cannot restore cache/navigation', async () => {
    for (const role of ['admin', 'reporter']) {
        const h = create(), before = plain(h.ctx.EQ), d = deferred(); h.rpc(() => d.promise); openExpected(h); h.ctx.submitExpected(); await flush();
        h.identity(role, 'SYNTHETIC-replaced-token'); d.resolve(success(h)); await flush();
        assert.deepEqual(plain(h.ctx.EQ), before); assert.deepEqual(h.effects, []); assert.equal(h.rpcCalls.length, 1);
    }
});
test('UI stale dedicated form cannot submit after session token changes before click', async () => {
    const h = create(); h.rpc(() => success(h)); openExpected(h);
    h.identity('admin', 'SYNTHETIC-replaced-before-click'); h.ctx.submitExpected(); await flush();
    assert.equal(h.rpcCalls.length, 0, 'A form opened by the previous token must not write under the replacement identity');
    assert.deepEqual(h.effects, []);
});
for (const form of ['expected', 'reply']) {
    test('UI queued ' + form + ' write rechecks captured token before dispatch, not only on response', async () => {
        const h = create(); h.rpc(() => form === 'expected' ? success(h) : { ok: true });
        if (form === 'expected') { openExpected(h); h.ctx.submitExpected(); }
        else { h.ctx.openReplyForm('open'); h.node('rp-text').value = 'SYNTHETIC reply'; h.ctx.submitReply(); }
        h.identity('admin', 'SYNTHETIC-replaced-before-dispatch'); await flush();
        assert.equal(h.rpcCalls.length, 0, form + ': queued write must not be sent with a replacement token');
        assert.deepEqual(h.effects, []);
    });
}
test('UI dedicated unknown/transport/malformed results cannot be resent from same form', async () => {
    const responses = [null, { ok: false, uncertain: true, msg: 'SYNTHETIC unknown result' }, { ok: false, msg: 'SYNTHETIC network', code: 'SYNTHETIC-unknown' },
        { ok: true, code: 'SYNTHETIC-wrong-code', equipment: { records: [] } }, { ok: true, code: CODE, equipment: {} }, 'reject'];
    for (const response of responses) {
        const h = create(), before = plain(h.ctx.EQ); h.rpc(() => response === 'reject' ? Promise.reject(new Error('SYNTHETIC transport failure')) : response);
        openExpected(h); h.ctx.submitExpected(); await flush();
        assert.equal(h.ctx.expectedEdit.uncertain, true, JSON.stringify(response)); assert.equal(h.node('et-save').disabled, true);
        h.ctx.submitExpected(); await flush(); assert.equal(h.rpcCalls.length, 1); assert.deepEqual(plain(h.ctx.EQ), before); assert.deepEqual(h.effects, []);
    }
});
test('UI missing incremental RPC shows deployment message and never falls back to whole-device save', async () => {
    const h = create(); h.rpc(() => ({ ok: false, code: 'PGRST202', msg: 'SYNTHETIC missing RPC' })); openExpected(h); h.ctx.submitExpected(); await flush();
    assert.match(h.node('toast').textContent, /增量SQL/); assert.deepEqual(h.rpcCalls.map(c => c.name), ['equipment_set_expected']); assert.deepEqual(h.effects, []);
});
test('UI reply busy blocks duplicates, late response after leave/token change cannot refresh another identity', async () => {
    for (const action of ['leave', 'token']) {
        const h = create(), d = deferred(); h.rpc(() => d.promise); h.ctx.openReplyForm('open'); h.node('rp-text').value = 'SYNTHETIC reply';
        h.ctx.submitReply(); h.ctx.submitReply(); await flush(); assert.equal(h.rpcCalls.length, 1); assert.equal(h.node('reply-save').disabled, true);
        if (action === 'leave') h.ctx.switchView('list'); else h.identity('admin', 'SYNTHETIC-new-token');
        d.resolve({ ok: true }); await flush(); assert.deepEqual(h.effects, []);
    }
});
test('UI reply uncertain result prevents duplicate resend', async () => {
    const h = create(); h.rpc(() => { throw new Error('SYNTHETIC lost reply response'); }); h.ctx.openReplyForm('open'); h.node('rp-text').value = 'SYNTHETIC reply';
    h.ctx.submitReply(); await flush(); assert.equal(h.ctx.replyUncertain, true); assert.equal(h.node('reply-save').disabled, true);
    h.ctx.submitReply(); await flush(); assert.equal(h.rpcCalls.length, 1); assert.deepEqual(h.effects, []);
});

test('maintenance form warns before clearing supplier and submits only the selected mode data', async () => {
    const h = create('admin');
    const record = h.ctx.EQ[CODE].records.find(r => r.id === 'done');
    Object.assign(record, { repairMode: 'outer', supplier: 'SYN supplier', action: 'SYN action', delayReason: 'SYN delay reason' });
    const submitted = [];
    h.ctx.EquipApi.save = (code, data) => {
        const saved = data.records.find(r => r.id === 'done');
        submitted.push([saved.repairMode, saved.supplier]);
        return Promise.resolve({ ok: true });
    };
    h.ctx.openRecordForm('done');
    h.node('rf-mode').value = 'inner'; h.ctx.updateRecordSupplierFields();
    assert.equal(h.node('rf-supplier-clear').hidden, false);
    assert.equal(h.node('rf-supplierWrap').style.display, 'none');
    h.node('rf-mode').value = 'outer'; h.ctx.updateRecordSupplierFields();
    assert.equal(h.node('rf-supplier').value, 'SYN supplier');
    assert.equal(h.node('rf-supplier-missing').hidden, true);
    h.ctx.saveRecord(); await Promise.resolve();
    h.node('rf-supplier').value = '   '; h.ctx.updateRecordSupplierFields();
    assert.equal(h.node('rf-supplier-missing').hidden, false);
    h.ctx.saveRecord(); await Promise.resolve();
    h.node('rf-supplier').value = 'SYN restored supplier';
    h.node('rf-mode').value = 'inner'; h.ctx.updateRecordSupplierFields();
    h.ctx.saveRecord(); await Promise.resolve();
    assert.deepEqual(submitted, [['outer', 'SYN supplier'], ['outer', ''], ['inner', '']]);
});

(async function run() {
    let passed = 0, failed = 0;
    for (const { name, fn } of tests) {
        try { await fn(); passed++; console.log('PASS ' + name); }
        catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
    }
    console.log('Expected time API/app VM: ' + passed + ' passed / ' + failed + ' failed (' + tests.length + ' scenarios; synthetic data; no network or production seed)');
    if (failed) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
