'use strict';
// Permanent source/migration contracts only. Real PostgreSQL behavior is covered by the isolated fixture.
const fs=require('fs'),path=require('path'),cp=require('child_process'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');process.chdir(root);
const read=p=>fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n');
const base='333b1e27b3eebef0e4725a71cf80b4c12a062eff';
const old=cp.execFileSync('D:\\AI\\Git\\cmd\\git.exe',['show',base+':supabase/schema.sql'],{encoding:'utf8',cwd:root}).replace(/\r\n/g,'\n');
// Pin the later idempotency migration contract to that release; the new live
// state-history schema is independently tested by test_equipment_status_history_sql.js.
const current=cp.execFileSync('git',['show','492635f:supabase/schema.sql'],{encoding:'utf8',cwd:root,windowsHide:true}).replace(/\r\n/g,'\n');
const schema=cp.execFileSync('D:\\AI\\Git\\cmd\\git.exe',['show','27b61340b062d2db873427b8d95b894528842528:supabase/schema.sql'],{encoding:'utf8',cwd:root}).replace(/\r\n/g,'\n'),delta=read('supabase/delta_equipment_beijing_time.sql');
const changed=['_equip_next_no','equip_group_order_set','equip_cat_rename','_equip_ensure_generic','equipment_report_correct','equipment_report_supplement','equipment_save','equipment_reply','equipment_delete','admin_restore_device','equip_trash_restore'];
const dependencies=['_equip_expected_at','equipment_set_expected','equipment_report','_equip_todo_msg','equip_daily_push'];
const required=[...changed,...dependencies];
function definitions(s){return new Map([...s.matchAll(/^create or replace function public\.([a-z_0-9]+)\([\s\S]*?\$\$;/gmi)].map(m=>[m[1],m[0]]));}
const prior=definitions(old),now=definitions(schema),install=definitions(delta);let passed=0;
function check(name,fn){fn();passed++;console.log('PASS '+name);}
const transformed=s=>s.replace(/to_char\(now\(\),/g,"to_char(now() at time zone 'Asia/Shanghai',").replace(/to_char\(clock_timestamp\(\),/g,"to_char(clock_timestamp() at time zone 'Asia/Shanghai',");
check('canonical function set/signatures are unchanged',()=>assert.deepEqual([...now.keys()],[...prior.keys()]));
for(const name of changed)check('only explicit clock formatting changes: '+name,()=>{assert(prior.has(name));assert.notEqual(transformed(prior.get(name)),prior.get(name),'Expected a known implicit clock in baseline');assert.equal(now.get(name),transformed(prior.get(name)));});
check('all other canonical functions retain their exact logic and permissions',()=>{for(const [name,body] of prior)if(!changed.includes(name))assert.equal(now.get(name),body,name);});
check('tables, ACLs and other top-level canonical content stay exact',()=>{let a=old,b=schema;for(const n of changed){a=a.replace(prior.get(n),'/* '+n+' */');b=b.replace(now.get(n),'/* '+n+' */');}assert.equal(b,a);});
check('cumulative delta contains exactly the 16 intended definitions',()=>assert.deepEqual([...install.keys()].sort(),required.slice().sort()));
for(const name of required)check('installed definition equals canonical: '+name,()=>assert.equal(install.get(name),now.get(name)));
check('delta only installs definitions and the already-authorized expected RPC grant',()=>{let s=delta;for(const body of install.values())s=s.replace(body,'');s=s.replace(/^\s*--[^\n]*(?:\n|$)/gm,'').trim();assert.match(s,/^begin;\s*grant execute on function public\.equipment_set_expected\(\s*text\s*,\s*text\s*,\s*text\s*,\s*text\s*\) to anon;\s*commit;$/i);});
check('dependencies are installed before the corresponding callers',()=>{for(const n of ['equipment_set_expected','equipment_save','equipment_reply','_equip_todo_msg'])assert(delta.indexOf(install.get('_equip_expected_at'))<delta.indexOf(install.get(n)),n);assert(delta.indexOf(install.get('_equip_next_no'))<delta.indexOf(install.get('equipment_report')));});
check('no session/global timezone, cron or schema mutation is introduced',()=>{assert(!/set_config\s*\(\s*'TimeZone'|\bset\s+(?:local\s+)?time\s*zone\b|alter\s+(?:database|role|table)|cron\.(?:schedule|unschedule)/i.test(delta));});
check('report, progress and supplement use explicit Beijing formatting without labels',()=>{for(const n of ['equipment_report','equipment_reply','equipment_report_supplement']){const f=install.get(n);assert(!/to_char\((?:now|clock_timestamp)\(\),/.test(f),n);assert(f.includes("at time zone 'Asia/Shanghai'"),n);}assert(install.get('equipment_reply').includes("to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI')"));});
check('auth, retention and historical expected-time migration remain untouched',()=>{for(const n of ['_wx_send','_get_user_by_token','_equip_role','_trash_push','_trash_purge_expired','equip_daily_test'])assert.equal(now.get(n),prior.get(n),n);for(const n of dependencies)assert.equal(now.get(n),prior.get(n),n);});
check('current idempotency installer retains every unaffected Beijing definition',()=>{const c=definitions(current),d=definitions(read('supabase/delta_report_idempotency.sql'));for(const [name,body] of now){if(!['_equip_next_no','equipment_report'].includes(name))assert.equal(c.get(name),body,name);if(d.has(name))assert.equal(d.get(name),c.get(name),name);}assert(c.get('equipment_report_once').includes("at time zone 'Asia/Shanghai'"));assert(c.get('_equip_next_no').includes("at time zone 'Asia/Shanghai'"));});
console.log('Equipment Beijing SQL contracts: '+passed+' passed / 0 failed (offline definitions only; no deployment or real message)');
