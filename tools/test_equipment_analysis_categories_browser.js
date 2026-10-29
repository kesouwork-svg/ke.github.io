'use strict';
// Real Chrome: current page/core/controller, synthetic data and existing read-only harness only.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const harness=require('./test_equipment_analysis_browser');
const root=path.resolve(__dirname,'..'),out=path.join(root,'outputs','Equipment_Analysis_Categories_20261029');fs.mkdirSync(out,{recursive:true});
const data=harness.fixtureData;
const open=(id,date='2026-10-10')=>({id,type:'fault',status:'open',reportAt:date,expectedAt:'2026-10-15',symptom:'合成：待处理'});
const eq=(name,family,records,line='模具部',category='prod')=>({name,family,records,line,category});
data['DEMO-MILL-2']=eq('演示大磨床',' 磨床 ',[open('a2')],'冲压组');
data['DEMO-MILL-IDLE']=eq('演示无故障磨床','磨床',[]);
data['DEMO-MILL-BAD']=eq('演示待核档案','磨床',null);
data['DEMO-NAME']=eq('演示旧名称分组','',[open('name')]);
data['DEMO-FACILITY']=eq('','',[open('facility')],'模具部','facility');
data['DEMO-PROTO']=eq('演示原型键','__proto__',[open('proto')]);
data['DEMO-CONSTRUCTOR']=eq('演示构造键','constructor',[open('constructor')]);
data['DEMO-HTML']=eq('演示HTML文本','<img src=x onerror="window.categoryInjected=1">',[open('html')]);
data['DEMO-WHITESPACE']=eq('不应回退此名称','   ',[open('spaces')]);
data['DEMO-ZERO']=eq('演示零故障','磨床',[],'无故障演示部');
// In all departments the mill denominator is 5: 2 priority + 2 empty + 1 malformed.
let passed=0;const results=[],requests=[],uncaught=[];
async function run(){
 const pause=ms=>new Promise(r=>setTimeout(r,ms)),profile=path.join(out,'chrome-categories-'+Date.now());fs.mkdirSync(profile);
 const log=fs.openSync(path.join(out,'categories_browser.log'),'w');
 const chrome=cp.spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore',log,log]});
 let ws,id=0;const pending=new Map();
 const deadline=setTimeout(()=>{chrome.kill();console.error('Category browser deadline exceeded');process.exit(1)},90000);
 function send(method,params={}){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))})}
 async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
 async function until(expression){for(let i=0;i<120;i++){if(await evaluate(expression))return;await pause(30)}throw Error('Wait failed: '+expression)}
 async function check(name,expression){const ok=!!await evaluate(expression);results.push({name,ok});if(!ok)throw Error(name+'\n'+JSON.stringify(await evaluate('({status:document.getElementById("analysis-status").innerText,groups:document.getElementById("priority-categories").innerText,calls:__analysisFixture.calls,active:document.activeElement&&document.activeElement.outerHTML,focused:document.hasFocus()})')));passed++}
 async function click(expression){const p=await evaluate('(()=>{const e='+expression+';if(!e)throw Error("Missing click target");e.scrollIntoView({block:"center",behavior:"instant"});const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()');await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});await pause(90)}
 async function navigate(role,width){const f=path.join(out,'categories_'+role+'_'+width+'.html');fs.writeFileSync(f,harness.documentFor(role,false));await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:new URL('file:///'+f.replace(/\\/g,'/')).href});await until('window.__analysisFixture && !document.getElementById("refresh-data").disabled');await send('Page.bringToFront');await evaluate('window.testGroup=name=>[...document.querySelectorAll(".priority-group")].find(e=>e.querySelector(".priority-group-name").textContent===name)')}
 try{
  const pf=path.join(profile,'DevToolsActivePort');for(let i=0;i<80&&!fs.existsSync(pf);i++)await pause(65);if(!fs.existsSync(pf))throw Error('No Chrome debug port');
  const port=fs.readFileSync(pf,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}else if(m.method==='Network.requestWillBeSent'&&/^https?:/.test(m.params.request.url))requests.push(m.params.request.url);else if(m.method==='Runtime.exceptionThrown')uncaught.push(m.params.exceptionDetails.text)});
  await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
  for(const role of ['admin','repairer'])for(const width of [320,390,1440]){
   const pre=role+'/'+width+' ';await navigate(role,width);
   await check(pre+'default device mode preserved','!document.getElementById("priority-devices").hidden && document.getElementById("priority-categories").hidden && document.getElementById("priority-by-device").getAttribute("aria-pressed")==="true"');
   await evaluate('window.initialCards=document.getElementById("summary-cards").textContent;window.initialBacklog=document.getElementById("backlog-rows").innerHTML;window.initialGeneric=document.getElementById("generic-rows").innerHTML;window.initialTrends=document.getElementById("trend-rows").innerHTML;window.initialCodes=[...document.querySelectorAll("#priority-rows a")].map(a=>new URL(a.href).searchParams.get("code")).sort()');
   await click('document.getElementById("priority-by-category")');
   await check(pre+'category mode controls and no changed totals','document.getElementById("priority-devices").hidden && !document.getElementById("priority-categories").hidden && document.getElementById("priority-by-category").getAttribute("aria-pressed")==="true" && document.getElementById("summary-cards").textContent===initialCards && document.getElementById("backlog-rows").innerHTML===initialBacklog && document.getElementById("generic-rows").innerHTML===initialGeneric && document.getElementById("trend-rows").innerHTML===initialTrends');
   await check(pre+'collapsed groups lazy render no device tables','document.querySelectorAll(".priority-group").length===8 && document.querySelectorAll(".priority-group[open]").length===0 && document.querySelectorAll(".priority-group tbody").length===0');
   await check(pre+'all scoped devices denominator not just priority','testGroup("磨床").querySelector(".sub").textContent.includes("设备 5 台") && testGroup("磨床").querySelector(".sub").textContent.includes("重点 2 台")');
   await check(pre+'same existing fallback and blank grouping','!!testGroup("演示旧名称分组") && !!testGroup("系统设施") && !!testGroup("（空类别名称）") && !testGroup("不应回退此名称")');
   await check(pre+'unsafe group names remain text and GEN excluded','!!testGroup("__proto__") && !!testGroup("constructor") && !window.categoryInjected && !document.querySelector("#priority-categories img") && !document.getElementById("priority-categories").textContent.includes("GEN-DEMO") && document.getElementById("generic-rows").textContent.includes("GEN-DEMO")');
   await click('testGroup("磨床").querySelector("summary")');
   await check(pre+'native expand same sorted member devices','testGroup("磨床").open && testGroup("磨床").querySelectorAll("tbody tr").length===2 && [...testGroup("磨床").querySelectorAll("tbody a")].map(a=>new URL(a.href).searchParams.get("code")).join(",")==="DEMO-MILL,DEMO-MILL-2"');
   await check(pre+'device links remain encoded local originals','[...testGroup("磨床").querySelectorAll("tbody a")].every(a=>new URL(a.href).pathname.endsWith("/index.html") && !new URL(a.href).searchParams.has("wo"))');
   await check(pre+'responsive no full-page overflow','document.documentElement.scrollWidth<=innerWidth+1');
   await check(pre+'mode touch targets at least 44px','[...document.querySelectorAll("[data-priority-mode]")].every(e=>e.getBoundingClientRect().height>=44)');
   const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,'categories_'+role+'_'+width+'.png'),Buffer.from(shot.data,'base64'));
   await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await pause(80);
   await check(pre+'native keyboard closes category','!testGroup("磨床").open');
   await click('document.getElementById("priority-by-device")');
   await check(pre+'switch back identical priority collection','JSON.stringify([...document.querySelectorAll("#priority-rows a")].map(a=>new URL(a.href).searchParams.get("code")).sort())===JSON.stringify(initialCodes) && document.getElementById("priority-categories").textContent===""');
   await click('document.getElementById("priority-by-category")');
   await evaluate('document.getElementById("family").value=" 磨床 ";document.getElementById("analysis-filters").requestSubmit()');
   await check(pre+'original raw family filter not grouping fallback','document.querySelectorAll(".priority-group").length===1 && testGroup("磨床").querySelector(".sub").textContent.includes("设备 1 台") && document.querySelector("[data-metric=backlog] .value").textContent==="1"');
   await evaluate('document.getElementById("reset-filters").click();document.getElementById("department").value="无故障演示部";document.getElementById("analysis-filters").requestSubmit()');
   await check(pre+'empty priority no fake groups','document.querySelectorAll(".priority-group").length===0 && document.getElementById("priority-categories").textContent.includes("没有可展示")');
   await evaluate('document.getElementById("reset-filters").click();document.getElementById("department").value="模具部";document.getElementById("analysis-filters").requestSubmit()');
   await click('testGroup("磨床").querySelector("summary")');
   await check(pre+'filter rebuild has no out-of-scope member cache','testGroup("磨床").querySelector(".sub").textContent.includes("设备 3 台") && testGroup("磨床").querySelectorAll("tbody tr").length===1 && !testGroup("磨床").textContent.includes("DEMO-MILL-2")');
   await check(pre+'switch expand and filter perform no further reads','JSON.stringify(__analysisFixture.calls)===JSON.stringify(["me","equipment_list"])');
   await evaluate('__analysisFixture.mode="fail";document.getElementById("refresh-data").click()');await until('!document.getElementById("refresh-data").disabled');
   await check(pre+'failure clears all added DOM and counts','document.getElementById("analysis-content").hidden && document.getElementById("priority-categories").textContent==="" && document.getElementById("priority-rows").textContent==="" && document.getElementById("priority-count").textContent===""');
  }
  for(const role of ['reporter','view']){await navigate(role,390);await check(role+' no list and no grouped data','document.getElementById("analysis-content").hidden && document.getElementById("priority-categories").textContent==="" && JSON.stringify(__analysisFixture.calls)===JSON.stringify(["me"])')}
  await navigate('admin',390);await click('document.getElementById("priority-by-category")');await click('testGroup("磨床").querySelector("summary")');
  await evaluate('__analysisFixture.mode="defer-list";document.getElementById("refresh-data").click()');await until('!!__analysisFixture.pendingList');
  await evaluate('__analysisFixture.changeIdentity("reporter","downgraded-categories")');await until('!document.getElementById("refresh-data").disabled');await evaluate('__analysisFixture.pendingList.resolve(__analysisFixture.pendingList.value);Promise.resolve()');
  await check('late list cannot restore category data after downgrade','document.getElementById("analysis-content").hidden && document.getElementById("priority-categories").textContent==="" && document.getElementById("priority-rows").textContent===""');
  if(requests.length||uncaught.length)throw Error('Unexpected HTTP/runtime exception '+JSON.stringify({requests,uncaught}));
  fs.writeFileSync(path.join(out,'category_browser_validation.json'),JSON.stringify({ok:true,passed,failed:0,synthetic:true,productionAccess:false,actualHttpRequests:requests,uncaught,physicalPrints:0,results},null,2));
  console.log('Category browser: '+passed+' passed / 0 failed (real Chrome; local synthetic data; no production calls)');
 }finally{clearTimeout(deadline);if(ws){try{ws.send(JSON.stringify({id:++id,method:'Browser.close'}));ws.close()}catch(e){}}chrome.kill();fs.closeSync(log)}
}
run().catch(e=>{console.error(e.stack||String(e));process.exitCode=1});
