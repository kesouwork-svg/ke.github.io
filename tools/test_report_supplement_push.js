// Offline notification contract/API regression; actual SQL delivery intent is tested separately in PGlite.
// Run: node tools/test_report_supplement_push.js. No network, login, messages or printing.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8').replace(/\r\n/g,'\n');
const schema=read('supabase/schema.sql'),delta=read('supabase/delta_report_supplement_push.sql');
const api=read('docs/equipment/js/equipment-api.js'),app=read('docs/equipment/js/equipment-app.js'),html=read('docs/equipment/index.html');
let passed=0;
function check(name,value){assert.ok(value,name);passed++;}
function eq(name,value,expected){assert.deepEqual(value,expected,name);passed++;}
function rpc(sql){const m=sql.match(/^create or replace function public\.equipment_report_supplement\([\s\S]*?^end \$\$;/mi);assert.ok(m,'supplement RPC exists');return m[0];}
async function main(){
 const f=rpc(schema),migration=rpc(delta),notify=f.slice(f.indexOf('-- 仅成功追加后'));
 eq('migration exactly matches authoritative RPC',migration,f);
 eq('single migration function',(delta.match(/^create or replace function /gmi)||[]).length,1);
 check('whole migration transaction',/^begin;$/m.test(delta)&&/commit;\s*$/.test(delta));
 check('migration has no historical data rewrite',!/^\s*(update|insert into|delete from|drop|alter table)\b/mi.test(delta.slice(0,delta.indexOf('create or replace function'))));
 check('same four-argument public signature',/p_token text, p_code text, p_record_id text, p_text text\)/.test(f));
 check('definer has fixed safe search path',/security definer set search_path = public, pg_temp/.test(f));
 check('existing anonymous execution grant',/grant execute on function public\.equipment_report_supplement\(text,\s*text,\s*text,\s*text\) to anon;/.test(delta));
 check('anonymous guard before reading equipment',f.indexOf('if cu.account is null')<f.indexOf('select e.data'));
 check('only administrator/reporter append',f.includes("role not in ('admin', 'reporter')"));
 check('reporter own-workshop restriction remains',f.includes("coalesce(d->>'line', '') <> trim(cu.dept)"));
 check('completed reporter restriction remains',f.includes("coalesce(rec->>'status', '') = 'done' or coalesce(rec->>'doneAt', '') <> ''"));
 check('full Unicode codepoint input bound',f.includes('char_length(text_txt) > 2000'));
 check('device lock remains',/where e\.code = p_code for update/.test(f));
 check('unique original record remains required',f.includes('if matches <> 1 then'));
 check('append-only history and fresh revision remain',f.includes("coalesce(rec->'_supplements', '[]'::jsonb) || jsonb_build_array(entry)")&&f.includes("'_recordsRev', gen_random_uuid()::text"));
 const write=f.indexOf('update public.equipments'),audit=f.indexOf('insert into public.equip_audit'),send=f.indexOf('perform public._wx_send(msg)');
 check('write and successful audit precede notification',write>=0&&audit>write&&send>audit);
 eq('one canonical sender call site',(f.match(/perform\s+public\._wx_send\s*\(/gi)||[]).length,1);
 check('no new report/reply/save/number/trash side effect',!/public\.(?:equipment_report|equipment_reply|equipment_save|_equip_next_no|_trash_push)\s*\(/i.test(f));
 check('reuse sender without reading/copying webhook',!notify.includes('wx_webhook')&&!/net\.http_post/.test(f));
 check('dedicated supplement heading',notify.includes('【报修补充】'));
 check('uses original number and URL keys',notify.includes("wo := coalesce(rec->>'no', '')")&&notify.includes("'?code=' || code_url")&&notify.includes("'&wo=' || wo_url"));
 check('equipment object and location included',notify.includes('public._equip_label(d)')&&notify.includes("rec->>'devName'")&&notify.includes("rec->>'place'"));
 check('current text and authenticated author/time included',notify.includes('text_txt, left(entry->>\'by\'')&&notify.includes("|| at_txt ||"));
 check('does not resend historical notes',!notify.includes('_supplements')&&!notify.includes('jsonb_array_elements'));
 check('safe original-record URL encoding',notify.includes("convert_to(raw, 'UTF8')")&&notify.includes('get_byte(raw_bytes, i)')&&notify.includes("'%' || upper(lpad(to_hex(b), 2, '0'))"));
 check('HTTPS default and bounded link',notify.includes('^https://')&&notify.includes("base := 'https://kekits.com/equipment/'")&&notify.includes('octet_length(link) > 1024'));
 check('UTF8-safe message preview has full-record disclosure',notify.includes('4096 - octet_length(heading || ending)')&&notify.includes('char_length(preview)')&&notify.includes('完整补充请查看原工单'));
 check('completed administrator append does not reopen record',notify.includes('不重开工单')&&!/status.*:=/.test(notify));
 const hint=html.match(/id="rs-hint">([^<]+)</)[1];
 check('UI explains successful supplement notification',/成功保存后.*群里推送.*报修补充/.test(hint));
 check('UI explains preview, original order and no new order',hint.includes('摘要')&&hint.includes('原工单')&&hint.includes('不新建工单'));
 check('removed stale no-notification promise',!hint.includes('不另发群通知'));
 check('UI does not claim delivery receipt',!hint.includes('已送达')&&!hint.includes('发送成功'));
 const submit=app.slice(app.indexOf('function submitReportSupplement()'),app.indexOf('// ---------- 报修更正'));
 check('UI pending/uncertain guards remain',submit.includes('c.busy || c.uncertain')&&submit.includes('c.busy = true; setReportSupplementBusy(true)'));
 check('UI still calls only dedicated append API',submit.includes('EquipApi.supplementReport(c.code, c.id, text)')&&!submit.includes('EquipApi.save'));
 check('uncertain submission requires verification, not automatic replay',submit.includes('c.uncertain = true')&&submit.includes('勿重复提交')&&!/setTimeout|setInterval/.test(submit));
 check('completion registration still shows saved clues',app.includes('h += renderSupplements(rec);'));
 const calls=[],storage=new Map();
 const c={console,location:{search:''},window:{},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},fetch:()=>{throw Error('Network forbidden')}};
 vm.createContext(c);vm.runInContext(api,c,{filename:'equipment-api.js'});
 c._demoSession={token:'synthetic-token',account:'fixture-reporter',name:'Fixture reporter',tools:['equipment-report'],dept:'模具部'};
 c.eqRpc=(name,p)=>{calls.push({name,p:JSON.parse(JSON.stringify(p))});return Promise.resolve({ok:true})};
 for(const value of [undefined,null,1,false,{},[], '', ' \t\n　']){const out=await c.EquipApi.supplementReport('CODE','r1',value);eq('empty/nonstring text rejected offline',out.ok,false)}
 eq('rejected input never calls RPC',calls.length,0);
 await c.EquipApi.supplementReport('E &#+中','id-1','  本次补充  ');
 eq('valid append calls one original RPC',calls.length,1);
 eq('cloud request has exactly original four keys',Object.keys(calls[0].p).sort(),['p_code','p_record_id','p_text','p_token']);
 eq('cloud request is same token/code/id and trimmed body',calls[0],{name:'equipment_report_supplement',p:{p_token:'synthetic-token',p_code:'E &#+中',p_record_id:'id-1',p_text:'本次补充'}});
 await c.EquipApi.supplementReport('CODE','r1','😀'.repeat(2000));eq('2000 Unicode codepoints accepted',calls.length,2);
 eq('2001 Unicode codepoints rejected',(await c.EquipApi.supplementReport('CODE','r1','😀'.repeat(2001))).ok,false);
 eq('oversize input never dispatches',calls.length,2);
 let failures=0;c.eqRpc=()=>{failures++;return Promise.reject(Error('synthetic network failure'))};
 await assert.rejects(c.EquipApi.supplementReport('CODE','r1','不能自动重发'),/synthetic network failure/);passed++;
 await Promise.resolve();await Promise.resolve();eq('cloud adapter does not automatically retry',failures,1);
 eq('cloud append never writes local equipment or audit',storage.size,0);
 console.log(passed+' passed / 0 failed (offline notification contract/API; not a delivery test)');
}
main().catch(e=>{console.error(e);process.exitCode=1});
