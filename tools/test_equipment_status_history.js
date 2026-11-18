'use strict';
// Synthetic local adapter + real archive form methods. Network and hardware forbidden.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), fixed = Date.parse('2026-11-18T01:02:03Z');
let passed = 0;
function harness(role = 'admin') {
    const values = {}, els = {}, calls = [];
    const storage = { getItem: k => values[k] || null, setItem: (k, v) => { values[k] = String(v); }, removeItem: k => { delete values[k]; } };
    const el = () => ({ value: '', hidden: false, textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, addEventListener() {}, querySelector: () => null });
    class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } }
    const ctx = vm.createContext({ console, Date: FixedDate, setTimeout: () => 0, clearTimeout() {}, localStorage: storage, sessionStorage: storage, location: { search: '', pathname: '/equipment/' },
        navigator: {}, document: { getElementById: id => els[id] || (els[id] = el()), querySelectorAll: () => [], querySelector: () => null, addEventListener() {} }, addEventListener() {}, scrollTo() {},
        fetch() { throw Error('Network forbidden'); }, print() { throw Error('Print forbidden'); } });
    ctx.window = ctx;
    for (const file of ['docs/equipment/js/equipment-time.js', 'docs/js/session.js', 'docs/equipment/js/equipment-api.js', 'docs/equipment/js/equipment-app.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx, { filename: file });
    const run = text => vm.runInContext(text, ctx), plain = x => JSON.parse(JSON.stringify(x));
    run('EqConfig.cloud=false; ROLE=' + JSON.stringify(role) + '; SessionStore.write(' + JSON.stringify(JSON.stringify({ account: role, name: 'SYN ' + role, token: 'synthetic', tools: role === 'repairer' ? ['equipment'] : role === 'admin' ? ['equipment-admin'] : [] })) + ')');
    run('localSet({A:{code:"A",name:"Synthetic",status:"active",records:[],photos:[],custom:7}}); EQ=localGet(); refreshLocal=function(){};');
    return { run, ctx, els, calls, plain, data: () => plain(run('localGet().A')), save: d => ctx.EquipApi.save('A', d, 'synthetic'), field: (id, value) => { const e = ctx.document.getElementById(id); if (value !== undefined) e.value = value; return e; } };
}
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
(async () => {
    await test('archive shows time only for an actual state transition, auto Beijing clock', async () => {
        const h = harness(); h.run('openArchiveForm("A")'); assert(h.els['a-status-change'].hidden);
        h.field('a-status', 'idle'); h.run('onArchiveStatusChange()'); assert(!h.els['a-status-change'].hidden); assert.equal(h.els['a-status-at'].value, '2026-11-18T09:02');
        h.field('a-status', 'active'); h.run('onArchiveStatusChange()'); assert(h.els['a-status-change'].hidden);
    });
    await test('automatic and manual changes persist full chronology and do not alter business records', async () => {
        const h = harness(); h.run('openArchiveForm("A")'); h.field('a-status', 'idle'); h.run('onArchiveStatusChange(); saveArchive()'); await Promise.resolve();
        let d = h.data(); assert.equal(d._statusHistory[0].effectiveAt, '2026-11-18T09:02'); assert.equal(d._statusHistory[0].recordedAt, '2026-11-18 09:02:03');
        assert.equal(d._statusHistory[0].account, 'admin'); assert.equal(d.custom, 7); assert.deepEqual(d.records, []); assert(!d._statusChange);
        // A second change may have the same effective minute; order remains explicit.
        h.run('openArchiveForm("A")'); h.field('a-status', 'scrapped'); h.field('a-status-at', '2026-11-18T09:02'); h.field('a-status-reason', 'SYN reason'); h.run('archiveStatusTimeManual=true; saveArchive()'); await Promise.resolve();
        d = h.data(); assert.equal(d._statusHistory.length, 2); assert.equal(d._statusHistory[1].from, 'idle'); assert.equal(d._statusHistory[1].reason, 'SYN reason');
    });
    await test('manual past time differs from registration time and cannot move backward later', async () => {
        const h = harness(); const d = h.data(); d.status = 'idle'; d._statusChange = { effectiveAt: '2026-11-17T08:30' };
        assert((await h.save(d)).ok); let saved = h.data(); assert.equal(saved._statusHistory[0].effectiveAt, '2026-11-17T08:30'); assert.equal(saved._statusHistory[0].recordedAt, '2026-11-18 09:02:03');
        const before = JSON.stringify(saved); saved.status = 'active'; saved._statusChange = { effectiveAt: '2026-11-16T08:30' }; assert(!(await h.save(saved)).ok); assert.equal(JSON.stringify(h.data()), before);
    });
    await test('invalid and future times reject without local writes', async () => {
        for (const effectiveAt of ['2023-02-29T08:00', '2026-11-18T09:03', '2026-11-17', null, 0]) {
            const h = harness(), d = h.data(); d.status = 'idle'; d._statusChange = { effectiveAt }; const before = JSON.stringify(h.data()); assert(!(await h.save(d)).ok); assert.equal(JSON.stringify(h.data()), before);
        }
    });
    await test('ordinary editing preserves chronology without appending or permitting tampering', async () => {
        const h = harness(); assert((await h.save({ ...h.data(), status: 'idle' })).ok); const saved = h.data(); saved.name = 'changed'; assert((await h.save(saved)).ok); assert.equal(h.data()._statusHistory.length, 1);
        const forged = h.data(); forged._statusHistory = []; assert(!(await h.save(forged)).ok);
        assert(!(await h.save({ code: 'A', name: 'stale', status: 'active', records: [] })).ok);
    });
    await test('role permission and state history rendering with escaped content', async () => {
        for (const role of ['repairer', 'reporter', 'view']) { const h = harness(role); assert(!(await h.save({ ...h.data(), status: 'idle' })).ok); }
        const h = harness(); const html = h.run('renderStatusHistory({_statusHistory:[{from:"active",to:"idle",effectiveAt:"2026-11-17T08:30",recordedAt:"2026-11-18 09:02:03",name:"<img src=x>",reason:"<script>x</script>"}]})');
        assert(html.includes('2026-11-17 08:30')); assert(html.includes('2026-11-18 09:02:03')); assert(!html.includes('<img')); assert(!html.includes('<script>'));
        assert(h.run('renderStatusHistory({})').includes('不推测补填'));
    });
    await test('new cloud RPC is fail-closed when SQL is missing, no fallback write', async () => {
        const h = harness(); h.run('EqConfig.cloud=true'); h.ctx.supabase = { createClient: () => ({ rpc: (name, params) => { h.calls.push({ name, params }); return Promise.resolve({ error: { code: 'PGRST202', message: 'function missing' } }); } }) };
        const r = await h.save({ ...h.data(), status: 'idle', _statusChange: { effectiveAt: '' } }); assert.equal(r.ok, false); assert(r.msg.includes('尚未安装')); assert.deepEqual(h.calls.map(c => c.name), ['equipment_archive_save']);
    });
    await test('cloud response uses server history and revision, removes transient request', async () => {
        const h = harness(); const d = { ...h.data(), status: 'idle', _statusChange: { effectiveAt: '' } }; h.run('EqConfig.cloud=true');
        h.ctx.supabase = { createClient: () => ({ rpc: () => Promise.resolve({ data: { ok: true, recordsRev: 'SYN server rev', statusHistory: [{ account: 'server', effectiveAt: '2026-11-18T09:02' }] } }) }) };
        assert((await h.save(d)).ok); assert.equal(d._statusHistory[0].account, 'server'); assert.equal(d._recordsRev, 'SYN server rev'); assert(!d._statusChange);
    });
    console.log(passed + ' status API/UI scenarios passed / 0 failed (synthetic/offline)');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
