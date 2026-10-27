'use strict';
// Offline homepage folding regression. No network, login, Bluetooth or printing.
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..');let passed=0;
function ok(name,value){if(!value)throw Error(name);passed++;}
function make(options={}){
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
 };run('EQ='+JSON.stringify(options.eq===undefined?eq:options.eq));
 run('ROLE='+JSON.stringify(options.role||'admin')+';MY_DEPT='+JSON.stringify(options.dept||'模具部')+';MY_GENERIC='+JSON.stringify(options.generic===undefined?'GEN-D07':options.generic));
 for(const id of ['f-q','f-line','f-cat','eq-list','eq-count','mine-list','mine-count','mine-dept'])sandbox.document.getElementById(id);
 return {run,els,html(){run('renderList()');return els['eq-list'].innerHTML},mine(){run('renderMine()');return els['mine-list'].innerHTML}};
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
 ok('specific department has one fixed-assets overview and no generic disclosure',(dept.match(/<details /g)||[]).length===1&&!!head(dept,'equipment')&&!head(dept,'generic'));
 ok('specific department renders generic card directly before fixed assets',dept.indexOf("openDetail('GEN-D07')")>=0&&dept.indexOf("openDetail('GEN-D07')")<dept.indexOf('data-list-section="equipment"'));
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
const originalPassed=passed-1; // The direct generic-card assertion above is new; all old checks remain.
function section(h,key){const start=h.indexOf(head(h,key));return head(h,key)?h.slice(start,h.indexOf('</details>',start)+10):'';}
function calls(h,code){return h.split("openDetail('"+code+"')").length-1;}
function mineFixture(){
 const t=make();return JSON.parse(t.run('JSON.stringify(Object.fromEntries(Object.entries(EQ).filter(function(pair){return pair[1].line==="模具部";})))'));
}
// Each role receives a fresh VM: mocks and manual state cannot leak between cases.
for(const role of ['admin','repairer']){
 const t=make({role}),check=(name,value)=>ok(role+': '+name,value);
 let h=t.html();
 check('all-department equipment title is fixed assets',section(h,'equipment').includes('>固定资产</span>')&&!h.includes('分类设备'));
 check('all-department disclosures keep stable keys',!!head(h,'generic')&&!!head(h,'equipment'));
 t.els['f-line'].value='模具部';h=t.html();
 check('department fixed assets default closed',!!head(h,'equipment')&&!head(h,'equipment').includes(' open'));
 check('department generic card is direct and exactly once',calls(h,'GEN-D07')===1&&h.indexOf("openDetail('GEN-D07')")<h.indexOf('<details'));
 check('department generic card is outside asset body',!section(h,'equipment').includes("openDetail('GEN-D07')"));
 check('department has no generic family or generic disclosure',!head(h,'generic')&&!h.includes('data-fam="通用报修 · 模具部"'));
 check('department asset totals exclude generic card',section(h,'equipment').includes('3 台 · 2 个类别'));
 check('inner category preferences are initially untouched',t.run('Object.keys(groupOpen).length')===0);
 t.run(event('equipment',true));t.run('groupOpen["磨削/抛光"]=true');h=t.html();
 check('manual outer and inner expansion both survive rerender',head(h,'equipment').includes(' open')&&calls(h,'PS04-10')===1&&calls(h,'PS04-53')===1);
 check('generic and ordinary admin cards retain cost display',h.includes('eq-card-cost')&&h.includes('累计费用'));
 const before=t.run('JSON.stringify(labelTargets())');
 t.run(event('equipment',false));h=t.html();
 check('collapsing assets leaves print range unchanged',t.run('JSON.stringify(labelTargets())')===before&&t.run('filterCodes().length')===4);
 check('outer collapse does not erase category preference',t.run('groupOpen["磨削/抛光"]')===true);
 t.run(event('equipment',true));t.run(event('equipment',false,'0',false));t.run(event('equipment',false,'1'));
 check('detached and auto toggles preserve department preference',t.run('listSectionOpen.equipment')===true);
 t.run(event('equipment',false));t.els['f-q'].value='PS04-10';h=t.html();
 check('department search forces outer and inner reveal',head(h,'equipment').includes(' open')&&head(h,'equipment').includes('data-auto-open="1"')&&calls(h,'PS04-10')===1);
 check('department search filters direct generic card',calls(h,'GEN-D07')===0);
 check('department search print range matches filter',t.run('JSON.stringify(labelTargets())')==='["PS04-10"]');
 t.run(event('equipment',true,'1'));t.els['f-q'].value='';h=t.html();
 check('clearing department search restores manual closed state',!head(h,'equipment').includes(' open'));
 t.run('GORDERS={"模具部":[{n:"加工中心/雕刻机",pin:true},{n:"磨削/抛光",pin:false}]}');h=t.html();
 check('department asset groups retain custom ordering and pin',h.indexOf('data-fam="加工中心/雕刻机"')<h.indexOf('data-fam="磨削/抛光"')&&section(h,'equipment').includes('eq-pin'));
 check('collapsed family still lists original specifications',h.includes('卧轴矩台平面磨床')&&h.includes('手摇平面磨床'));
 t.els['f-cat'].value='prod';h=t.html();
 check('category filter leaves only department fixed assets',!!head(h,'equipment')&&!head(h,'generic')&&calls(h,'GEN-D07')===0&&t.els['eq-count'].textContent==='共 3 台');
 t.els['f-cat'].value='misc';h=t.html();
 check('generic-only department filter has no disclosure',!h.includes('<details')&&calls(h,'GEN-D07')===1&&t.els['eq-count'].textContent==='共 1 台');
 check('generic-only department filter keeps exact QR target',t.run('JSON.stringify(labelTargets())')==='["GEN-D07"]');
 t.els['f-cat'].value='';t.els['f-line'].value='冲压组';t.run('taskFilter="open"');h=t.html();
 check('unfinished filter keeps direct generic plus matching asset wrapper',calls(h,'GEN-D01')===1&&!!head(h,'equipment')&&t.els['eq-count'].textContent==='共 2 台');
 check('unfinished asset totals are accurate',section(h,'equipment').includes('1 台 · 1 个类别')&&section(h,'equipment').includes('进行中 1'));
 t.run('labelCodes=["PS00-140"];listSectionOpen.equipment=true');t.html();
 check('explicit single-device label scope is not widened by folding',t.run('JSON.stringify(labelTargets())')==='["PS00-140"]');
 t.run('labelCodes=null;goToolHome()');h=t.html();
 check('home resets role filters and outer/category preferences',t.els['f-line'].value===''&&t.els['f-q'].value===''&&t.els['f-cat'].value===''&&t.run('taskFilter')===''&&t.run('Object.keys(listSectionOpen).length+Object.keys(groupOpen).length')===0);
 check('home returns to closed all-department overview',!!head(h,'generic')&&!head(h,'generic').includes(' open')&&!head(h,'equipment').includes(' open'));
 const onlyGeneric=make({role,eq:{'GEN-ONLY':{code:'GEN-ONLY',name:'单张通用卡',line:'独立部门',category:'misc',records:[]}}});
 check('all-department single generic retains generic overview',!!head(onlyGeneric.html(),'generic')&&!head(onlyGeneric.html(),'equipment'));
 onlyGeneric.els['f-line'].value='独立部门';h=onlyGeneric.html();
 check('single generic department is directly usable with no details',!h.includes('<details')&&calls(h,'GEN-ONLY')===1);
 const noGeneric=make({role,eq:{'A-1':{code:'A-1',name:'独立固定资产',line:'无通用卡部门',family:'独立类别',records:[]}}});
 noGeneric.els['f-line'].value='无通用卡部门';h=noGeneric.html();
 check('department without generic still has closed asset wrapper',!!head(h,'equipment')&&!head(h,'equipment').includes(' open')&&!head(h,'generic'));
 t.run('EQ["GEN-D99"]={code:"GEN-D99",name:"第二通用卡",line:"模具部",family:"磨削/抛光",records:[]}');t.els['f-line'].value='模具部';h=t.html();
 check('all department GEN codes are direct regardless of name or family',calls(h,'GEN-D07')===1&&calls(h,'GEN-D99')===1&&h.indexOf("openDetail('GEN-D99')")<h.indexOf('<details')&&!section(h,'equipment').includes("openDetail('GEN-D99')"));
 t.run('EQ={}');h=t.html();
 check('empty database has hint without phantom wrappers',h.includes('还没有设备')&&!h.includes('<details'));
}
{
 const eq=mineFixture();eq['GEN-D07'].records=[{status:'open',cost:876543.21}];eq['PS04-10'].records=[{status:'open',cost:987654.32},{status:'done',cost:123456.78}];
 const t=make({role:'reporter',eq}),check=(name,value)=>ok('reporter: '+name,value);
 // Reporter rendering must never fall through to the administrator's monetary cards.
 t.run('deviceCardHtml=function(){throw Error("reporter must not use admin deviceCardHtml")};');
 let h=t.mine();
 check('one fixed-assets wrapper has correct stable key',!!head(h,'mineEquipment')&&(h.match(/<details /g)||[]).length===1&&!head(h,'generic')&&!head(h,'equipment'));
 check('asset section uses shared overview presentation and fixed title',head(h,'mineEquipment').includes('eq-overview')&&section(h,'mineEquipment').includes('>固定资产</span>')&&!h.includes('分类设备'));
 check('fixed assets start collapsed',!head(h,'mineEquipment').includes(' open'));
 check('original generic card is direct above fixed assets',calls(h,'GEN-D07')===1&&h.indexOf('mine-generic')<h.indexOf('<details')&&h.includes('风扇、叉车、照明、行政杂项等没有二维码的,报这里'));
 check('generic is excluded from asset section',!section(h,'mineEquipment').includes('mine-generic')&&!section(h,'mineEquipment').includes("openDetail('GEN-D07')"));
 check('outer statistics count only assets',section(h,'mineEquipment').includes('3 台 · 2 个类别')&&section(h,'mineEquipment').includes('2 条')&&section(h,'mineEquipment').includes('进行中 1'));
 check('department heading and overall count stay unchanged',t.els['mine-dept'].textContent==='我的车间 · 模具部'&&t.els['mine-count'].textContent==='共 4 项');
 check('collapsed cards and overview never leak costs',!/(eq-card-cost|累计费用|876543|987654|123456|¥|￥)/.test(h));
 check('inner categories keep reporter toggle handler',h.includes('onclick="toggleMineGroup(this)"')&&!h.includes('onclick="toggleGroup(this)"'));
 check('collapsed groups retain specification summaries',h.includes('eq-group-specs')&&h.includes('卧轴矩台平面磨床')&&h.includes('手摇平面磨床'));
 t.run(event('mineEquipment',true));h=t.mine();
 check('reporter manual expansion persists',head(h,'mineEquipment').includes(' open')&&t.run('listSectionOpen.mineEquipment')===true);
 check('reporter preference does not open administrator sections',!t.run('listSectionOpen.equipment')&&!t.run('listSectionOpen.generic'));
 t.run('toggleMineGroup({getAttribute:function(){return "磨削/抛光";}})');h=t.els['mine-list'].innerHTML;
 check('reporter asset group expands into original simplified cards',calls(h,'PS04-10')===1&&calls(h,'PS04-53')===1&&h.includes('eq-card-sub-item'));
 check('expanded reporter cards remain completely cost-free',!/(eq-card-cost|累计费用|876543|987654|123456|¥|￥)/.test(h));
 t.run('EQ["PS04-10"].records[0].status="done"');h=t.mine();
 check('status refresh preserves outer and inner manual expansion',head(h,'mineEquipment').includes(' open')&&calls(h,'PS04-10')===1&&t.run('mineGroupOpen["磨削/抛光"]')===true);
 check('status refresh updates asset unfinished total only',!section(h,'mineEquipment').includes('进行中')&&h.includes('进行中 1'));
 t.run(event('mineEquipment',false,'0',false));t.run(event('mineEquipment',false,'1'));
 check('reporter ignores detached and search-generated toggles',t.run('listSectionOpen.mineEquipment')===true);
 t.run(event('mineEquipment',false));h=t.mine();
 check('reporter can manually close without losing inner state',!head(h,'mineEquipment').includes(' open')&&t.run('mineGroupOpen["磨削/抛光"]')===true);
 t.run('GORDERS={"模具部":[{n:"加工中心/雕刻机",pin:true},{n:"磨削/抛光",pin:false}]}');h=t.mine();
 check('reporter preserves department category sorting and pin',h.indexOf('data-fam="加工中心/雕刻机"')<h.indexOf('data-fam="磨削/抛光"')&&section(h,'mineEquipment').includes('eq-pin'));
 t.run('groupOpen={sentinel:true};listSectionOpen.generic=true;listSectionOpen.equipment=true;listSectionOpen.mineEquipment=true;mineGroupOpen={"磨削/抛光":true};var homeCalls=[];loadMine=function(code,noAuto){homeCalls.push([code,noAuto]);renderMine()};goToolHome()');h=t.els['mine-list'].innerHTML;
 check('reporter home refreshes own view without auto detail',t.run('JSON.stringify(homeCalls)')==='[["",true]]');
 check('reporter home clears reporter category and asset preferences',t.run('Object.keys(mineGroupOpen).length')===0&&!t.run('listSectionOpen.mineEquipment'));
 check('reporter home returns asset overview to closed state',!!head(h,'mineEquipment')&&!head(h,'mineEquipment').includes(' open'));
 const genericOnly=make({role:'reporter',eq:{'GEN-D07':eq['GEN-D07']}});h=genericOnly.mine();
 check('generic-only reporter has direct card without empty overview',calls(h,'GEN-D07')===1&&!h.includes('<details')&&genericOnly.els['mine-count'].textContent==='共 1 项');
 const noGenericEq={...eq};delete noGenericEq['GEN-D07'];
 const noGeneric=make({role:'reporter',eq:noGenericEq,generic:''});h=noGeneric.mine();
 check('reporter with no generic keeps closed assets and correct count',!!head(h,'mineEquipment')&&!head(h,'mineEquipment').includes(' open')&&!h.includes('mine-generic')&&noGeneric.els['mine-count'].textContent==='共 3 项');
 const missingGeneric=make({role:'reporter',eq:noGenericEq,generic:'GEN-MISSING'});h=missingGeneric.mine();
 check('missing configured generic creates no phantom card or count',!h.includes('mine-generic')&&missingGeneric.els['mine-count'].textContent==='共 3 项');
 const empty=make({role:'reporter',eq:{}});h=empty.mine();
 check('empty reporter database retains original hint and zero count',h.includes('本车间还没有登记设备')&&!h.includes('<details')&&empty.els['mine-count'].textContent==='共 0 项');
 const injected=t.run('renderListSection("mineEquipment","固定资产",["PS04-10"],MY_DEPT,false,"<div data-test=reporter-body>精简卡体</div>")');
 check('optional body HTML is rendered verbatim once',injected.includes('<div data-test=reporter-body>精简卡体</div>')&&injected.split('精简卡体').length===2&&!injected.includes('data-fam='));
 check('optional reporter body retains shared asset statistics',injected.includes('1 台 · 1 个类别')&&injected.includes('2 条'));
 check('empty section ignores a supplied body without phantom heading',t.run('renderListSection("mineEquipment","固定资产",[],MY_DEPT,false,"unexpected")')==='');
 check('fresh reporter VM does not inherit prior manual preferences',!noGeneric.run('listSectionOpen.mineEquipment')&&noGeneric.run('Object.keys(mineGroupOpen).length')===0);
}
console.log('通过 '+passed+' / 失败 0（原测试 '+originalPassed+' 项 + 新增 '+(passed-originalPassed)+' 项）');
