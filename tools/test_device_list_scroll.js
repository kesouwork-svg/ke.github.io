// Run with Node 22+ and desktop Chrome. Real native wheel input, local synthetic data only.
// No business network, login, Bluetooth or physical printing. Artifacts go to ignored outputs/.
const fs=require('fs'),path=require('path'),cp=require('child_process');
const root=path.resolve(__dirname,'..'),OUT=path.join(root,'outputs'),pause=ms=>new Promise(r=>setTimeout(r,ms));fs.mkdirSync(OUT,{recursive:true});
const base=new URL('file:///'+path.join(root,'docs/equipment/').replace(/\\/g,'/')).href;
let html=fs.readFileSync(path.join(root,'docs/equipment/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace('<head>','<head><base href="'+base+'">');
const fixture=`<script>
fetch=()=>{throw Error('Business network forbidden')};window.print=()=>{throw Error('Printing forbidden')};
addEventListener('load',()=>{const s=document.createElement('script');s.src='./js/equipment-app.js';s.onload=()=>window.READY=true;document.head.appendChild(s)});
window.setup=async function(role,scope){
 EQ={};for(let i=1;i<=65;i++){const c='TEST-'+String(i).padStart(3,'0');EQ[c]={code:c,name:'测试设备 '+i,line:'模具部',family:i<=60?'大型设备类别':'其它设备类别',category:'prod',status:'active',records:[]}};
 EQ['GEN-D07']={code:'GEN-D07',name:'通用报修',line:'模具部',category:'misc',records:[]};EQ['GEN-D01']={code:'GEN-D01',name:'另一车间通用报修',line:'冲压组',category:'misc',records:[]};
 ROLE=role;MY_DEPT='模具部';MY_GENERIC='GEN-D07';currentCode='';document.body.className=role==='reporter'?'is-reporter':'is-manage is-'+role;
 document.querySelectorAll('.view').forEach(e=>e.classList.remove('show'));document.getElementById(role==='reporter'?'view-mine':'view-list').classList.add('show');
 listSectionOpen={equipment:true,generic:true,mineEquipment:true};groupOpen={'大型设备类别':true,'其它设备类别':true};mineGroupOpen={'大型设备类别':true,'其它设备类别':true};
 if(role==='reporter'){delete EQ['GEN-D01'];renderMine()}else{$('f-q').value='';$('f-line').innerHTML='<option value="">全部部门</option><option>模具部</option>';$('f-line').value=scope;$('f-cat').value='';taskFilter='';renderList();renderTodoBadge()};
 window.scrollTo(0,0);const el=document.getElementById(role==='reporter'?'mine-list':'eq-list');el.scrollTop=0;
 window.selected='';window.openDetail=function(code){window.selected=code};await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return window.metrics(role)
};
window.metrics=function(role){const el=document.getElementById(role==='reporter'?'mine-list':'eq-list'),r=el.getBoundingClientRect(),wrap=el.querySelector('[data-list-section="'+(role==='reporter'?'mineEquipment':'equipment')+'"]'),cards=el.querySelectorAll('.eq-card-sub-item'),last=cards[cards.length-1],lr=last.getBoundingClientRect();return{width:innerWidth,height:innerHeight,clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,scrollTop:el.scrollTop,windowY:scrollY,overflow:getComputedStyle(el).overflowY,wrapperShrink:getComputedStyle(wrap).flexShrink,wrapperHeight:wrap.getBoundingClientRect().height,wrapperScrollHeight:wrap.scrollHeight,cardCount:cards.length,lastCode:last.getAttribute('onclick').split("'")[1],lastText:last.textContent,lastRect:{left:lr.left,top:lr.top,right:lr.right,bottom:lr.bottom},rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom}}};
</script>`;
html=html.replace('</body>',fixture+'</body>');const file=path.join(OUT,'device_list_scroll.html');fs.writeFileSync(file,html);
const profile=path.join(OUT,'list-scroll-browser-'+Date.now());fs.mkdirSync(profile);const log=fs.openSync(path.join(OUT,'device_list_scroll.log'),'w');
const chrome=cp.spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore',log,log]});
let ws,id=0;const pending=new Map(),deadline=setTimeout(()=>{chrome.kill();console.error('Browser deadline exceeded');process.exit(1)},65000);
function send(method,params={}){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))})}
async function evaluate(expression,awaitPromise=false){const v=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value}
(async()=>{
 const pf=path.join(profile,'DevToolsActivePort');for(let i=0;i<50&&!fs.existsSync(pf);i++)await pause(100);if(!fs.existsSync(pf))throw Error('No debug port');const port=fs.readFileSync(pf,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}});await send('Page.enable');
 let passed=0;const cases=[[1100,760,'admin',''],[1100,760,'admin','模具部'],[1100,600,'repairer',''],[900,600,'repairer','模具部'],[1100,760,'reporter',''],[390,760,'admin','模具部'],[390,760,'reporter','']];
 for(const [width,height,role,scope]of cases){
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:new URL('file:///'+file.replace(/\\/g,'/')).href});let ready=false;for(let i=0;i<70;i++){await pause(70);if(await evaluate('!!window.READY')){ready=true;break}}if(!ready)throw Error('App not ready');
  {
   const before=await evaluate('setup('+JSON.stringify(role)+','+JSON.stringify(scope)+')',true);let after=before;
   for(let k=0;k<6;k++){const r=after.rect;const x=r.left+Math.min((r.right-r.left)/2,180),y=Math.min(height-50,Math.max(100,r.top+70));await send('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX:0,deltaY:2200});await pause(130);after=await evaluate('metrics('+JSON.stringify(role)+')')}
   const lr=after.lastRect,x=(lr.left+lr.right)/2,y=(lr.top+lr.bottom)/2,hit=await evaluate('(()=>{const e=document.elementFromPoint('+x+','+y+');return !!e&&!!e.closest(".eq-card-sub-item")&&e.closest(".eq-card-sub-item").textContent.includes('+JSON.stringify(after.lastCode)+')})()');
   if(hit){await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1})}
   const selected=await evaluate('window.selected');const out={role,scope,before,after,lastHit:hit,selected};console.log(JSON.stringify(out));
   const png=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(OUT,'device_list_scroll_'+role+'_'+width+'_'+'current'+'.png'),Buffer.from(png.data,'base64'));
   if(before.width!==width||before.height!==height||after.cardCount!==65||!hit||selected!==after.lastCode||(width>=900?after.scrollTop<=before.scrollTop:after.windowY<=before.windowY))throw Error('Last device must be reachable by native mouse wheel and clickable '+role+' '+width);passed++;
  }
 }
 console.log(passed+' passed / 0 failed (native wheel scenarios; no business writes or printing)');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{clearTimeout(deadline);if(ws){try{ws.send(JSON.stringify({id:++id,method:'Browser.close'}));ws.close()}catch(e){}}chrome.kill();fs.closeSync(log)});
