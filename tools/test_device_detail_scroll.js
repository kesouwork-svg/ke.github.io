// Node 22+ and desktop Chrome (CHROME_PATH optional). Real layout/native clicks.
// Synthetic local data only: no business network, accounts, writes, or printing.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'outputs');
fs.mkdirSync(out, { recursive: true });
const base = new URL('file:///' + path.join(root, 'docs/equipment/').replace(/\\/g, '/')).href;
const page = fs.readFileSync(path.join(root, 'docs/equipment/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace('<head>', '<head><base href="' + base + '">');
const fixture = `<script>
window.fetch=()=>{throw Error('Business network forbidden')};window.print=()=>{throw Error('Printing forbidden')};
window.checks=[];window.check=(name,value)=>{checks.push({name,ok:!!value});if(!value)throw Error(name)};
const nativeScroll=window.scrollTo.bind(window);window.scrollCalls=[];
window.scrollTo=function(...args){scrollCalls.push(args);return nativeScroll(...args)};
window.tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))};
window.requests=[];window.deferred=false;
window.EquipApi={user:()=>({account:'offline',name:'隔离测试',dept:'模具部',tools:['equipment-admin']}),getDevice:code=>{
 const equipment=JSON.parse(JSON.stringify(EQ[code]));return deferred?new Promise(resolve=>requests.push({code,equipment,resolve})):Promise.resolve({ok:true,role:ROLE,equipment})
}};
window.resolveRequest=(i,name)=>{const r=requests[i];if(name)r.equipment.name=name;r.resolve({ok:true,role:ROLE,equipment:r.equipment})};
addEventListener('load',()=>{const s=document.createElement('script');s.src='./js/equipment-app.js';s.onload=()=>window.READY=true;document.head.appendChild(s)});
window.setup=async function(role,dual){
 EQ={};const d=new Date(),day=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-02';
 for(let i=1;i<=35;i++){const code='SCROLL-'+String(i).padStart(3,'0');EQ[code]={code,name:'定位测试设备 '+i,number:code,line:'模具部',family:'测试类别',category:'prod',status:'active',records:Array.from({length:35},(_,j)=>({id:'r'+j,no:'WO-'+code+'-'+j,type:'fault',status:'open',reportAt:day,symptom:'隔离测试现象 '+j+' '+('需核查运行时异响。'.repeat(8)),place:'测试区域'}))}}
 ROLE=role;MY_DEPT='模具部';currentCode='';pendingWo='';deferred=false;requests=[];
 document.body.className='is-'+role+(dual?' is-manage':'');
 listSectionOpen={equipment:true,generic:true,mineEquipment:true};groupOpen={'测试类别':true};mineGroupOpen={'测试类别':true};
 $('f-q').value='';$('f-line').innerHTML='<option value="">全部部门</option><option>模具部</option>';$('f-line').value='模具部';$('f-cat').value='prod';taskFilter='';
 if(role==='reporter'){renderMine();switchView('mine')}else{renderList();switchView('list')}
 nativeScroll(0,0);await tick();scrollCalls=[];return true
};
// Reporter leaves the mine view; preserve independent scroll only for the visible manager sidebar.
window.state=()=>JSON.stringify({q:$('f-q').value,line:$('f-line').value,cat:$('f-cat').value,task:taskFilter,groups:groupOpen,mine:mineGroupOpen,sections:listSectionOpen,listTop:ROLE==='reporter'?null:$('eq-list').scrollTop});
window.prepareClick=async()=>{const cards=document.querySelectorAll('#'+(ROLE==='reporter'?'mine-list':'eq-list')+' .eq-card-sub-item');const card=cards[cards.length-1];card.scrollIntoView({block:'center'});await tick();const r=card.getBoundingClientRect();scrollCalls=[];return {x:(r.left+r.right)/2,y:(r.top+r.bottom)/2,code:card.getAttribute('onclick').split("'")[1],state:state()}};
window.heading=()=>{const r=document.querySelector('#detail-content .detail-head').getBoundingClientRect(),h=document.querySelector('.eq-header').getBoundingClientRect();return {top:r.top,bottom:r.bottom,safe:h.bottom+12,y:scrollY,name:document.querySelector('#detail-content .detail-title').textContent}};
window.afterSelection=async(code,before)=>{await tick();const h=heading();check('selected device rendered '+ROLE,currentCode===code&&h.name.includes(EQ[code].name));check('heading below sticky header '+ROLE,h.top>=h.safe-2);check('device information visible '+ROLE,h.bottom<=innerHeight-10);check('filters/groups/list scroll preserved '+ROLE,state()===before)};
window.internalChecks=async()=>{
 nativeScroll(0,scrollY+650);await tick();let y=scrollY;scrollCalls=[];
 if(ROLE==='reporter')rpMore();else tlMore();await tick();
 check('show more keeps page position '+ROLE+' '+JSON.stringify({before:y,after:scrollY,calls:scrollCalls}),Math.abs(scrollY-y)<=2&&scrollCalls.length===0);
 if(ROLE!=='reporter'){y=scrollY;scrollCalls=[];setTlMonth('y'+new Date().getFullYear());await tick();check('period selection keeps page position '+ROLE,Math.abs(scrollY-y)<=2&&scrollCalls.length===0)}
 const no=EQ[currentCode].records[12].no,hidden=document.createElement('div');hidden.hidden=true;hidden.innerHTML='<span data-no="'+no+'">隐藏汇总里的同单号</span>';document.body.insertBefore(hidden,document.body.firstChild);
 pendingWo=no;scrollCalls=[];openDetail(currentCode,true);await tick();return no
};
window.checkWo=no=>{const el=document.querySelector('#detail-content [data-no="'+no+'"]'),r=el.getBoundingClientRect();check('work-order link takes priority '+ROLE,el.classList.contains('tl-hit')&&r.top>=0&&r.bottom<=innerHeight);check('ordinary positioning did not override work order '+ROLE,scrollCalls.length===0);check('hidden duplicate not highlighted '+ROLE,!document.querySelector('[hidden] .tl-hit'))};
window.asyncChecks=async()=>{
 await setup('admin',true);const A='SCROLL-001',B='SCROLL-002';
 deferred=true;requests=[];openDetail(A);openDetail(B);resolveRequest(1,'最新B');await tick();scrollCalls=[];resolveRequest(0,'迟到A');await tick();check('A/B reverse response ignored',currentCode===B&&heading().name.includes('最新B')&&scrollCalls.length===0);
 requests=[];openDetail(A);openDetail(B);openDetail(A);resolveRequest(2,'最新A');await tick();scrollCalls=[];resolveRequest(0,'更早A');resolveRequest(1,'更早B');await tick();check('A/B/A generation not just code',currentCode===A&&heading().name.includes('最新A')&&scrollCalls.length===0);
 requests=[];openDetail(A);openDetail(A);resolveRequest(1,'同设备最新');await tick();resolveRequest(0,'同设备过时');await tick();check('same device latest response wins',heading().name.includes('同设备最新'));
 requests=[];openDetail(A);EQ[A].name='缓存新数据';openDetail(A,true);resolveRequest(0,'旧请求数据');await tick();check('cached selection invalidates in-flight request',heading().name.includes('缓存新数据'));
 requests=[];openDetail(A);switchView('report');scrollCalls=[];resolveRequest(0);await tick();check('late response cannot reopen after form navigation',$('view-report').classList.contains('show')&&scrollCalls.length===0);
 requests=[];openDetail(A);showListDefault();scrollCalls=[];resolveRequest(0);await tick();check('late response cannot reopen after list home',currentCode===''&&!$('detail-content').querySelector('.detail-head')&&scrollCalls.length===0);
 requests=[];openDetail(A);$('f-q').value='no-matches-anywhere';renderList();scrollCalls=[];resolveRequest(0);await tick();check('empty filter cancels old selected device',currentCode===''&&!$('detail-content').querySelector('.detail-head')&&scrollCalls.length===0);
 await setup('admin',true);openDetail(A,true);deferred=true;requests=[];refreshDevice(A);openDetail(B);resolveRequest(1,'选择B');await tick();scrollCalls=[];resolveRequest(0,'A后台刷新');await tick();check('late background refresh cannot steal current selection',currentCode===B&&heading().name.includes('选择B')&&scrollCalls.length===0);
 await setup('admin',true);openDetail(A,true);await tick();scrollCalls=[];const y=scrollY;openDetail(B,true);await tick();check('already visible desktop details do not jump',scrollCalls.length===0&&Math.abs(scrollY-y)<=2);
 nativeScroll(0,900);await tick();scrollCalls=[];openDetail(A,true);await tick();check('reduced motion uses instant positioning',scrollCalls.length===1&&scrollCalls[0][0].behavior==='auto');
 return checks
};
</script>`;
const file=path.join(out,'device_detail_scroll.html');fs.writeFileSync(file,page.replace('</body>',fixture+'</body>'));
const profile=path.join(out,'detail-scroll-browser-'+Date.now());fs.mkdirSync(profile);
const log=fs.openSync(path.join(out,'device_detail_scroll.log'),'w');
const chrome=cp.spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore',log,log]});
let ws,id=0,passed=0;const pending=new Map(),pause=ms=>new Promise(r=>setTimeout(r,ms));
const deadline=setTimeout(()=>{chrome.kill();console.error('Browser deadline exceeded');process.exit(1)},90000);
function send(method,params={}){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))})}
async function evaluate(expression){const v=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value}
(async()=>{
 const pf=path.join(profile,'DevToolsActivePort');for(let i=0;i<60&&!fs.existsSync(pf);i++)await pause(100);if(!fs.existsSync(pf))throw Error('No Chrome debug port');
 const port=fs.readFileSync(pf,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}});await send('Page.enable');
 for(const [width,height,role,dual]of [[1100,760,'admin',false],[900,600,'repairer',false],[390,760,'admin',false],[390,760,'reporter',false],[1100,760,'reporter',false],[1100,760,'admin',true],[1100,760,'repairer',true]]){
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:new URL('file:///'+file.replace(/\\/g,'/')).href});
  let ready=false;for(let i=0;i<70;i++){await pause(60);if(await evaluate('!!window.READY')){ready=true;break}}if(!ready)throw Error('App not ready');
  await evaluate('setup('+JSON.stringify(role)+','+dual+')');const target=await evaluate('prepareClick()');
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:target.x,y:target.y,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:target.x,y:target.y,button:'left',clickCount:1});await pause(800);
  await evaluate('afterSelection('+JSON.stringify(target.code)+','+JSON.stringify(target.state)+')');
  const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,'device_detail_scroll_'+role+'_'+width+(dual?'_dual':'')+'.png'),Buffer.from(shot.data,'base64'));
  const no=await evaluate('internalChecks()');await pause(800);await evaluate('checkWo('+JSON.stringify(no)+')');
  const checks=await evaluate('window.checks');passed+=checks.length;console.log(JSON.stringify({width,height,role,dual,checks}));
 }
 await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 const before=await evaluate('checks.length');const all=await evaluate('asyncChecks()');passed+=all.length-before;console.log(JSON.stringify({asyncChecks:all.slice(before)}));
 console.log(passed+' passed / 0 failed (real Chrome detail positioning, native selections; no business network or physical printing)');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{clearTimeout(deadline);if(ws){try{ws.send(JSON.stringify({id:++id,method:'Browser.close'}));ws.close()}catch(e){}}chrome.kill();fs.closeSync(log)});
