// Offline source/migration contracts. Actual PostgreSQL cases: outputs/sql-fixture/test-daily-todo-all-open.mjs.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');process.chdir(root);let passed=0;
const read=p=>fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n'),sql=read('supabase/schema.sql'),delta=read('supabase/delta_daily_todo_all_open.sql');
const base='61deb737e5c2b295cfe104182e9b2a144acef9fd',git='D:\\AI\\Git\\cmd\\git.exe',old=cp.execFileSync(git,['show',base+':supabase/schema.sql'],{encoding:'utf8',cwd:root}).replace(/\r\n/g,'\n');
function check(name,fn){fn();passed++;console.log('[PASS] '+name)}
const names=['_equip_todo_msg','equip_daily_push'];
function definition(s,name){const m=s.match(new RegExp('^create or replace function public\\.'+name+'\\([\\s\\S]*?\\$\\$;','m'));assert(m,name);return m[0]}
const msg=definition(sql,names[0]),push=definition(sql,names[1]),strip=s=>s.replace(/^--.*$/gm,'').trim();
check('delta contains exactly the two original signatures',()=>assert.deepEqual([...delta.matchAll(/^create or replace function public\.([a-z_]+)\(/gm)].map(x=>x[1]),names));
for(const name of names)check('canonical equals delta: '+name,()=>assert.equal(definition(delta,name),definition(sql,name)));
check('migration does not run either sender or a test',()=>{let rest=delta;for(const n of names)rest=rest.replace(definition(rest,n),'');assert.equal(strip(rest).replace(/\s/g,'').toLowerCase(),'begin;commit;')});
check('no table, cron, ACL, new helper or data mutation statements',()=>assert(!/\b(?:insert\s+into|update\s+public\.|delete\s+from|truncate|grant|revoke|alter\s+table|create\s+extension|cron\.schedule|cron\.unschedule)\b/i.test(strip(delta))));
check('all other canonical logic is byte-equivalent after LF normalization',()=>{const stable=s=>{for(const n of names)s=s.replace(definition(s,n),'[same-original-signature]');return s.replace(/^-- (?:每日待办|规则:).*$/gm,'')};assert.equal(stable(sql),stable(old))});
check('migration never reschedules; optional local cron remains weekday08',()=>{assert(!/cron\.(?:schedule|unschedule)\s*\(/i.test(strip(delta)));if(fs.existsSync('supabase/daily_todo_cron.sql')){const cron=read('supabase/daily_todo_cron.sql');assert(cron.includes("'0 0 * * 1-5'"));assert(cron.includes('select public.equip_daily_push();'))}});
check('message builder has no send call',()=>assert(!msg.includes('public._wx_send')));
check('scheduled push retains exactly one existing send call',()=>assert.equal((push.match(/perform public\._wx_send\(/g)||[]).length,1));
check('weekday and empty skips remain',()=>{assert(push.includes("'skipped', 'weekend'"));assert(push.includes("'skipped', 'empty'"))});
check('both functions use the same explicit Shanghai day',()=>assert.equal((delta.match(/\(now\(\) at time zone 'Asia\/Shanghai'\)::date/g)||[]).length,2));
check('no GEN or department exclusion',()=>assert(!/e\.code\s*(?:not\s+like|<>|!=)|e\.data->>'line'\s*=|e\.data->>'category'\s*=/i.test(msg)));
check('old non-empty/due-date selection gate is removed',()=>{assert(!msg.includes("coalesce(r->>'expectedAt', '') <> ''"));assert(!msg.includes("(r->>'expectedAt')::date <= d"))});
check('record containers and entries are type guarded',()=>{assert(msg.includes("jsonb_typeof(e.data->'records') = 'array'"));assert(msg.includes("jsonb_typeof(r) = 'object'"))});
check('bad progress data cannot require jsonb_array_length on a scalar',()=>assert(msg.includes("if jsonb_typeof(ups) = 'array' then\n      if jsonb_array_length(ups) > 0 then")));
check('five category keys and original return keys are present',()=>{for(const k of ['msg','total','overdue','due_today','upcoming','unscheduled','date_unknown','shown'])assert(msg.includes("'"+k+"'"),k)});
check('invalid dates handled per record, not cast in SQL selection',()=>{assert(msg.includes('exception when invalid_datetime_format or datetime_field_overflow'));assert(msg.includes("one := '预计日期待核'"))});
check('total is counted before date classification and display limit',()=>{assert(msg.indexOf('total := total + 1;')<msg.indexOf("raw_date :="));assert(msg.includes('limit 5'));assert(msg.includes('if total > shown then'))});
check('unknown schedule is distinct from overdue and future',()=>{assert(msg.includes("one := '未排期（未设置预计日期）'"));assert(msg.includes("elsif exp < d then"));assert(msg.includes('elsif exp = d then'));assert(msg.includes("one := '未到期 · 预计 '"))});
check('display cap is disclosed and link uses full total',()=>{assert(msg.includes("'仅列前 ' || shown"));assert(msg.includes("查看全部 ' || total || ' 单未完成]('"));assert(msg.includes("link := base || '?todo=1'"))});
check('empty test sample is internally consistent',()=>{assert(msg.includes('total := 5; shown := 5;'));assert(msg.includes('overdue := 2; due_today := 1; unscheduled := 1; upcoming := 1;'));assert.equal((msg.match(/DEMO-0[1-5]/g)||[]).length,5)});
check('manual test authentication and sender are untouched',()=>assert.equal(definition(sql,'equip_daily_test'),definition(old,'equip_daily_test')));
check('notification transport is untouched',()=>assert.equal(definition(sql,'_wx_send'),definition(old,'_wx_send')));
const app=read('docs/equipment/js/equipment-app.js'),doneFn=app.match(/^function isDone\(r\) \{[^\n]*\}/m);assert(doneFn);const sandbox={};vm.runInNewContext(doneFn[0],sandbox);
for(const [name,r,want]of [['explicit open before done date',{status:'open',doneAt:'2026-10-01'},false],['explicit done without date',{status:'done',doneAt:''},true],['empty status uses done date',{status:'',doneAt:'2026-10-01'},true],['missing both is unfinished',{},false],['pending custom status is unfinished',{status:'pending',doneAt:''},false],['false status falls back',{status:false,doneAt:'2026-10-01'},true],['zero status falls back',{status:0,doneAt:''},false],['array done date is JS truthy',{doneAt:[]},true]])check('real APP state oracle: '+name,()=>assert.equal(sandbox.isDone(r),want));
console.log('\nDaily todo all-open contracts: '+passed+' passed / 0 failed (offline source/APP contracts, not SQL execution or delivery)');
