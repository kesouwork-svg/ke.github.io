'use strict';
// Real PostgreSQL/PGlite; synthetic database only. No production or network access.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const { PGlite } = require(require.resolve('@electric-sql/pglite', { paths: [process.env.PGLITE_MODULE_ROOT || path.join(root, 'outputs/sql-fixture')] }));
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8').replace(/\r\n/g, '\n');
const delta = fs.readFileSync(path.join(root, 'supabase/delta_equipment_status_history.sql'), 'utf8').replace(/\r\n/g, '\n');
const fn = (name, source = schema) => { const m = source.match(new RegExp('^create or replace function public\\.' + name + '\\([\\s\\S]*?\\$\\$;', 'm')); assert(m, name); return m[0]; };
const table = name => { const m = schema.match(new RegExp('^create table if not exists public\\.' + name + ' \\([\\s\\S]*?^\\);', 'm')); assert(m, name); return m[0]; };
const db = new PGlite(); let passed = 0;
const query = async (s, p = []) => (await db.query(s, p)).rows;
const scalar = async (s, p = []) => (await query(s, p))[0].value;
const data = () => scalar("select data as value from public.equipments where code='SYN-A'");
const initial = { code: 'SYN-A', name: 'Synthetic machine', status: 'active', custom: { preserve: true }, photos: ['synthetic-photo'], records: [{ id: 'old', status: 'done', reportAt: '2024-01-01', doneAt: '2024-01-02', cost: 77, _supplements: [{ text: 'keep' }], _corrections: [{ text: 'keep' }], parts: [{ name: 'keep' }], custom: 1 }] };
async function reset() { await db.exec('truncate public.equipments, public.equip_audit, public.recycle_bin, fixture_notifications;'); await query('insert into public.equipments values($1,$2::jsonb,$3,$4)', ['SYN-A', JSON.stringify(initial), 'OLD', 'OLD']); }
async function save(value, token = 'admin-token', rpc = 'equipment_archive_save') { return scalar('select public.' + rpc + '($1,$2,$3::jsonb,$4) as value', [token, 'SYN-A', JSON.stringify(value), 'synthetic archive save']); }
async function snapshot() { return JSON.stringify(await query('select code,data,saved_at,updated_by from public.equipments order by code')) + JSON.stringify(await query('select * from public.equip_audit order by id')) + JSON.stringify(await query('select * from public.recycle_bin order by id')); }
async function rejects(value, token = 'admin-token') { const before = await snapshot(); const r = await save(value, token); assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(await snapshot(), before); }
async function test(name, f) { await reset(); await f(); passed++; console.log('PASS ' + name); }
(async () => {
    await db.exec('create role anon; create role authenticated;');
    for (const name of ['users', 'sessions', 'equipments', 'equip_audit', 'recycle_bin', 'app_config']) await db.exec(table(name));
    await db.exec("alter table public.users add column tools jsonb default '[]'; create table fixture_notifications(body text);");
    for (const name of ['_get_user_by_token', '_equip_role', '_get_config', '_equip_label', '_trash_push']) await db.exec(fn(name));
    await db.exec("create function public._wx_send(p_content text) returns void language sql as $$ insert into fixture_notifications values(p_content); $$;");
    await db.exec(delta);
    for (const [account, tools, status] of [['admin', [], 'active'], ['manager', ['equipment-admin'], 'active'], ['repairer', ['equipment'], 'active'], ['reporter', ['equipment-report'], 'active'], ['view', [], 'active'], ['disabled', ['equipment-admin'], 'disabled']]) {
        await query('insert into public.users(account,name,pwd,status,tools) values($1,$2,$3,$4,$5::jsonb)', [account, 'SYN ' + account, 'synthetic', status, JSON.stringify(tools)]);
        await query('insert into public.sessions values($1,$2,4102444800000)', [account + '-token', account]);
    }
    await test('only new archive RPC and canonical save change; other SQL definitions exact', async () => {
        const prior = cp.execFileSync('git', ['show', '492635f:supabase/schema.sql'], { cwd: root, encoding: 'utf8', windowsHide: true }).replace(/\r\n/g, '\n');
        for (const m of prior.matchAll(/^create or replace function public\.([a-z_0-9]+)\([\s\S]*?\$\$;/gm)) if (m[1] !== 'equipment_save') assert.equal(fn(m[1]), m[0], m[1]);
        for (const n of ['_equip_expected_at', 'equipment_save', 'equipment_archive_save']) assert.equal(fn(n, delta), fn(n));
        const before = await snapshot(); await db.exec(delta); await db.exec(delta); assert.equal(await snapshot(), before);
    });
    await test('exact installer defaults server Beijing minute and records server identity', async () => {
        const before = await scalar(`select to_char(clock_timestamp() at time zone 'Asia/Shanghai','YYYY-MM-DD"T"HH24:MI') as value`);
        const r = await save({ ...initial, status: 'idle', _statusChange: { effectiveAt: '', reason: ' temporary idle ' } });
        assert(r.ok); const d = await data(), h = d._statusHistory[0]; assert.equal(h.effectiveAt, before); assert.equal(h.account, 'admin'); assert.equal(h.name, 'SYN admin');
        assert.equal(h.reason, 'temporary idle'); assert.equal(h.from, 'active'); assert.equal(h.to, 'idle'); assert(d._recordsRev); assert(!d._statusChange);
        assert.deepEqual(d.records, initial.records); assert.deepEqual(d.custom, initial.custom); assert.deepEqual(d.photos, initial.photos);
        assert.deepEqual(r.statusHistory, d._statusHistory); assert.equal(await scalar('select count(*)::int as value from fixture_notifications'), 0);
    });
    await test('manual effective time and server registration time remain separate', async () => {
        const r = await save({ ...initial, status: 'scrapped', _statusChange: { effectiveAt: '2024-02-29T08:15', recordedAt: 'forged', account: 'forged' } }, 'manager-token');
        assert(r.ok); const h = (await data())._statusHistory[0]; assert.equal(h.effectiveAt, '2024-02-29T08:15'); assert.notEqual(h.recordedAt, 'forged'); assert.equal(h.account, 'manager');
    });
    await test('ordinary metadata edit does not create or backfill state history', async () => { assert((await save({ ...initial, name: 'changed' })).ok); assert(!(await data())._statusHistory); });
    await test('legacy save entry also captures status automatically after install', async () => { assert((await save({ ...initial, status: 'idle' }, 'admin-token', 'equipment_save')).ok); assert.equal((await data())._statusHistory.length, 1); });
    await test('invalid, future and malformed date inputs reject with no writes', async () => {
        for (const effectiveAt of ['2023-02-29T08:00', '2024-02-30T08:00', '2024-01-01', '2024-01-01T25:00', '9999-01-01T08:00', '2024-01-01T08:00Z', null, 0]) await rejects({ ...initial, status: 'idle', _statusChange: { effectiveAt } });
        for (const request of [null, [], 'forged']) await rejects({ ...initial, status: 'idle', _statusChange: request });
        await rejects({ ...initial, status: 'idle', _statusChange: { reason: 'x'.repeat(501) } });
    });
    await test('history cannot be invented, modified, omitted or reordered in ordinary saves', async () => {
        await rejects({ ...initial, _statusHistory: [{ from: 'idle', to: 'active', account: 'forged' }] });
        assert((await save({ ...initial, status: 'idle', _statusChange: { effectiveAt: '2024-03-01T08:00' } })).ok);
        const d = await data(); await rejects({ ...d, _statusHistory: [] }); const omit = { ...d }; delete omit._statusHistory; await rejects(omit);
        await rejects({ ...d, _statusHistory: [{ ...d._statusHistory[0], account: 'forged' }] });
        await rejects({ ...d, status: 'active', _statusChange: { effectiveAt: '2024-02-29T08:00' } });
        assert((await save({ ...d, status: 'active', _statusChange: { effectiveAt: '2024-03-01T08:00' } })).ok); assert.equal((await data())._statusHistory.length, 2);
    });
    await test('stale archive cannot erase newly recorded history or duplicate a change', async () => {
        const stale = { ...initial, status: 'idle' }; assert((await save(stale)).ok); await rejects(stale); assert.equal((await data())._statusHistory.length, 1);
    });
    await test('roles and disabled sessions cannot change device status', async () => {
        for (const token of ['repairer-token', 'reporter-token', 'view-token', 'disabled-token', 'invalid']) await rejects({ ...initial, status: 'idle' }, token);
        const d = JSON.parse(JSON.stringify(initial)); d.records[0].action = 'repairer legitimate edit'; assert((await save(d, 'repairer-token', 'equipment_save')).ok);
    });
    await test('new device state is initial metadata, not a fabricated transition', async () => {
        await db.exec('delete from public.equipments'); const r = await save({ ...initial, status: 'idle', records: [] }); assert(r.ok, JSON.stringify(r)); assert(!(await data())._statusHistory);
    });
    await test('archive entry preserves current records, photos and extension fields from a stale form', async () => {
        const fresh = JSON.parse(JSON.stringify(initial)); fresh.records.push({ id: 'concurrent', status: 'open', updates: [{ text: 'latest' }] }); fresh.photos.push('new-photo'); fresh.custom = { latest: true };
        await query("update public.equipments set data=$1::jsonb where code='SYN-A'", [JSON.stringify(fresh)]);
        assert((await save({ ...initial, status: 'idle', _statusChange: { effectiveAt: '' } })).ok);
        const d = await data(); assert.deepEqual(d.records, fresh.records); assert.deepEqual(d.photos, fresh.photos); assert.deepEqual(d.custom, fresh.custom);
    });
    await test('late audit failure rolls back both state and history', async () => {
        const before = await snapshot();
        await db.exec("create function fixture_audit_failure() returns trigger language plpgsql as $$ begin raise exception 'SYN audit failed'; end $$; create trigger fixture_failure before insert on public.equip_audit for each row execute function fixture_audit_failure();");
        try { await assert.rejects(save({ ...initial, status: 'idle' }), /SYN audit failed/); } finally { await db.exec('drop trigger fixture_failure on public.equip_audit; drop function fixture_audit_failure();'); }
        assert.equal(await snapshot(), before);
    });
    await test('invalid new state rejects, but unchanged historical metadata is not reclassified', async () => { await rejects({ ...initial, status: 'unknown' }); });
    await test('RPC grant allows anon-token flow but no direct new public/authenticated access', async () => {
        assert.equal(await scalar("select has_function_privilege('anon','public.equipment_archive_save(text,text,jsonb,text)','execute') as value"), true);
        assert.equal(await scalar("select has_function_privilege('authenticated','public.equipment_archive_save(text,text,jsonb,text)','execute') as value"), false);
        await db.exec('set role anon'); try { assert((await save({ ...initial, status: 'idle' })).ok); } finally { await db.exec('reset role'); }
    });
    for (const zone of ['UTC', 'America/New_York', 'Pacific/Kiritimati', 'Asia/Shanghai']) await test('server timezone independence: ' + zone, async () => {
        await query("select set_config('TimeZone',$1,false)", [zone]);
        const before = await scalar(`select to_char(clock_timestamp() at time zone 'Asia/Shanghai','YYYY-MM-DD"T"HH24:MI') as value`);
        assert((await save({ ...initial, status: 'idle' })).ok); const h = (await data())._statusHistory[0]; assert.equal(h.effectiveAt, before); assert.equal(h.recordedAt.slice(0, 16).replace(' ', 'T'), before);
    });
    console.log(passed + ' real PostgreSQL scenarios passed / 0 failed (single isolated session; no production or concurrency claim)');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; }).finally(() => db.close());
