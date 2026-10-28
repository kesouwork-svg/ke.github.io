'use strict';
// Offline: real session/API/app scripts, no network, login, SQL execution or hardware.
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const html=read('docs/equipment/index.html');let pass=0;
function ok(name,value){if(!value)throw Error(name);pass++;}
const roles={admin:[],repairer:['equipment'],reporter:['equipment-report']};
function context(role,cloud){
 const store={'roi_session':JSON.stringify({token:'offline',account:role,name:role,level:2,tools:roles[role],dept:'模具部'}),'equip_list_v2':JSON.stringify({'PS04-10':{code:'PS04-10',name:'磨床',line:'模具部',records:[{id:'legacy',no:'OLD-01',place:'',symptom:'历史空位置',type:'fault',status:'done',doneAt:'2026-10-01'}]},'GEN-D07':{code:'GEN-D07',name:'通用报修',line:'模具部',records:[]}})};
 const els={},calls={rpc:[],report:[],toast:[],focus:[]};
 function el(id){return els[id]||(els[id]={value:'',textContent:'',innerHTML:'',style:{},classList:{add(){},remove(){},toggle(){},contains(){return false}},addEventListener(){},setAttribute(){},getAttribute(){return null},focus(){calls.focus.push(id)}});}
 const ctx={console,JSON,Date,Math,Promise,Number,String,Object,Array,RegExp,parseInt,parseFloat,isNaN,location:{search:'',href:'',hash:''},navigator:{},localStorage:{getItem:k=>store[k]??null,setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},alert(){},confirm:()=>false,prompt:()=>null,document:{getElementById:el,querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){},createElement:()=>el('created'),body:el('body')},fetch(){throw Error('NETWORK FORBIDDEN')}};
 ctx.window=ctx;ctx.sessionStorage=ctx.localStorage;ctx.addEventListener=()=>{};vm.createContext(ctx);
 for(const p of ['docs/js/session.js','docs/equipment/js/equipment-api.js','docs/equipment/js/equipment-app.js'])vm.runInContext(read(p),ctx,{filename:p});
 ctx.EqConfig.cloud=!!cloud;ctx.eqRpc=(name,args)=>{calls.rpc.push({name,args});return Promise.resolve({ok:true,no:'MOCK-ONLY'})};
 ctx.ROLE=role;ctx.currentCode='PS04-10';ctx.showToast=t=>calls.toast.push(t);
 return{ctx,store,calls,el};
}
(async()=>{
 const input=html.match(/<input\b[^>]*\bid="rp-place"[^>]*>/)[0];
 ok('location input is required',/\srequired(?:\s|>)/.test(input));
 ok('location is accessible as required',input.includes('aria-required="true"'));
 ok('required label points to field',/<label class="req" for="rp-place">设备位置<\/label>/.test(html));
 ok('optional location wording removed',!html.includes('设备位置(选填)'));
 ok('historical suggestions preserved',input.includes('list="place-pool"'));
 const invalid=[undefined,null,'',' \t\r\n　\u00a0\ufeff '];
 for(const role of Object.keys(roles))for(const place of invalid){
  const t=context(role,false),before=JSON.stringify(t.store);
  const r=await t.ctx.EquipApi.report('PS04-10',{symptom:'漏油',place});
  ok(role+' rejects blank location',r.ok===false&&r.msg==='请填写设备位置');
  ok(role+' invalid report does not change storage/audit/number',JSON.stringify(t.store)===before&&!r.no);
 }
 for(const role of Object.keys(roles))for(const code of ['PS04-10','GEN-D07']){
  const t=context(role,false),before=JSON.parse(t.store.equip_list_v2)['PS04-10'].records[0];
  const r=await t.ctx.EquipApi.report(code,{symptom:'漏油',place:'　 2栋3楼东侧 \t',expectedAt:''});
  const all=JSON.parse(t.store.equip_list_v2);
  ok(role+' can report with a valid location '+code,r.ok===true&&!!r.no);
  ok('valid location is trimmed '+role+code,all[code].records.at(-1).place==='2栋3楼东侧');
  ok('legacy empty location left unchanged '+role+code,JSON.stringify(all['PS04-10'].records[0])===JSON.stringify(before));
 }
 for(const place of invalid){
  const t=context('reporter',true),r=await t.ctx.EquipApi.report('GEN-D07',{symptom:'漏油',place});
  ok('cloud rejects blank before RPC',r.ok===false&&r.msg==='请填写设备位置'&&t.calls.rpc.length===0);
 }
 {
  const t=context('reporter',true);await t.ctx.EquipApi.report('GEN-D07',{symptom:'漏油',place:' 车间门口　',expectedAt:'',reportBy:'张三'});
  ok('cloud uses the same six-argument report RPC',t.calls.rpc.length===1&&t.calls.rpc[0].name==='equipment_report');
  ok('cloud transmits trimmed location',t.calls.rpc[0].args.p_place==='车间门口');
  ok('report keeps expected-date contract',t.calls.rpc[0].args.p_expected==='');
 }
 for(const role of Object.keys(roles))for(const place of ['', ' \t\n　 ']){
  const t=context(role,false);t.ctx.EquipApi.report=(code,payload)=>{t.calls.report.push({code,payload});return Promise.resolve({ok:false,msg:'offline stop'})};
  t.el('rp-symptom').value='漏油';t.el('rp-place').value=place;t.el('rp-reportBy').value='张三';t.ctx.submitReport();
  ok(role+' UI blocks blank report',t.calls.report.length===0&&t.calls.toast.at(-1)==='请填写设备位置');
  ok(role+' UI focuses missing field',t.calls.focus.at(-1)==='rp-place');
 }
 {
  const t=context('admin',false);t.ctx.EquipApi.report=(code,payload)=>{t.calls.report.push({code,payload});return Promise.resolve({ok:false,msg:'offline stop'})};
  t.el('rp-symptom').value='漏油';t.el('rp-place').value='  水磨组东头　';t.el('rp-reportBy').value=' 张三 ';t.ctx.submitReport();
  ok('UI forwards one validated trimmed payload',t.calls.report.length===1&&t.calls.report[0].payload.place==='水磨组东头');
  const empty=context('admin',false);empty.ctx.submitReport();ok('fault symptom remains required first',empty.calls.toast.at(-1)==='请填写故障现象');
 }
 // Historical migrations are immutable: later releases may add locking/revisions.
 // Keep checking their original location guard; compare the newest migration to canonical.
 const schema=read('supabase/schema.sql'),rx=/create or replace function public\.equipment_report\([^\n]+\)\nreturns jsonb[\s\S]*?\nend \$\$;/;
 const fn=schema.match(rx)[0],guard=fn.indexOf("if place_txt = ''");
 ok('server checks authenticated role before location',fn.indexOf("role not in ('admin', 'repairer', 'reporter')")<guard);
 ok('server rejects before allocating order number',guard>0&&guard<fn.indexOf('wo := public._equip_next_no()'));
 ok('server rejects before storage and notifications',guard<fn.indexOf('update public.equipments')&&guard<fn.indexOf('perform public._wx_send'));
 ok('server normalizes whitespace and null',fn.includes("btrim(coalesce(p_place, ''), U&'"));
 ok('server retains reporter department restriction',fn.includes('只能报修本车间'));
 const delta=path.join(root,'supabase/delta_report_place_required.sql');
 if(fs.existsSync(delta)){
  const s=fs.readFileSync(delta,'utf8'),historical=s.match(rx)[0],hg=historical.indexOf("if place_txt = ''");
  ok('historical migration retains required location before allocation/writes',historical.includes("btrim(coalesce(p_place, ''), U&'")&&hg>0&&hg<historical.indexOf('wo := public._equip_next_no()')&&hg<historical.indexOf('update public.equipments'));
  ok('migration transactional',/\nbegin;/.test(s)&&/commit;\s*$/.test(s));
  ok('migration removes obsolete bypass overload',s.includes('drop function if exists public.equipment_report(text, text, text, text, text);'));
 }
 const newest=path.join(root,'supabase/delta_report_correction.sql');
 if(fs.existsSync(newest))ok('latest correction migration has canonical report function',fs.readFileSync(newest,'utf8').match(rx)[0]===fn);
 await Promise.resolve();console.log('通过 '+pass+' / 失败 0');
})().catch(e=>{console.error(e.stack);console.log('通过 '+pass+' / 失败 1');process.exitCode=1});
