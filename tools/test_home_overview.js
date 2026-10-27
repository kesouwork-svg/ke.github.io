'use strict';
// Offline homepage folding regression. No network, login, Bluetooth or printing.
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..');let passed=0;
function ok(name,value){if(!value)throw Error(name);passed++;}
function make(){
 const els={},store={roi_session:JSON.stringify({token:'offline',account:'admin',name:'管理员',level:1,tools:[]})};
 const el=()=>({value:'',innerHTML:'',textContent:'',style:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},getAttribute(){return null;}});
 const storage={getItem:k=>store[k]||null,setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
 const sandbox={console,Promise,setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},localStorage:storage,sessionStorage:storage,
 location:{origin:'https://kekits.com',pathname:'/equipment/index.html',search:''},history:{replaceState(){}},
 document:{getElementById:id=>els[id]||(els[id]=el()),addEventListener(){},querySelectorAll:()=>[],querySelector:()=>null,body:el(),head:el(),createElement:el},
 addEventListener(){},scrollTo(){},confirm:()=>false,fetch(){throw Error('Network forbidden')}};
 sandbox.window=sandbox;const ctx=vm.createContext(sandbox);for(const f of ['docs/js/session.js','docs/equipment/js/equipment-api.js','docs/equipment/js/equipment-app.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
 const run=s=>vm.runInContext(s,ctx);run("EqConfig.cloud=false;ROLE='admin';");
 const eq={
  'GEN-D01':{code:'GEN-D01',name:'冲压组入口',line:'冲压组',category:'misc',family:'磨削/抛光',records:[{status:'open'}]},
  'GEN-D07':{code:'GEN-D07',name:'通用报修 · 模具部',line:'模具部',category:'misc',records:[]},
  'PS04-10':{code:'PS04-10',name:'卧轴矩台平面磨床',line:'模具部',family:'磨削/抛光',category:'prod',records:[]},
  'PS04-53':{code:'PS04-53',name:'手摇平面磨床',line:'模具部',family:'磨削/抛光',category:'prod',records:[]},
  'PS00-140':{code:'PS00-140',name:'CNC加工中心',line:'模具部',family:'加工中心/雕刻机',category:'prod',records:[]},
  'PS01-01':{code:'PS01-01',name:'40T冲床',line:'冲压组',family:'冲床/精冲',category:'prod',records:[{status:'open'}]}
 };run('EQ='+JSON.stringify(eq));for(const id of ['f-q','f-line','f-cat','eq-list','eq-count'])sandbox.document.getElementById(id);
 return {run,els,html(){run('renderList()');return els['eq-list'].innerHTML}};
}
function head(h,key){return (h.match(new RegExp('<details[^>]*data-list-section="'+key+'"[^>]*>'))||[''])[0]}
function event(key,open,auto='0',connected=true){return 'rememberListSection({open:'+open+',isConnected:'+connected+',getAttribute:function(k){return k==="data-list-section"?'+JSON.stringify(key)+':'+JSON.stringify(auto)+';}})'}
{
 const t=make(),h=t.html();
 ok('default overview contains exactly two native disclosures',(h.match(/<details /g)||[]).length===2);
 ok('generic disclosure is closed by default',head(h,'generic')&&!head(h,'generic').includes(' open'));
 ok('equipment disclosure is closed by default',head(h,'equipment')&&!head(h,'equipment').includes(' open'));
 ok('generic appears first',h.indexOf('data-list-section="generic"')<h.indexOf('data-list-section="equipment"'));
 ok('generic count is by card',h.includes('2 张报修卡'));
 ok('equipment count excludes generic cards',h.includes('4 台 · 3 个类别'));
 ok('record and unfinished totals remain visible',h.includes('进行中 1'));
 ok('overall filter count unchanged',t.els['eq-count'].textContent==='共 6 台');
 t.run('groupOpen["磨削/抛光"]=true');const split=t.html().split('</details>');
 ok('GEN prefix wins even with ordinary name and shared family',split[0].includes("openDetail('GEN-D01')")&&!split[0].includes("openDetail('PS04-10')"));
 ok('ordinary device remains in equipment section',split[1].includes("openDetail('PS04-10')")&&!split[1].includes("openDetail('GEN-D01')"));
 t.run(event('generic',true));let manual=t.html();
 ok('manual opening persists after rerender',head(manual,'generic').includes(' open'));
 ok('sections open independently',!head(manual,'equipment').includes(' open'));
 t.run(event('generic',false,'0',false));ok('detached old toggle cannot overwrite preference',t.run('listSectionOpen.generic')===true);
 t.run(event('equipment',true,'1'));ok('automatic search toggle is not persisted',!t.run('listSectionOpen.equipment'));
 t.run(event('__proto__',true));ok('unknown section ignored',t.run('Object.keys(listSectionOpen).length')===1);
 t.els['f-q'].value='PS04-10';let search=t.html();
 ok('search reveals matching outer section',head(search,'equipment').includes(' open'));
 ok('search expands matching inner card',search.includes("openDetail('PS04-10')"));
 ok('search omits empty generic section',!head(search,'generic'));
 ok('search marks forced expansion',head(search,'equipment').includes('data-auto-open="1"'));
 t.els['f-q'].value='';const clear=t.html();
 ok('clear search restores generic manual state',head(clear,'generic').includes(' open'));
 ok('clear search restores equipment default state',!head(clear,'equipment').includes(' open'));
 const targets=t.run('JSON.stringify(labelTargets())');t.run(event('generic',false));t.run(event('equipment',true));t.html();
 ok('folding does not affect QR target range',t.run('JSON.stringify(labelTargets())')===targets);
 ok('folding does not affect filter results',t.run('filterCodes().length')===6);
 t.els['f-line'].value='模具部';const dept=t.html();
 ok('specific department has no overview wrappers',!dept.includes('<details'));
 ok('specific department retains ordinary family groups',dept.includes('data-fam="磨削/抛光"'));
 ok('specific department count remains all matching cards',t.els['eq-count'].textContent==='共 4 台');
 t.els['f-line'].value='';t.els['f-cat'].value='prod';const prod=t.html();
 ok('category filter omits empty generic section',!head(prod,'generic')&&!!head(prod,'equipment'));
 t.els['f-cat'].value='';t.els['f-q'].value='GEN-';const gen=t.html();
 ok('generic-only results omit empty equipment section',!!head(gen,'generic')&&!head(gen,'equipment'));
 t.els['f-q'].value='no-such-equipment';ok('empty results retain original empty message',t.html().includes('没有匹配的设备'));
 t.run("listSectionOpen={generic:true,equipment:true};groupOpen={'磨削/抛光':true};goToolHome()");
 ok('tool home resets outer preferences',t.run('Object.keys(listSectionOpen).length')===0);
 ok('tool home resets inner preferences',t.run('Object.keys(groupOpen).length')===0);
 ok('tool home restores all-department filters',t.els['f-line'].value===''&&t.els['f-q'].value===''&&t.els['f-cat'].value==='');
 const encoded=t.run('renderListSection("generic","<img onerror=1>",["GEN-D01"],"",false)');
 ok('section title is HTML escaped',encoded.includes('&lt;img onerror=1&gt;')&&!encoded.includes('<img onerror=1>'));
 ok('empty sections produce no phantom headings',t.run('renderListSection("equipment","设备",[],"",false)')==='');
 t.run('EQ={}');ok('empty database retains original creation hint',t.html().includes('还没有设备'));
}
console.log('通过 '+passed+' / 失败 0');
