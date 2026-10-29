// Node 22+ / desktop Chrome. Synthetic, self-contained offline UI review + real layout checks.
// No API/SDK, real session, production requests, hardware, or changes to app behavior.
const fs = require('fs'), path = require('path'), cp = require('child_process'), zlib = require('zlib'), crypto = require('crypto');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'outputs/Equipment_UI_V2_Mobile_Actions_20261029');
fs.mkdirSync(out, {recursive:true});
const read = p => fs.readFileSync(path.join(root,p),'utf8'), git = 'D:\\AI\\Git\\cmd\\git.exe';
function baseline(ref, filename) {
 const dst=path.join(out,filename), fd=fs.openSync(dst,'w');
 const r=cp.spawnSync(git,['show','f78f9229f72ed5a6bbd0c19d2ffc55b3efbf2893:'+ref],{cwd:root,stdio:['ignore',fd,'inherit']}); fs.closeSync(fd);
 if(r.status!==0)throw Error('Baseline extraction failed: '+ref); return fs.readFileSync(dst,'utf8');
}
const oldCss=baseline('docs/equipment/css/equipment.css','baseline_equipment.css'), oldHtml=baseline('docs/equipment/index.html','baseline_index.html');
const css=read('docs/equipment/css/equipment.css'), app=read('docs/equipment/js/equipment-app.js');
const hash=s=>crypto.createHash('sha256').update(s.replace(/\r\n/g,'\n')).digest('hex');
const beforeApp=baseline('docs/equipment/js/equipment-app.js','baseline_app.js');
function withoutDetailActionsUI(s) {
 s=s.replace(/\r\n/g,'\n');
 const start='// ---------- 详情更多操作（手机） ----------',end='// ---------- 详情更多操作结束 ----------\n\n';
 const a=s.indexOf(start),b=s.indexOf(end,a);if(a<0||b<0)throw Error('Expected reviewed detail-menu helpers');
 s=s.slice(0,a)+s.slice(b+end.length);
 s=s.replace('function switchView(name, opts) {\n    closeListActions();\n    closeDetailActions();','function switchView(name, opts) {\n    closeListActions();');
 s=s.replace("        + (C.manageDevices ? '<div id=\"detail-more\" class=\"detail-more\"><button type=\"button\" class=\"btn btn-sm detail-more-toggle\" aria-label=\"更多设备操作\" aria-expanded=\"false\" aria-controls=\"detail-more-panel\" onclick=\"toggleDetailActions(event)\">⋯</button><div id=\"detail-more-panel\" class=\"detail-more-panel\" onclick=\"closeDetailActions()\">' : '')\n",'');
 s=s.replace("        + (C.manageDevices ? '</div></div>' : '')\n        + '</div></div>';\n\n    var stats =","        + '</div></div>';\n\n    var stats =");
 return s;
}
if(hash(withoutDetailActionsUI(app))!==hash(beforeApp))throw Error('Only the reviewed detail-menu UI may change; original business logic must remain intact');
if(!css.replace(/\r\n/g,'\n').startsWith(oldCss.replace(/\r\n/g,'\n').trimEnd()))throw Error('Original rules, including print, must remain unchanged');
const canon=s=>s.replace(/\r\n/g,'\n').replace(/equipment\.css\?v=[a-f0-9]+/g,'equipment.css?v=HASH').replace(/equipment-app\.js\?v=[a-f0-9]+/g,'equipment-app.js?v=HASH');
if(canon(read('docs/equipment/index.html'))!==canon(oldHtml))throw Error('HTML must differ only by the CSS content hash');
const compressed=s=>({raw:Buffer.byteLength(s),gzip:zlib.gzipSync(s,{level:6}).length,brotli:zlib.brotliCompressSync(s,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:6}}).length});
const sizes={baseline:compressed(oldCss),preview:compressed(css)};sizes.gzipDelta=sizes.preview.gzip-sizes.baseline.gzip;
if(sizes.gzipDelta>5*1024)throw Error('CSS compressed increment exceeds 5 KiB');
const extra=css.slice(css.indexOf('/* ===== UI V2'));
if(!extra.includes('@media screen')||/@import|@font-face|backdrop-filter|url\(|@keyframes|animation\s*:/.test(extra))throw Error('UI layer must remain screen-only and dependency/animation free');
const originalScripts=[...oldHtml.matchAll(/<script[^>]+src="([^"]+)/g)].map(m=>m[1]);
let page=read('docs/equipment/index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]+rel="stylesheet"[^>]*>/gi,'');
const image=fs.readFileSync(path.join(root,'docs/images/logo_cat.png')).toString('base64');page=page.replace('../images/logo_cat.png','data:image/png;base64,'+image);
page=page.replace('<head>','<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'; base-uri \'none\'; form-action \'none\'">');
page=page.replace('</head>','<style id="equipment-style">'+css+'</style><style>@media screen{body.preview-original #detail-panel .detail-more,body.preview-original #detail-panel .detail-more-panel{display:contents}body.preview-original #detail-panel .detail-more-toggle{display:none!important}}.preview-note{background:#e9f2f8;color:#31516e;padding:8px 16px;font-size:12px;text-align:center;line-height:1.6}.preview-dock{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:90;display:flex;align-items:center;gap:5px;background:#fff;border:1px solid #b9cfdf;border-radius:12px;padding:6px;box-shadow:0 4px 16px #172e481c;max-width:calc(100vw - 20px);white-space:nowrap}.preview-dock button,.preview-dock select{font:inherit;font-size:12px;min-height:36px;border:0;border-radius:7px;padding:6px 10px;background:#eff4f8;color:#23445e;cursor:pointer}.preview-dock button.chosen{background:#23679b;color:#fff}.preview-dock select{max-width:90px}.preview-toast{pointer-events:none}@media(max-width:360px){.preview-dock button{padding:6px 8px}}@media print{.preview-dock,.preview-note{display:none!important}}</style></head>');
// Keep the real sticky header at document top; an above-header demo banner changes safeTop during scrolling.
page=page.replace('<div class="eq-main">','<div class="eq-main"><div class="preview-note">本地 UI 评审 · 全部为合成演示数据 · 未合并、未上线<br>先确认列表与详情；表单、二维码和其他页面不在本轮改版范围。</div>');
const dock='<div class="preview-dock" aria-label="本地预览控制"><button onclick="previewList()">设备列表</button><button onclick="previewDetail()">设备详情</button><button id="preview-compare" onclick="previewTheme()">对比原版</button><select id="preview-role" aria-label="演示角色" onchange="previewSetup(this.value)"><option value="admin">管理员</option><option value="repairer">维修人</option><option value="reporter">报修人</option><option value="view">只读</option></select></div>';
const code = String.raw`
const NativeDate=Date;window.Date=class extends NativeDate{constructor(...a){super(...(a.length?a:['2026-10-29T13:20:00+08:00']))}static now(){return new NativeDate('2026-10-29T13:20:00+08:00').getTime()}};
window.fetch=()=>{throw Error('Business network forbidden')};window.XMLHttpRequest=class{constructor(){throw Error('Business network forbidden')}};window.print=()=>{throw Error('Physical printing forbidden')};window.open=()=>{throw Error('External windows forbidden')};
window.previewNativeScroll=window.scrollTo.bind(window);window.previewNetwork=0;
window.demoData={};
function demoRecord(i,j){const done=j%4!==0;return {id:'demo-'+i+'-'+j,no:'DEMO-WO-'+String(i).padStart(2,'0')+'-'+String(j).padStart(2,'0'),type:j===3?'maintain':'fault',status:done?'done':'open',reportAt:'2026-10-'+String(26-j%20).padStart(2,'0'),expectedAt:'2026-10-28',doneAt:done?'2026-10-'+String(27-j%20).padStart(2,'0'):'',reportBy:'演示报修组',handler:done?'演示维修组':'',symptom:['设备运行时出现周期性异响，需检查传动连接与导向部位。','低速运行正常，连续作业后出现定位偏差，请协助排查。','操作面板有间歇性报警，已记录现象并安排现场检查。','例行检查与润滑保养，确认防护及紧固件状态。'][j%4],place:'演示车间 · A区',cause1:done?'生产设备设施维修维护':'',cause2:done?'设备机械故障':'',cause3:done?'紧固连接部件松动':'',action:done?'完成检查、紧固及复测，恢复正常运行。':'',cost:done?(j%3===1?180:0):0,updates:done?[]:[{at:'2026-10-27 09:20',by:'演示维修组',text:'已安排检查，正在确认备件规格及到货时间。'}],_supplements:j===0?[{at:'2026-10-26 15:30',by:'演示报修组',text:'补充线索：仅在连续运行后出现，暂停再启动时暂未复现。'}]:[]}}
for(let i=1;i<=18;i++){const code='DEMO-'+String(i).padStart(3,'0'),family=i<=6?'磨削/抛光':i<=12?'冲床/精冲':'加工中心/雕刻机';demoData[code]={code,number:'DEMO-'+String(i).padStart(3,'0'),name:(i<=6?'手摇平面磨床':i<=12?'精密冲床':'立式加工中心')+' · '+String((i-1)%6+1).padStart(2,'0'),line:i<=15?'模具部':'机加组',family,category:'prod',status:i===6?'idle':'active',model:i<=6?'M-618 · 演示规格':i<=12?'40T · 演示规格':'VMC-850 · 演示规格',owner:'演示设备组',installDate:'2022-06-01',records:Array.from({length:i===1?38:3+i%5},(_,j)=>demoRecord(i,j))}}
demoData['GEN-DEMO']={code:'GEN-DEMO',name:'通用报修 · 模具部',line:'模具部',number:'',family:'事务杂项',category:'misc',status:'active',records:[{...demoRecord(90,0),symptom:'演示区域照明闪烁，尚未归属到固定设备。'}]};
window.genericCode=()=> 'GEN-DEMO';window.eqUser=()=>EquipApi.user();window.eqSession=()=>({account:'demo',dept:'模具部'});window.eqRole=()=>ROLE;
window.EquipApi={user:()=>({account:'demo',name:'本地演示',dept:'模具部',tools:['equipment-admin']}),getDevice:code=>Promise.resolve({ok:true,role:ROLE,equipment:ROLE==='admin'||ROLE==='repairer'?EQ[code]:previewMask(EQ[code])})};
function previewMask(e){return {...e,records:(e.records||[]).map(r=>({id:r.id,no:r.no,type:r.type,status:r.status,reportAt:r.reportAt,expectedAt:r.expectedAt,doneAt:r.doneAt,symptom:r.symptom,place:r.place,updates:r.updates,supplements:(r._supplements||[]).map(s=>({at:s.at,by:s.by,text:s.text}))}))}}
function previewSetup(role='admin'){
 ROLE=role;EQ=JSON.parse(JSON.stringify(demoData));MY_DEPT='模具部';currentCode='';pendingWo='';document.body.className='is-'+role;document.body.classList.toggle('preview-original',!window.previewIsNew);
 $('eq-role').className='role-chip role-'+role;$('eq-role').textContent={admin:'设备管理员',repairer:'维修人',reporter:'报修人',view:'只读'}[role];$('eq-user').textContent='合成演示';$('preview-role').value=role;$('analysis-link').hidden=!caps().seeList;
 $('f-q').value='';$('f-line').innerHTML='<option>模具部</option><option>机加组</option><option value="">全部部门</option>';$('f-line').value='模具部';$('f-cat').value='';taskFilter='';
 listSectionOpen={equipment:true,generic:false,mineEquipment:true};groupOpen={'磨削/抛光':true};mineGroupOpen={};GORDERS={'':[{n:'磨削/抛光',pin:true}]};
 $('detail-content').innerHTML='<div class="empty">从设备列表选择一台设备，查看设备信息和工单履历。</div>';
 renderList();renderTodoBadge();syncTaskFilterButtons();switchView('list');if(!caps().seeList)previewDetail();
}
function previewDetail(){openDetail('DEMO-001',true)}
function previewList(){if(caps().seeList){showListDefault()}else{showToast('该演示角色没有全量设备列表权限。')}}
window.previewIsNew=true;
function previewTheme(){previewIsNew=!previewIsNew;document.body.classList.toggle('preview-original',!previewIsNew);closeDetailActions();$('equipment-style').textContent=previewIsNew?window.previewNewCSS:window.previewOldCSS;$('preview-compare').textContent=previewIsNew?'对比原版':'回到新版';if(currentCode)openDetail(currentCode,true)}
function setupPreview(){
 for(const fn of ['openArchiveForm','openReportForm','openRecordForm','openCompleteForm','openReplyForm','openReportSupplement','openReportCorrection','openTransfer','openAudit','deleteEquipment','deleteRecord','showLabels','openNotifySettings','testDailyTodo','runListAction'])window[fn]=()=>{showToast('此处仅评审列表与详情；不保存工单、不发送通知或执行打印。');closeListActions()};
 window.refreshList=()=>{showToast('本地合成演示，不连接后台。');renderList()};window.goToolHome=previewList;
 document.addEventListener('click',e=>{const a=e.target.closest('a');if(a){e.preventDefault();showToast('离线预览不跳转或连接正式站。')}},true);
 document.addEventListener('submit',e=>e.preventDefault(),true);previewSetup();window.PREVIEW_READY=true;
}
`;
const escScript=s=>s.replace(/<\/script/gi,'<\\/script');
const preload='<script>window.previewOldCSS='+JSON.stringify(oldCss)+';window.previewNewCSS='+JSON.stringify(css)+';</script>';
page=page.replace('</body>',dock+preload+'<script>'+escScript(code)+'</script><script>'+escScript(app.replace('    eqInit();','    setupPreview();'))+'</script></body>');
const file=path.join(out,'设备履历卡_UI_V2_手机操作收纳_交互预览.html');fs.writeFileSync(file,page);
if(process.argv.includes('--build-only')){console.log(JSON.stringify({file,sizes,originalScripts}));process.exit(0)}
const pause=ms=>new Promise(r=>setTimeout(r,ms)),profile=path.join(out,'chrome-'+NativeDateNow());function NativeDateNow(){return Date.now()}
fs.mkdirSync(profile);const log=fs.openSync(path.join(out,'browser.log'),'w');
const chrome=cp.spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore',log,log]});
let ws,id=0;const pending=new Map(),checks=[],perf=[];const deadline=setTimeout(()=>{chrome.kill();console.error('Preview test deadline exceeded');process.exit(1)},100000);
function send(method,params={}){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))})}
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
function ok(name,value){checks.push({name,ok:!!value});if(!value)throw Error(name)}
async function shot(name){const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'))}
async function click(selector){const p=await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e)throw Error("Missing click target");const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error("Hidden click target");return {x:r.left+r.width/2,y:r.top+r.height/2}})()');await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});}
(async()=>{
 const pf=path.join(profile,'DevToolsActivePort');for(let i=0;i<70&&!fs.existsSync(pf);i++)await pause(100);if(!fs.existsSync(pf))throw Error('No Chrome port');const port=fs.readFileSync(pf,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}});await send('Page.enable');
 for(const width of [390,1440,320]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:new URL('file:///'+file.replace(/\\/g,'/')).href});let ready=false;for(let i=0;i<70;i++){await pause(60);if(await evaluate('!!window.PREVIEW_READY')){ready=true;break}}if(!ready)throw Error('Offline preview did not initialize');
  ok(width+' list fits page',await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
  ok(width+' mobile filters remain usable',await evaluate('innerWidth>600||[...document.querySelectorAll(".list-filters input,.list-filters select")].every(e=>e.getBoundingClientRect().height>=44&&parseFloat(getComputedStyle(e).fontSize)>=16)'));
  ok(width+' phone grid and desktop flex preserved',await evaluate('getComputedStyle(document.querySelector(".list-filters")).display===(innerWidth<=600?"grid":"flex")'));
  ok(width+' three native filters stay in one row',await evaluate('new Set([...document.querySelectorAll(".list-filters input,.list-filters select")].map(e=>Math.round(e.getBoundingClientRect().top))).size===1'));
  ok(width+' list count and closed groups retained',await evaluate('$("eq-count").textContent.includes("16")&&!groupOpen["冲床/精冲"]'));
  if(width!==320)await shot('list_admin_'+width);
  await evaluate('previewDetail()');await pause(650);
  ok(width+' detail fits page',await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
  ok(width+' original six statistics',await evaluate('document.querySelectorAll("#detail-panel .stat-box").length===6'));
  ok(width+' loaded details are not an empty-state frame',await evaluate('getComputedStyle($("detail-content")).textAlign==="left"&&parseFloat(getComputedStyle($("detail-content")).borderTopWidth)===0&&getComputedStyle(document.querySelector("#detail-panel .timeline")).textAlign==="left"'));
  ok(width+' title aligned below header',await evaluate('Math.abs(document.querySelector(".detail-head").getBoundingClientRect().top-document.querySelector(".eq-header").getBoundingClientRect().bottom-12)<2'));
  ok(width+' real record limit unchanged',await evaluate('document.querySelectorAll("#detail-panel .tl-item").length===30'));
  ok(width+' action row matches phone or desktop',await evaluate('(()=>{const b=[...document.querySelectorAll(".detail-actions button")].filter(e=>e.getBoundingClientRect().width>0);return b.length===(innerWidth<=600?3:7)&&new Set(b.map(e=>Math.round(e.getBoundingClientRect().top))).size===1&&b[0].textContent.includes("报修")&&b[1].textContent==="登记完成/保养"})()'));
  ok(width+' secondary actions have one DOM copy',await evaluate('document.querySelectorAll("#detail-more-panel button").length===5&&[...document.querySelectorAll("#detail-more-panel button")].map(e=>e.textContent).join("|")==="编辑档案|转移到其他车间|二维码|编辑记录|删除"'));
  if(width!==320)await shot('detail_admin_'+width);
  await click('#preview-compare');await pause(650);
  ok(width+' original comparison restores seven direct actions',await evaluate('[...document.querySelectorAll(".detail-actions button")].filter(e=>e.getBoundingClientRect().width>0).length===7'));
  await click('#preview-compare');await pause(650);
  ok(width+' new comparison restores phone action row',await evaluate('[...document.querySelectorAll(".detail-actions button")].filter(e=>e.getBoundingClientRect().width>0).length===(innerWidth<=600?3:7)'));
  if(width<=600){
   await evaluate('window.menuY=scrollY;window.menuHeadHeight=document.querySelector(".detail-head").getBoundingClientRect().height');
   await click('.detail-more-toggle');
   ok(width+' native more opens with ARIA state',await evaluate('$("detail-more").classList.contains("is-open")&&document.querySelector(".detail-more-toggle").getAttribute("aria-expanded")==="true"'));
   ok(width+' menu fits without moving header or scroll',await evaluate('(()=>{const r=$("detail-more-panel").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&Math.abs(scrollY-menuY)<2&&Math.abs(document.querySelector(".detail-head").getBoundingClientRect().height-menuHeadHeight)<1})()'));
   ok(width+' secondary menu is touch friendly',await evaluate('[...document.querySelectorAll("#detail-more-panel button")].every(e=>e.getBoundingClientRect().height>=44)'));
   if(width===390)await shot('detail_actions_open_390');
   await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});
   ok(width+' escape closes and restores trigger focus',await evaluate('!$("detail-more").classList.contains("is-open")&&document.activeElement===document.querySelector(".detail-more-toggle")'));
   await click('.detail-more-toggle');await click('.detail-title');
   ok(width+' outside native click closes menu',await evaluate('!$("detail-more").classList.contains("is-open")'));
   await evaluate('window.previewActionCalls=[];for(const fn of ["openArchiveForm","openTransfer","showLabels","openAudit","deleteEquipment"])window[fn]=(...args)=>previewActionCalls.push({fn,args})');
   const actionNames=['openArchiveForm','openTransfer','showLabels','openAudit','deleteEquipment'];
   for(let i=0;i<actionNames.length;i++){await click('.detail-more-toggle');await click('#detail-more-panel button:nth-child('+(i+1)+')');ok(width+' original '+actionNames[i]+' dispatch and close',await evaluate('previewActionCalls.length==='+JSON.stringify(i+1)+'&&previewActionCalls['+i+'].fn==='+JSON.stringify(actionNames[i])+'&&!$("detail-more").classList.contains("is-open")'));}
   ok(width+' device-specific action arguments retained',await evaluate('previewActionCalls[0].args[0]==="DEMO-001"&&previewActionCalls[2].args[0][0]==="DEMO-001"&&previewActionCalls[4].args[0]==="DEMO-001"'));
   await click('.detail-more-toggle');await evaluate('switchView("report")');
   ok(width+' view switch closes menu',await evaluate('!$("detail-more").classList.contains("is-open")'));
   await evaluate('previewDetail()');await pause(650);
  }else{ok(width+' desktop has no overflow trigger',await evaluate('getComputedStyle(document.querySelector(".detail-more-toggle")).display==="none"'));}
  await evaluate('previewNativeScroll(0,scrollY+300);window.savedY=scrollY;tlMore()');await pause(80);
  ok(width+' more keeps position',await evaluate('Math.abs(scrollY-savedY)<2&&document.querySelectorAll("#detail-panel .tl-item").length===38'));
  ok(width+' no external resources',await evaluate('performance.getEntriesByType("resource").every(r=>r.name.startsWith("data:"))'));
  for(const role of ['repairer','reporter','view']){
   await evaluate('previewSetup('+JSON.stringify(role)+');previewDetail()');await pause(80);
   ok(width+' '+role+' detail fits',await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
   ok(width+' '+role+' no admin overflow actions',await evaluate('!$("detail-more")&&!document.querySelector("#detail-panel [onclick^=openArchiveForm]")'));
   ok(width+' '+role+' permissions retained',await evaluate('document.querySelectorAll("#detail-panel .stat-box").length==='+(['repairer'].includes(role)?6:0)+'&&!document.querySelector("#detail-panel [onclick^=deleteEquipment]")'));
   ok(width+' '+role+' list/analysis scope',await evaluate('(getComputedStyle(document.querySelector(".list-only")).display!=="none")==='+JSON.stringify(role==='repairer')+'&&$("analysis-link").hidden==='+JSON.stringify(role!=='repairer')));
  }
 }
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await evaluate('previewSetup("admin");previewDetail()');await pause(500);
 const bench=await evaluate(`(()=>{const median=a=>a.sort((x,y)=>x-y)[Math.floor(a.length/2)];const result=[];for(let round=0;round<6;round++)for(const newer of round%2?[true,false]:[false,true]){$('equipment-style').textContent=newer?previewNewCSS:previewOldCSS;document.body.classList.toggle('preview-original',!newer);const a=[],b=[];for(let i=0;i<12;i++){let t=performance.now();renderList();document.body.offsetHeight;a.push(performance.now()-t);t=performance.now();renderManageDetail(EQ['DEMO-001'],{noScroll:true});document.body.offsetHeight;b.push(performance.now()-t)}result.push({round,newer,list:median(a),detail:median(b),nodes:document.querySelectorAll('#view-list *').length,records:document.querySelectorAll('#detail-panel .tl-item').length})}return result})()`);perf.push(...bench);
 ok('A/B DOM and record count unchanged',new Set(bench.map(x=>x.nodes)).size===1&&new Set(bench.map(x=>x.records)).size===1);
 // Emulated print only: no print() calls, printers, raster generation, or SDK.
 await evaluate(`$('view-labels').innerHTML='<div class="labels"><div class="label-card"><div class="label-qr"><svg></svg></div><div class="label-info"><div class="label-name">演示标签</div><div class="label-code">DEMO</div></div></div></div>';switchView('labels')`);
 await send('Emulation.setEmulatedMedia',{media:'print'});
 const printed=[];for(const newer of [false,true])printed.push(await evaluate(`(()=>{$('equipment-style').textContent=${newer?'previewNewCSS':'previewOldCSS'};const properties=['display','width','height','padding','border','fontSize','lineHeight','pageBreakAfter','overflow'];return ['.label-card','.label-qr svg','.label-name','.label-code','.eq-main','.eq-header'].map(s=>{const c=getComputedStyle(document.querySelector(s));return properties.map(p=>c[p])})})()`));
 ok('Print computed styles identical to baseline',JSON.stringify(printed[0])===JSON.stringify(printed[1]));
 await send('Emulation.setEmulatedMedia',{media:''});
 const report={ok:true,checks,sizes,benchmarks:perf,appSha256:hash(app),baseline:'f78f9229f72ed5a6bbd0c19d2ffc55b3efbf2893',file,originalScripts,limits:['Synthetic offline Chrome, not production or user-device network speed','A/B render medians include forced layout; headless synthetic observation, not an SLA','Print media emulated only; no printer or actual labels sent','No business APIs, real sessions/data, notifications, fonts, or external images']};
 fs.writeFileSync(path.join(out,'ui_preview_validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({ok:true,passed:checks.length,sizes,benchmarks:perf,file}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{clearTimeout(deadline);if(ws){try{ws.send(JSON.stringify({id:++id,method:'Browser.close'}));ws.close()}catch(e){}}chrome.kill();fs.closeSync(log)});
