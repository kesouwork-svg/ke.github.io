// Real Chrome/CDP regression and self-contained synthetic preview builder.
// No server, real session, production RPC, notification or printing is used.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'outputs', 'Equipment_Analysis_V1_Branch_20261029');
fs.mkdirSync(outDir, { recursive: true });
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const js = s => s.replace(/<\/script/gi, '<\\/script');
const fixtureData = {
  'DEMO-MILL': { name: '演示平面磨床', line: '模具部', family: '磨床', records: [
    { id: 'a-open', no: 'DEMO-OPEN-01', type: 'fault', status: 'open', reportAt: '2026-09-12', expectedAt: '2026-09-16', symptom: '演示：高速时异响 <img src=x onerror="window.injected=1">' },
    { id: 'a-done', no: 'DEMO-DONE-01', type: 'fault', status: 'done', reportAt: '2026-10-01', doneAt: '2026-10-02', expectedAt: '2026-10-02', cost: 150, cause1: '电气', cause2: '线路', cause3: '接触故障' },
    { id: 'a-cross', type: 'fault', status: 'done', reportAt: '2026-09-28', doneAt: '2026-10-03', expectedAt: '2026-10-03', cost: 0, _supplements: [{ text: '不增加工单' }] },
    { id: 'a-maintain', type: 'maintain', status: 'done', reportAt: '2026-10-02', doneAt: '2026-10-02', cost: 990 }
  ] },
  'DEMO-PRESS': { name: '演示40T冲床', line: '冲压组', family: '冲床', records: [
    { id: 'b-done', no: 'DEMO-DONE-02', type: 'fault', status: 'done', reportAt: '2026-10-06', doneAt: '2026-10-07', expectedAt: '2026-10-07', cost: 25, cause1: '机械', cause2: '传动', cause3: '磨损' },
    { id: 'b-open', no: 'DEMO-OPEN-02', type: 'fault', status: 'open', reportAt: '2026-10-15', expectedAt: '', symptom: '演示：夹具动作异常，预计日期待确认' },
    { id: 'b-unknown', type: '', status: 'open', reportAt: '2026-10-10' }
  ] },
  'GEN-DEMO': { name: '通用报修 · 演示', line: '模具部', family: '行政/杂项', records: [
    { id: 'g-done', type: 'fault', status: 'done', reportAt: '2026-10-03', doneAt: '2026-10-05', expectedAt: '2026-10-05', cost: 0, cause1: '杂项', cause2: '照明', cause3: '灯具' }
  ] }
};
function setupScript(role, preview) {
  const data = JSON.parse(JSON.stringify(fixtureData));
  if (preview) data['DEMO-MILL'].records[0].symptom = '演示：高速时异响，停机后消失，等待备件';
  return `
const OriginalDate = Date; window.Date = class extends OriginalDate { constructor(...a){super(...(a.length?a:['2026-10-29T04:00:00Z']))} static now(){return OriginalDate.parse('2026-10-29T04:00:00Z')} };
window.fetch=()=>{throw Error('Business network forbidden')};window.XMLHttpRequest=function(){throw Error('XHR forbidden')};window.print=()=>{throw Error('Printing forbidden')};
const fixtureData=${JSON.stringify(data).replace(/</g, '\\u003c')};
const f=window.__analysisFixture={role:${JSON.stringify(role)},mode:'normal',calls:[],pendingMe:null,pendingList:null};
function user(role){return {account:'fixture-'+role,name:'隔离演示',level:2,tools:role==='admin'?['equipment-admin']:role==='repairer'?['equipment']:role==='reporter'?['equipment-report']:[],dept:'模具部',must_change_pwd:false}}
function session(role,token){return Object.assign({token:token||'isolated-'+role},user(role))}
${preview ? `let memory=session(f.role);window.SessionStore={get:()=>memory,merge:p=>(memory=Object.assign({},memory,p)),clear:()=>{memory=null}};window.EquipApi={session:()=>memory,user:()=>memory,role:()=>memory&&memory.tools.includes('equipment-admin')?'admin':memory&&memory.tools.includes('equipment')?'repairer':memory&&memory.tools.includes('equipment-report')?'reporter':'view',listAll:()=>eqRpc('equipment_list',{}).then(r=>r.ok?{ok:true,role:r.data.role,equipments:r.data.equipments}:r)};window.EqConfig={cloud:true};` : `SessionStore.write(JSON.stringify(session(f.role)));EqConfig.cloud=true;`}
window.eqRpc=function(name,args){f.calls.push(name);if(!['me','equipment_list'].includes(name))throw Error('Unexpected RPC '+name);if(f.mode==='fail')return Promise.reject(Error('合成网络失败'));if(name==='me'){const r={ok:true,data:{user:user(f.role)}};if(f.mode==='defer-me'){f.mode='normal';return new Promise(resolve=>{f.pendingMe={resolve,value:r}})}return Promise.resolve(r)}const r={ok:true,data:{role:f.role,equipments:fixtureData}};if(f.mode==='defer-list'){f.mode='normal';return new Promise(resolve=>{f.pendingList={resolve,value:r}})}if(f.mode==='deny-list')return Promise.resolve({ok:false,msg:'合成权限拒绝'});if(f.mode==='malformed')return Promise.resolve({ok:true,data:{}});return Promise.resolve(r)};
f.changeIdentity=function(role,token){f.role=role;${preview ? 'memory=session(role,token);' : 'SessionStore.write(JSON.stringify(session(role,token)));'}window.dispatchEvent(new StorageEvent('storage',{key:'roi_session'}))};
${preview ? `document.addEventListener('click',event=>{const a=event.target.closest('a');if(a){event.preventDefault();alert('这是合成数据离线预览，不连接真实系统或打开真实工单。')}},true);` : ''}
`;
}
function documentFor(role, preview) {
  let html = read('docs/equipment/analysis.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link[^>]+stylesheet[^>]*>/, '<style>' + read('docs/equipment/css/equipment-analysis.css') + '</style>');
  const logo = fs.readFileSync(path.join(root, 'docs/images/logo_cat.png')).toString('base64');
  html = html.replace('../images/logo_cat.png', 'data:image/png;base64,' + logo);
  if (preview) html = html.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'; form-action \'none\'; base-uri \'none\'">');
  if (preview) html = html.replace('<body>', '<body><div class="preview-banner">开发分支 · 合成数据离线预览 · 固定演示时点2026-10-29 · 不连接生产、不代表真实经营结果</div>');
  const dependencies = preview ? '' : '<script>' + js(read('docs/js/session.js')) + '</script><script>' + js(read('docs/equipment/js/equipment-api.js')) + '</script>';
  return html.replace('</body>', dependencies + '<script>' + js(setupScript(role, preview)) + '</script><script>' + js(read('docs/equipment/js/equipment-analysis-core.js')) + '</script><script>' + js(read('docs/equipment/js/equipment-analysis.js')) + '</script></body>');
}
function buildPreview() {
  const file = path.join(outDir, '设备维修分析V1_分支离线预览_合成数据.html');
  fs.writeFileSync(file, documentFor('admin', true)); return file;
}
async function run() {
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const profile = path.join(outDir, 'chrome-' + OriginalNow());fs.mkdirSync(profile);
  const log = fs.openSync(path.join(outDir, 'browser.log'), 'w');
  const chrome = cp.spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'], {stdio:['ignore',log,log]});
  let ws, id=0, total=0;const pending=new Map(), results=[];
  const deadline=setTimeout(()=>{chrome.kill();console.error('Browser deadline exceeded');process.exit(1)},60000);
  function send(method,params={}){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))})}
  async function evaluate(expression){const v=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value}
  async function until(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await pause(35)}throw Error('Wait failed: '+expression)}
  async function check(name, expression){const ok=!!await evaluate(expression);results.push({name,ok});total++;if(!ok){console.error(JSON.stringify(await evaluate('({cards:document.getElementById("summary-cards").innerText,range:document.getElementById("range-caption").textContent,error:document.getElementById("filter-error").textContent,calls:window.__analysisFixture&&__analysisFixture.calls})')));throw Error(name)}}
  async function navigate(role,width){const file=path.join(outDir,'browser_'+role+'_'+width+'.html');fs.writeFileSync(file,documentFor(role,false));await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:new URL('file:///'+file.replace(/\\/g,'/')).href});await until('window.__analysisFixture && !document.getElementById("refresh-data").disabled')}
  try {
    const pf=path.join(profile,'DevToolsActivePort');for(let i=0;i<60&&!fs.existsSync(pf);i++)await pause(75);if(!fs.existsSync(pf))throw Error('No Chrome debug port');
    const port=fs.readFileSync(pf,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});
    ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}});
    await send('Page.enable');
    for (const role of ['admin','repairer']) for(const width of [390,1440]) {
      const prefix=role+'/'+width+' ';
      await navigate(role,width);
      await check(prefix+'six cards visible','!document.getElementById("analysis-content").hidden && document.querySelectorAll(".stat-card").length===6');
      await check(prefix+'fault-only totals','document.querySelector("[data-metric=new] .value").textContent==="4" && document.querySelector("[data-metric=done] .value").textContent==="4"');
      await check(prefix+'period-independent backlog','document.querySelectorAll("#backlog-rows tr").length===2 && document.getElementById("backlog-rows").textContent.includes("2026-09-12")');
      await check(prefix+'no premature classification warning','document.getElementById("backlog-rows").textContent.indexOf("分类")===-1 && document.getElementById("quality-facts").textContent.includes("已完成分类待补 1 条")');
      await check(prefix+'generic outside device ranking','!document.getElementById("priority-rows").textContent.includes("GEN-DEMO") && document.getElementById("generic-rows").textContent.includes("GEN-DEMO")');
      await check(prefix+'registered amount and zero note','document.querySelector("[data-metric=amount] .value").textContent.includes("175") && document.getElementById("quality-facts").textContent.includes("本期金额0：2 条")');
      await check(prefix+'escaped symptom and safe original link','!window.injected && !document.querySelector("#backlog-rows img") && new URL(document.querySelector("#backlog-rows a").href).searchParams.get("wo")==="DEMO-OPEN-01"');
      await check(prefix+'read calls only','JSON.stringify(__analysisFixture.calls)===JSON.stringify(["me","equipment_list"])');
      await check(prefix+'no page-level horizontal overflow','document.documentElement.scrollWidth<=innerWidth+1');
      await check(prefix+'accessible trend graphic and rows','!!document.querySelector("svg[role=img]") && document.querySelectorAll("#trend-rows tr").length===29');
      const screenshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(outDir,'analysis_'+role+'_'+width+'.png'),Buffer.from(screenshot.data,'base64'));
      await evaluate('document.getElementById("department").value="模具部";document.getElementById("analysis-filters").requestSubmit()');
      await check(prefix+'department local filter without network','document.querySelector("[data-metric=backlog] .value").textContent==="1" && __analysisFixture.calls.length===2');
      await evaluate('document.querySelector("[data-period=previous]").click()');
      await check(prefix+'previous month still includes all current backlog','document.querySelector("[data-metric=backlog] .value").textContent==="1" && document.getElementById("range-caption").textContent.includes("2026-09-01")');
      await evaluate('document.getElementById("reset-filters").click();document.getElementById("family").value="冲床";document.getElementById("analysis-filters").requestSubmit()');
      await check(prefix+'family filter','!document.getElementById("priority-rows").textContent.includes("DEMO-MILL") && document.getElementById("priority-rows").textContent.includes("DEMO-PRESS")');
      await evaluate('document.getElementById("reset-filters").click();document.getElementById("date-start").value="2026-10-20";document.getElementById("date-end").value="2026-10-01";document.getElementById("analysis-filters").dispatchEvent(new Event("submit",{cancelable:true}))');
      await check(prefix+'invalid range explicit error','!document.getElementById("filter-error").hidden && document.querySelector("[data-metric=new] .value").textContent==="4"');
      await evaluate('document.getElementById("reset-filters").click();__analysisFixture.mode="fail";document.getElementById("refresh-data").click()');await until('!document.getElementById("refresh-data").disabled');
      await check(prefix+'read failure clears old sensitive data','document.getElementById("analysis-content").hidden && !document.getElementById("retry-data").hidden && document.getElementById("backlog-rows").textContent===""');
      await evaluate('__analysisFixture.mode="normal";document.getElementById("retry-data").click()');await until('!document.getElementById("refresh-data").disabled');
      await check(prefix+'retry restores authorized report','!document.getElementById("analysis-content").hidden');
    }
    for(const role of ['reporter','view']) {await navigate(role,1100);await check(role+' denied without full list read','document.getElementById("analysis-content").hidden && JSON.stringify(__analysisFixture.calls)===JSON.stringify(["me"])')}
    await navigate('admin',1100);
    await evaluate('__analysisFixture.mode="malformed";document.getElementById("refresh-data").click()');await until('!document.getElementById("refresh-data").disabled');
    await check('malformed payload not shown as empty totals','document.getElementById("analysis-content").hidden && !document.getElementById("retry-data").hidden && document.querySelectorAll(".stat-card").length===0');
    await evaluate('__analysisFixture.mode="normal";document.getElementById("retry-data").click()');await until('!document.getElementById("refresh-data").disabled');
    await evaluate('__analysisFixture.mode="defer-me";document.getElementById("refresh-data").click()');await until('!!__analysisFixture.pendingMe');
    await evaluate('__analysisFixture.changeIdentity("repairer","changed-identity")');await until('!document.getElementById("refresh-data").disabled');
    await evaluate('__analysisFixture.pendingMe.resolve(__analysisFixture.pendingMe.value);Promise.resolve()');
    await check('late me cannot restore previous identity','SessionStore.get().token==="changed-identity" && SessionStore.get().account==="fixture-repairer"');
    await evaluate('__analysisFixture.mode="defer-list";document.getElementById("refresh-data").click()');await until('!!__analysisFixture.pendingList');
    await evaluate('__analysisFixture.changeIdentity("reporter","downgraded")');await until('!document.getElementById("refresh-data").disabled');
    await evaluate('__analysisFixture.pendingList.resolve(__analysisFixture.pendingList.value);Promise.resolve()');
    await check('late full list after downgrade stays hidden','document.getElementById("analysis-content").hidden && document.getElementById("priority-rows").textContent===""');
    const previewFile=buildPreview();
    for(const width of [390,1440]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
      await send('Page.navigate',{url:new URL('file:///'+previewFile.replace(/\\/g,'/')).href});
      await until('window.__analysisFixture && !document.getElementById("refresh-data").disabled');
      const prefix='offline-preview/'+width+' ';
      await check(prefix+'CSP and synthetic banner',`document.querySelector('meta[http-equiv]').content.includes("connect-src 'none'") && document.querySelector('.preview-banner').textContent.includes('合成数据离线预览')`);
      await check(prefix+'six cards work under CSP','!document.getElementById("analysis-content").hidden && document.querySelectorAll(".stat-card").length===6 && document.querySelector("[data-metric=new] .value").textContent==="4"');
      await check(prefix+'preview text sanitized','!document.getElementById("backlog-rows").textContent.includes("onerror") && !document.querySelector("#backlog-rows img")');
      await check(prefix+'no full-page overflow','document.documentElement.scrollWidth<=innerWidth+1');
      await evaluate('document.getElementById("department").value="模具部";document.getElementById("analysis-filters").requestSubmit()');
      await check(prefix+'filter works without additional reads','document.querySelector("[data-metric=backlog] .value").textContent==="1" && JSON.stringify(__analysisFixture.calls)===JSON.stringify(["me","equipment_list"])');
      await evaluate('window.previewBefore=location.href;window.alert=m=>{window.previewAlert=m};document.querySelector("#backlog-rows a").click()');
      await check(prefix+'original-order navigation stays offline','location.href===previewBefore && previewAlert.includes("合成数据") && __analysisFixture.calls.length===2');
      const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(outDir,'analysis_preview_'+width+'.png'),Buffer.from(shot.data,'base64'));
    }
    const summary={ok:true,checks:total,network:false,productionAccess:false,physicalPrints:0,results};fs.writeFileSync(path.join(outDir,'browser_validation.json'),JSON.stringify(summary,null,2));
    console.log(total+' passed / 0 failed (real Chrome; synthetic data; no production calls)');console.log('Preview: '+buildPreview());
  } finally {clearTimeout(deadline);if(ws){try{ws.send(JSON.stringify({id:++id,method:'Browser.close'}));ws.close()}catch(e){}}chrome.kill();fs.closeSync(log)}
}
function OriginalNow(){return Date.now()}
if(require.main===module){if(process.argv.includes('--preview-only'))console.log(buildPreview());else run().catch(e=>{console.error(e);process.exitCode=1})}
module.exports={buildPreview,documentFor,fixtureData};
