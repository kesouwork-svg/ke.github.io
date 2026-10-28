// Persistent regression: Node 22+, desktop Chrome (or CHROME_PATH).
// Uses real HTML/CSS/session/API/APP at 390/1100 CSSpx with synthetic local data.
// No business network, real login, account mutations, or physical printing.
// All profiles, HTML, logs, and screenshots stay in ignored outputs/.
// This is a browser/local-API regression, not a Supabase deployment test.
const fs=require('fs'),path=require('path'),cp=require('child_process');
const root=path.resolve(__dirname,'..'),artifacts=path.join(root,'outputs');fs.mkdirSync(artifacts,{recursive:true});
const base=new URL('file:///'+path.join(root,'docs/equipment/').replace(/\\/g,'/')).href;
const documentHtml=fs.readFileSync(path.join(root,'docs/equipment/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace('<head>','<head><base href="'+base+'">');
const fixture=`<script>
fetch=()=>{throw Error('Business network forbidden')};window.print=()=>{throw Error('Printing forbidden')};
addEventListener('load',async()=>{const checks=[],messages=[];const ok=(n,v)=>{checks.push({n,ok:!!v});if(!v)throw Error(n)};const tick=async()=>{for(let i=0;i<20;i++)await Promise.resolve()};try{
 for(const f of ['../js/session.js','./js/equipment-api.js','./js/equipment-app.js'])await new Promise((a,b)=>{const s=document.createElement('script');s.src=f;s.onload=a;s.onerror=b;document.head.appendChild(s)});
 EqConfig.cloud=false;showToast=m=>messages.push(m);const day=new Date().toISOString().slice(0,10),src='SUP-OFFLINE';
 const initial=()=>({[src]:{code:src,name:'手摇平面磨床',family:'磨削/抛光',line:'模具部',status:'active',records:[{id:'r1',no:'WO-SUP-OFFLINE',status:'open',type:'fault',reportAt:day,symptom:'原始描述：设备有异响',place:'二楼东侧',updates:[{at:day+' 08:00',by:'维修甲',text:'等待备件'}],cost:123,photos:['offline://photo'],action:'保留原处理',opaque:{keep:true}}]}});
 const clean=r=>{const x=JSON.parse(JSON.stringify(r));delete x._supplements;delete x.updatedAt;delete x.updatedBy;return JSON.stringify(x)};
 for(const role of ['admin','reporter']){
  const all=initial(),original=clean(all[src].records[0]);localStorage.setItem('equip_seed_v2','1');localStorage.setItem('equip_list_v2',JSON.stringify(all));
  localStorage.setItem('roi_session',JSON.stringify({token:'offline',account:'fixture-'+role,name:'隔离测试',level:2,dept:'模具部',tools:[role==='admin'?'equipment-admin':'equipment-report']}));
  ROLE=role;MY_DEPT='模具部';document.body.className='is-'+role;EQ=role==='admin'?all:{[src]:maskForReport(all[src])};currentCode=src;
  tlYear=new Date().getFullYear();tlMonth=new Date().getMonth()+1;tlYearOnly=true;
  if(role==='admin')renderManageDetail(EQ[src]);else renderLimitedDetail(EQ[src],'reporter');
  document.querySelector('#detail-content .supplement-act').click();ok(role+' standalone supplement form',$('view-supplement').classList.contains('show'));
  ok(role+' original remains readonly text',$('rs-original').textContent.includes('原始描述')&&!$('rs-original').querySelector('input,textarea'));
  ok(role+' source order number shown',$('rs-source').textContent.includes('WO-SUP-OFFLINE'));
  const before=localStorage.getItem('equip_list_v2');$('rs-text').value='　 ';$('rs-save').click();await tick();ok(role+' blank blocked/focused without business write',document.activeElement===$('rs-text')&&before===localStorage.getItem('equip_list_v2'));
  $('rs-text').value='线'.repeat(2001);$('rs-save').click();await tick();ok(role+' oversized blocked',messages.at(-1)==='补充说明最多2000字'&&before===localStorage.getItem('equip_list_v2'));
  const text='高速异响 <b>新线索</b>\\n停机后消失';$('rs-text').value='  '+text+'  ';$('rs-save').click();ok(role+' pending locks controls',reportSupplement.busy&&['rs-text','rs-save','rs-cancel'].every(id=>$(id).disabled));submitReportSupplement();cancelReportSupplement();await tick();
  const saved=JSON.parse(localStorage.getItem('equip_list_v2')),r=saved[src].records[0];
  ok(role+' single append on double click',r._supplements.length===1&&r._supplements[0].text===text);
  ok(role+' entire original record preserved',clean(r)===original);
  ok(role+' author and timestamp recorded',r._supplements[0].by==='隔离测试'&&r._supplements[0].at&&r._supplements[0].account==='fixture-'+role);
  ok(role+' revision enabled',!!saved[src]._recordsRev);
  ok(role+' supplement rendered escaped',!document.querySelector('#detail-content .report-supplements b')&&$('detail-content').textContent.includes('<b>新线索</b>'));
  ok(role+' original and repair progress remain visible',$('detail-content').textContent.includes('原始描述')&&$('detail-content').textContent.includes('等待备件'));
  if(role==='reporter')ok('reporter masked response',EQ[src].records[0].cost===undefined&&EQ[src].records[0]._supplements===undefined&&EQ[src].records[0].supplements.length===1);
  currentCode='not-current';openReportSupplementForDevice(encodeURIComponent(src),'r1');ok(role+' all-orders entry uses its own device',reportSupplement.code===src&&$('rs-history').textContent.includes(text));
  $('rs-text').value='第二次线索';$('rs-save').click();await tick();ok(role+' second append keeps earlier entry',JSON.parse(localStorage.getItem('equip_list_v2'))[src].records[0]._supplements.length===2);
  currentCode=src;renderRecordContext(EQ[src].records[0],true);ok(role+' completion context shows latest clues',$('rf-ctx').textContent.includes('第二次线索'));
  openReportSupplement('r1');$('rs-text').value='未提交草稿';const rect=el=>el.getBoundingClientRect();
  ok(role+' form fits viewport',['rs-text','rs-save','rs-cancel','rs-original'].every(id=>rect($(id)).right<=innerWidth+1));
  if(innerWidth<=600)ok(role+' mobile touch/typing sizes',rect($('rs-text')).height>=44&&parseFloat(getComputedStyle($('rs-text')).fontSize)>=16&&rect($('rs-save')).height>=44);
 }
 // Readable to repairers, but no extra append permission.
 ROLE='repairer';document.body.className='is-repairer';EQ=JSON.parse(localStorage.getItem('equip_list_v2'));currentCode=src;renderManageDetail(EQ[src]);ok('repairer sees supplements',!!document.querySelector('#detail-content .report-supplements'));ok('repairer no supplement action',!document.querySelector('#detail-content .supplement-act'));
 ROLE='reporter';document.body.className='is-reporter';EQ={[src]:maskForReport(JSON.parse(localStorage.getItem('equip_list_v2'))[src])};currentCode=src;openReportSupplement('r1');$('rs-text').value='补充：只在高速运行时发生，低速正常。';
 document.getElementById('OUT').textContent=JSON.stringify({ok:true,width:innerWidth,checks,networkCalls:0,physicalPrints:0});
 }catch(e){document.getElementById('OUT').textContent=JSON.stringify({ok:false,error:String(e.stack),checks})}});
</script>`;
const file=path.join(artifacts,'report_supplement_cdp.html');fs.writeFileSync(file,documentHtml.replace('</body>','<pre id="OUT" hidden></pre>'+fixture+'</body>'));
const pause=ms=>new Promise(r=>setTimeout(r,ms)),profile=path.join(artifacts,'supplement-cdp-'+Date.now());fs.mkdirSync(profile);
const log=fs.openSync(path.join(artifacts,'report_supplement_cdp.log'),'w');
const chrome=cp.spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore',log,log]});
let ws,id=0,passed=0;const pending=new Map(),deadline=setTimeout(()=>{chrome.kill();console.error('Browser deadline exceeded');process.exit(1)},45000);
function send(method,params={}){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))})}
async function evaluate(expression){const v=await send('Runtime.evaluate',{expression,returnByValue:true});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value}
(async()=>{const pf=path.join(profile,'DevToolsActivePort');for(let i=0;i<50&&!fs.existsSync(pf);i++)await pause(100);if(!fs.existsSync(pf))throw Error('No debug port');const port=fs.readFileSync(pf,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}});await send('Page.enable');for(const width of [390,1100]){await send('Emulation.setDeviceMetricsOverride',{width,height:950,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:new URL('file:///'+file.replace(/\\/g,'/')).href+'?width='+width});let data='';for(let i=0;i<100;i++){await pause(100);data=await evaluate('document.getElementById("OUT")?.textContent||""');if(data)break}if(!data)throw Error('Missing fixture result');const out=JSON.parse(data);passed+=(out.checks||[]).length;console.log(JSON.stringify(out));if(!out.ok||out.width!==width)throw Error('Supplement browser check failed '+width);const png=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifacts,'report_supplement_'+width+'.png'),Buffer.from(png.data,'base64'))}console.log(passed+' passed / 0 failed (real Chrome supplement UI; synthetic local data only)');})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{clearTimeout(deadline);if(ws){try{ws.send(JSON.stringify({id:++id,method:'Browser.close'}));ws.close()}catch(e){}}chrome.kill();fs.closeSync(log)});
