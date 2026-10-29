'use strict';
/** Offline real-Chrome remaining-screen regression. Synthetic data only; no business writes or printing.
 * Generates a NEW self-contained preview directory. Existing preview/test outputs are never touched.
 * Run: node tools/test_equipment_remaining_ui.js [--build-only]
 */
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const zlib = require('zlib');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'outputs/Equipment_UI_V2_All_Screens_20261029');
const baseline = '8c840025d36ceb98fe546def08a54c50a17ad6c9';
fs.mkdirSync(out, { recursive: true });
const norm = s => s.replace(/\r\n/g, '\n');
const read = p => norm(fs.readFileSync(path.join(root, p), 'utf8'));
const hash = s => crypto.createHash('sha256').update(norm(s)).digest('hex');
const checks = [], failures = [];
function check(ok, name, detail) { checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) }); if (!ok) failures.push({ name, detail }); }
function requireCheck(ok, name, detail) { check(ok, name, detail); if (!ok) throw Error(name + (detail ? ': ' + JSON.stringify(detail) : '')); }
// Git writes to an explicit fd, not piped stdout (works with the confined Windows runner too).
function gitText(args, name) {
  const target = path.join(out, '_baseline_' + name + '.txt'), fd = fs.openSync(target, 'w');
  let r; try { r = cp.spawnSync('git', args, { cwd: root, stdio: ['ignore', fd, 'inherit'], windowsHide: true }); } finally { fs.closeSync(fd); }
  if (r.error) throw r.error; if (r.status !== 0) throw Error('git command failed: ' + args.join(' '));
  return norm(fs.readFileSync(target, 'utf8'));
}
const old = (p, n) => gitText(['show', baseline + ':' + p], n);
const cssPath = 'docs/equipment/css/equipment.css', htmlPath = 'docs/equipment/index.html';
const oldCss = old(cssPath, 'css'), css = read(cssPath), oldHtml = old(htmlPath, 'html'), html = read(htmlPath);
const jsPaths = gitText(['ls-tree', '-r', '--name-only', baseline, '--', 'docs'], 'js_paths').trim().split('\n').filter(p => p.endsWith('.js'));
for (let i = 0; i < jsPaths.length; i++) {
  const p = jsPaths[i]; requireCheck(hash(read(p)) === hash(old(p, 'js_' + i)), 'source JS unchanged: ' + p);
}
const newJs = [];
function collect(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, item.name); if (item.isDirectory()) collect(p); else if (p.endsWith('.js')) newJs.push(path.relative(root, p).split(path.sep).join('/')); } }
collect(path.join(root, 'docs'));
requireCheck(newJs.sort().join('\n') === jsPaths.slice().sort().join('\n'), 'business JS file set unchanged');
const canonHtml = s => s.replace(/(\.\/css\/equipment\.css\?v=)[a-f0-9]+/g, '$1CSS_HASH');
requireCheck(canonHtml(html) === canonHtml(oldHtml), 'HTML only CSS cache hash changed');
requireCheck(css.startsWith(oldCss), 'CSS keeps complete normalized baseline prefix');
const extra = css.slice(oldCss.length);
const sourceHashes = { cssSHA256: hash(css), htmlSHA256: hash(html), appSHA256: hash(read('docs/equipment/js/equipment-app.js')) };
requireCheck(!/@import|url\s*\(|@font-face|@keyframes|\b(?:animation|filter|backdrop-filter)\s*:/i.test(extra), 'new CSS has no network/fonts/animation/filter');
function screenLayersOnly(s) {
  s = s.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  while (s) {
    if (!/^@media\s+screen\b/i.test(s)) return false;
    const first = s.indexOf('{'); if (first < 0) return false;
    let depth = 1, q = '', i = first + 1;
    for (; i < s.length && depth; i++) { const c = s[i]; if (q) { if (c === '\\') i++; else if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '{') depth++; else if (c === '}') depth--; }
    if (depth) return false; s = s.slice(i).trim();
  }
  return true;
}
requireCheck(screenLayersOnly(extra), 'all added CSS is structurally inside screen media layers');
requireCheck(zlib.gzipSync(css).length - zlib.gzipSync(oldCss).length <= 5 * 1024, 'CSS gzip increment <=5KiB', { baseline: zlib.gzipSync(oldCss).length, current: zlib.gzipSync(css).length });
if (!process.argv.includes('--build-only')) requireCheck(!!extra.trim(), 'remaining-screen CSS has landed');

const app = read('docs/equipment/js/equipment-app.js');
const api = read('docs/equipment/js/equipment-api.js');
requireCheck((app.match(/\beqInit\(\);/g) || []).length === 1, 'single boot call fixture seam');
const appFixture = app.replace(/\beqInit\(\);/, 'fixtureSetup();');
const qr = read('docs/equipment/js/qrcode.min.js');
const ble = read('docs/equipment/js/dt-ble.js');
const baseCases = [
  ['report-admin','admin','report'], ['report-repairer','repairer','report'], ['report-reporter','reporter','report'],
  ['correction-admin','admin','correction'], ['correction-reporter','reporter','correction'], ['correction-general','reporter','correction-general'],
  ['supplement-admin','admin','supplement'], ['supplement-reporter','reporter','supplement'], ['supplement-general','reporter','supplement-general'],
  ['reply-admin','admin','reply'], ['reply-repairer','repairer','reply'],
  ['complete-admin','admin','complete'], ['complete-repairer','repairer','complete'],
  ['direct-admin','admin','direct'], ['direct-repairer','repairer','direct'], ['record-existing','admin','record'],
  ['archive-new','admin','archive-new'], ['archive-edit','admin','archive-edit'], ['transfer','admin','transfer'],
  ['audit-data','admin','audit'], ['audit-empty','admin','audit-empty'], ['audit-error','admin','audit-error'],
  ['trash-data','admin','trash'], ['trash-empty','admin','trash-empty'], ['trash-error','admin','trash-error'],
  ['gorder-all','admin','gorder'], ['gorder-department','admin','gorder-dept'],
  ['category-default','admin','category'], ['category-merge','admin','category-merge'], ['category-invalid','admin','category-invalid'],
  ['mine-grouped','reporter','mine'], ['mine-summary','reporter','mine-all'], ['mine-empty','reporter','mine-empty'],
  ['scan-reporter','reporter','scan'], ['scan-view','view','scan'], ['denied-view','view','denied'],
  ['readonly-detail','view','detail'], ['reporter-detail','reporter','detail'],
  ['labels','admin','labels'], ['labels-single','admin','labels-single']
].map(([name, role, page]) => ({ name, role, page }));
const script = s => '<script>' + s.replace(/<\/script/gi, '<\\/script') + '</script>';
const fixtureCode = `
'use strict';
const CASES = ${JSON.stringify(baseCases)};
const violations = [], apiReads = [], attemptedNetwork = [], runtimeErrors = [];
window.__fixture = { violations, apiReads, attemptedNetwork, runtimeErrors, cases: CASES, ready: false };
function forbidden(what) { violations.push(what); throw Error('Forbidden offline fixture operation: ' + what); }
window.fetch = function(url) { attemptedNetwork.push(String(url)); throw Error('Business and hardware network forbidden'); };
window.XMLHttpRequest = class { constructor() { forbidden('XMLHttpRequest'); } };
window.WebSocket = class { constructor() { forbidden('WebSocket'); } };
window.EventSource = class { constructor() { forbidden('EventSource'); } };
window.print = () => forbidden('print'); window.open = () => forbidden('window.open');
window.alert = () => forbidden('alert/notification'); window.confirm = () => forbidden('confirm'); window.prompt = () => forbidden('prompt');
navigator.sendBeacon = () => forbidden('sendBeacon');
try { Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true }); } catch(e) {}
try { Object.defineProperty(navigator, 'usb', { value: undefined, configurable: true }); } catch(e) {}
try { Storage.prototype.setItem = function() { forbidden('storage.setItem'); }; Storage.prototype.removeItem = function() { forbidden('storage.removeItem'); }; Storage.prototype.clear = function() { forbidden('storage.clear'); }; } catch(e) {}
window.addEventListener('error', e => { runtimeErrors.push({message:e.message,line:e.lineno,column:e.colno,file:e.filename}); });
window.addEventListener('unhandledrejection', e => { runtimeErrors.push(String(e.reason)); });
document.addEventListener('click', function(e) {
  const a = e.target.closest('a'); if (a) { e.preventDefault(); forbidden('link navigation/download'); }
  const el = e.target.closest('[onclick]'); if (!el) return;
  const h = el.getAttribute('onclick') || '';
  if (/\\b(?:submit\\w*|save\\w*|doCatRename|delDevice|delRecord|restoreTrash|purge\\w*|notify\\w*|printLabels|dtPrint\\w*|dtBle\\w*|download\\w*|export\\w*|import\\w*|connect\\w*|setExpected|openNotifySettings)\\s*\\(/.test(h)) { e.preventDefault(); e.stopImmediatePropagation(); forbidden(h); }
}, true);
const clone = x => JSON.parse(JSON.stringify(x));
const DATE = new Date().toISOString().slice(0,10);
const past = n => { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); };
const long = '合成设备履历界面测试·精密自动化多工位生产设备';
const OPEN = { id:'open-1', no:'WO-TEST-20261029-0001', type:'fault', status:'open', symptom:'伺服报警停机，气缸漏气；仅合成故障说明不含真实生产信息。'.repeat(3), place:'合成冲压车间东侧第三排长位置测试', reportAt:past(5), reportBy:'合成报修人', expectedAt:past(1), reportDept:'冲压组', progress:[{at:past(2),by:'合成维修人',text:'等待合成备件到货，仅用于界面布局。'.repeat(3)}], supplements:[{id:'sup-1',at:past(1),by:'合成报修人',text:'补充现场情况与合成长段说明。'.repeat(4)}], parts:[] };
const DONE = { ...OPEN, id:'done-1', no:'WO-TEST-20261029-0002', status:'done', doneAt:DATE, handler:'合成维修人', repairMode:'outer', supplier:'合成供应商（无真实联系方式）', cause:'合成磨损说明', action:'更换合成部件', cost:123.5, parts:[{name:'合成第一备件名称较长用于换行',qty:2},{name:'合成第二备件',qty:1}], cause1:'设备', cause2:'机械', cause3:'磨损' };
const seed = {
  'TEST-001': {code:'TEST-001',number:'合成机号-000001',name:long,line:'冲压组',category:'prod',family:'合成超长设备类别名称用于窄屏布局验证',status:'active',model:'SYNTHETIC-MODEL',owner:'合成负责人',remark:'只读合成预览',records:[OPEN,DONE]},
  'TEST-002': {code:'TEST-002',number:'合成机号-000002',name:'合成注塑辅助设备',line:'冲压组',category:'prod',family:'合成第二类别',status:'active',records:[{...OPEN,id:'open-2',no:'WO-TEST-0003'}]},
  'TEST-003': {code:'TEST-003',number:'合成机号-000003',name:'合成跨车间设备',line:'注塑部',category:'prod',family:'合成第二类别',status:'idle',records:[]},
  'GEN-D01': {code:'GEN-D01',number:'',name:'通用报修 · 冲压组',line:'冲压组',category:'misc',family:'',status:'active',records:[{...OPEN,id:'general-1',no:'WO-TEST-GEN-0001'}]}
};
const orders = {'':[{n:'合成超长设备类别名称用于窄屏布局验证',pin:true},{n:'合成已空类别',pin:false}], '冲压组':[{n:'合成第二类别',pin:false},{n:'合成已空类别',pin:true}]};
let activeCase = CASES[0];
function setupApi() {
  _demoSession = { account: activeCase.role === 'admin' ? 'admin' : 'synthetic-' + activeCase.role, name:'合成界面用户', level:1, token:'OFFLINE-NOT-A-TOKEN', tools:activeCase.role==='repairer'?['equipment']:activeCase.role==='reporter'?['equipment-report']:[], dept:'冲压组' };
  const readers = {
    user: () => eqUser(), role: () => eqRole(),
    getDevice: code => Promise.resolve({ok:true,equipment:clone(EQ[code]||null),role:ROLE}),
    listAll: () => Promise.resolve({ok:true,equipments:clone(EQ),role:ROLE}),
    myList: () => Promise.resolve({ok:true,equipments:clone(EQ),dept:'冲压组',generic:'GEN-D01',role:ROLE}),
    groupOrderGet: () => Promise.resolve({ok:true,data:clone(orders)}),
    auditList: () => Promise.resolve(activeCase.page==='audit-error'?{ok:false,msg:'合成读取失败'}:{ok:true,logs:activeCase.page==='audit-empty'?[]:[{at:DATE+' 10:30',name:'合成管理员',action:'save',summary:'合成审计动作与长说明'.repeat(8)}]}),
    trashList: () => Promise.resolve(activeCase.page==='trash-error'?{ok:false,msg:'合成读取失败'}:{ok:true,items:activeCase.page==='trash-empty'?[]:[{id:'trash-1',kind:'equipment',ref_key:'REMOVED-TEST',label:'已删合成长设备名称'.repeat(5),deleted_at:DATE,deleted_by_name:'合成管理员',snapshot:clone(seed['TEST-001'])},{id:'trash-2',kind:'record',ref_key:'TEST-001',label:'合成已删工单',deleted_at:DATE,deleted_by_name:'合成管理员',snapshot:clone(DONE)}]})
  };
  EquipApi = new Proxy(readers,{get(target,key){ if (key in target) return (...args)=>{ if(key!=='user'&&key!=='role') apiReads.push({name:key,args}); return target[key](...args); }; return ()=>forbidden('EquipApi.'+String(key)); }});
}
function fixtureSetup() {
  _libs.qr = Promise.resolve();
  const initial = new URLSearchParams(location.search).get('case');
  const dock = document.createElement('div'); dock.id = 'fixture-dock';
  dock.innerHTML = '<b>只读合成预览 · 无生产/保存/网络/打印</b> <select id="fixture-page">'+CASES.map(c=>'<option value="'+c.name+'">'+c.name+'</option>').join('')+'</select>';
  document.body.appendChild(dock);
  dock.querySelector('select').onchange = e => fixtureOpen(e.target.value);
  fixtureOpen(initial || CASES[0].name).then(()=>{ window.__fixture.ready = true; });
}
async function fixtureOpen(name) {
  activeCase = CASES.find(c=>c.name===name); if(!activeCase) throw Error('Unknown case '+name);
  document.querySelector('#fixture-page').value=name;
  document.getElementById('cat-modal').classList.remove('show');
  document.getElementById('toast').classList.remove('show');
  ROLE = activeCase.role; EQ = clone(seed); currentCode = 'TEST-001'; currentRecordId='';
  MY_DEPT='冲压组'; MY_GENERIC='GEN-D01'; GORDERS=clone(orders); groupOpen={}; mineGroupOpen={}; listSectionOpen={};
  document.body.classList.remove('is-admin','is-repairer','is-reporter','is-view','is-none'); document.body.classList.add('is-'+ROLE);
  document.querySelector('#eq-user').textContent='合成界面用户'; document.querySelector('#eq-role').textContent=ROLE;
  setupApi();
  if(activeCase.page==='mine-empty') { EQ={'GEN-D01':clone(seed['GEN-D01'])}; EQ['GEN-D01'].records=[]; }
  const p=activeCase.page;
  if(p==='report') openReportForm(currentCode);
  else if(p==='correction'||p==='correction-general') { if(p.endsWith('general'))currentCode='GEN-D01'; openReportCorrection(p.endsWith('general')?'general-1':'open-1'); }
  else if(p==='supplement'||p==='supplement-general') { if(p.endsWith('general'))currentCode='GEN-D01'; openReportSupplement(p.endsWith('general')?'general-1':'open-1'); }
  else if(p==='reply')openReplyForm('open-1');
  else if(p==='complete')openCompleteForm('open-1');
  else if(p==='direct')openRecordForm();
  else if(p==='record')openRecordForm('done-1');
  else if(p==='archive-new')openArchiveForm();
  else if(p==='archive-edit')openArchiveForm(currentCode);
  else if(p==='transfer')openTransfer();
  else if(p.startsWith('audit'))openAudit();
  else if(p.startsWith('trash'))openTrash();
  else if(p.startsWith('gorder')) {openGroupOrder();await Promise.resolve();await Promise.resolve();if(p==='gorder-dept')switchGorderDept('冲压组');}
  else if(p.startsWith('category')) {openGroupOrder();await Promise.resolve();await Promise.resolve();openCatRename(gorderDraft.findIndex(it=>it.n==='合成超长设备类别名称用于窄屏布局验证')); if(p==='category-merge'){document.getElementById('cat-input').value='合成第二类别';onCatInput();} if(p==='category-invalid'){document.getElementById('cat-input').value='';onCatInput();}}
  else if(p==='mine'||p==='mine-empty') {renderMine();switchView('mine');}
  else if(p==='mine-all')showMineAll();
  else if(p==='scan')switchView('scan');
  else if(p==='denied'){document.getElementById('denied-msg').textContent='合成权限拒绝提示，无真实用户或业务请求。';switchView('denied');}
  else if(p==='detail')openDetail(currentCode);
  else if(p==='labels'||p==='labels-single')showLabels(p==='labels-single'?['TEST-001']:['TEST-001','TEST-002','TEST-003']);
  await Promise.resolve(); await Promise.resolve(); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  window.scrollTo(0,0); return {name,role:ROLE,view:document.querySelector('.view.show')?.id};
}
window.fixtureOpen = fixtureOpen;
function visible(e) { return !!e && !!e.getClientRects().length && getComputedStyle(e).visibility!=='hidden'; }
window.fixtureMetrics = function() {
  const view=document.querySelector('.view.show'), dialog=document.querySelector('.cat-modal.show');
  const scope=dialog||view;
  const fields=[...scope.querySelectorAll('input:not([type="hidden"]),select,textarea')].filter(visible);
  const buttons=[...scope.querySelectorAll('button')].filter(visible);
  const badFields=fields.filter(e=>parseFloat(getComputedStyle(e).fontSize)<15.99).map(e=>({id:e.id,font:getComputedStyle(e).fontSize}));
  const targetButtons=buttons.filter(e=>e.closest('.bottom-bar,.cat-acts,.label-toolbar,.label-range,#view-gorder .toolbar')||e.classList.contains('part-del'));
  const badButtons=targetButtons.filter(e=>e.getBoundingClientRect().height<43.9).map(e=>({text:e.textContent.trim(),height:e.getBoundingClientRect().height}));
  const hiddenLeaks=[...document.querySelectorAll('.admin-only')].filter(e=>ROLE!=='admin'&&visible(e)).map(e=>e.id||e.className);
  const listLeaks=[...document.querySelectorAll('.list-only')].filter(e=>!['admin','repairer'].includes(ROLE)&&visible(e)).map(e=>e.id||e.className);
  const repairLeaks=[...document.querySelectorAll('.for-repairer')].filter(e=>!['admin','repairer'].includes(ROLE)&&visible(e)).map(e=>e.id||e.className);
  const overflow=[...scope.querySelectorAll('*')].filter(visible).filter(e=>{const r=e.getBoundingClientRect();return r.right>innerWidth+1||r.left< -1;}).slice(0,10).map(e=>({id:e.id,tag:e.tagName,cls:e.className,right:e.getBoundingClientRect().right,left:e.getBoundingClientRect().left}));
  const bar=[...view.querySelectorAll('.bottom-bar')].find(visible);
  let footer=null;if(bar){const css=getComputedStyle(bar);const oldScroll=scrollY;window.scrollTo(0,document.documentElement.scrollHeight);const b=bar.getBoundingClientRect();const ctrls=[...view.querySelectorAll('input,select,textarea,.fold')].filter(visible);const last=ctrls.at(-1)?.getBoundingClientRect();footer={position:css.position,height:b.height,top:b.top,lastBottom:last?.bottom,clear:css.position!=='fixed'||!last||last.bottom<=b.top+1};window.scrollTo(0,oldScroll);}
  return {name:activeCase.name,role:ROLE,view:view?.id,docWidth:document.documentElement.scrollWidth,width:innerWidth,badFields,badButtons,hiddenLeaks,listLeaks,repairLeaks,overflow,footer,title:getComputedStyle(document.querySelector('.eq-title')).color,titleSpan:getComputedStyle(document.querySelector('.eq-title span')).color,fields:fields.length,buttons:buttons.length};
};
window.fixtureLabelSignature = function() {
 const selectors=['.label-card','.label-info','.label-code','.label-name','.label-qr','.label-qr svg','.label-qr img','.label-index'];
 const props=['width','height','boxSizing','paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginRight','marginBottom','marginLeft','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','color','backgroundColor','borderTopWidth','borderRadius','display','position','overflow','pageBreakAfter','breakAfter'];
 return selectors.map(sel=>({sel,items:[...document.querySelectorAll(sel)].map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return{text:e.textContent,html:e.innerHTML.replace(/src="data:image\\/png;base64,[^"]+"/g,'src="PNG"'),rect:{width:r.width,height:r.height},style:Object.fromEntries(props.map(p=>[p,s[p]])),images:[...e.querySelectorAll('img')].map(i=>i.src)};})}));
};
window.fixturePrintSignature = function(){
 const sels=['body','.eq-header','.eq-main','#view-labels','.label-toolbar','.label-range','#labels-grid','.label-card','.label-qr img','.label-code','.label-name','.label-index'];
 const props=['display','width','height','padding','margin','fontSize','fontFamily','lineHeight','border','boxShadow','backgroundColor','color','position','gridTemplateColumns','gap','pageBreakAfter','breakAfter'];
 return {page:[...document.styleSheets].flatMap(sheet=>{try{return [...sheet.cssRules].filter(r=>r.type===CSSRule.PAGE_RULE).map(r=>r.cssText);}catch(e){return [];}}),elements:sels.map(sel=>({sel,items:[...document.querySelectorAll(sel)].map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {text:e.textContent,style:Object.fromEntries(props.map(p=>[p,s[p]])),width:r.width,height:r.height};})}))};
};
`;
let page = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
page = page.replace(/<img([^>]+)src="\.\.\/images\/logo_cat\.png"/g, '<img$1src="data:image/png;base64,' + fs.readFileSync(path.join(root, 'docs/images/logo_cat.png')).toString('base64') + '"');
page = page.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'; font-src \'none\'; frame-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">');
page = page.replace('</head>', '<style id="product-css">' + css + '</style><style id="fixture-css">#fixture-dock{position:fixed;right:8px;top:8px;z-index:500;padding:8px;background:#fff;border:1px solid #cbd5e0;font:12px sans-serif;max-width:calc(100vw - 16px)}#fixture-dock select{max-width:100%;font-size:16px}body[data-automation="1"] #fixture-dock{display:none}@media print{#fixture-dock{display:none!important}}</style></head>');
page = page.replace('</body>', () => script(fixtureCode) + script(api) + script(qr) + script(appFixture) + script(ble) + '</body>');
const file = path.join(out, '设备履历卡_UI_V2_其余界面_只读交互预览.html');
fs.writeFileSync(file, page);
fs.writeFileSync(path.join(out, 'fixture_case_manifest.json'), JSON.stringify({baseline,cases:baseCases,boundaries:['synthetic data only','all docs JS normalized hash equal to baseline','HTML CSS-hash-only change','CSS baseline prefix plus screen layers only','single eqInit boot call changed in generated fixture only','EquipApi read-only proxy; all other methods throw','fetch/XHR/websocket/print/open/storage writes forbidden','no save, notify, download, hardware connection, print(), printToPDF','real APP handlers and DOM; no replacement product functions','print media computed geometry only']},null,2)+'\n');
if (process.argv.includes('--build-only')) { console.log(JSON.stringify({ok:true,buildOnly:true,checks:checks.length,cases:baseCases.length,file})); process.exit(0); }
const chromePath = [process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p=>p&&fs.existsSync(p));
if (!chromePath) throw Error('Chrome/Edge executable not found');
const profile = path.join(out, 'chrome_profile_' + Date.now()), log = fs.openSync(path.join(out,'chrome.log'),'a');
const chrome = cp.spawn(chromePath,['--headless=new','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check','--disable-component-update','--disable-sync','--disable-features=MediaRouter,OptimizationHints','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore',log,log],windowsHide:true});
let ws, nextId=0; const pending=new Map();
function send(method,params={}) {return new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression) {const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text+': '+(r.exceptionDetails.exception?.description||expression));return r.result.value;}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const metrics=[], screenshots=[], caseChecks=[]; let labelComparison,printComparison;
async function openCase(c) {const r=await evaluate('fixtureOpen('+JSON.stringify(c.name)+')');await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');return r;}
async function screenshot(name) {const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const p=path.join(out,name+'.png');fs.writeFileSync(p,Buffer.from(r.data,'base64'));screenshots.push(p);}
const deadline=setTimeout(()=>{console.error('Remaining UI regression timed out');chrome.kill();process.exitCode=1;},180000);
(async()=>{
 const pf=path.join(profile,'DevToolsActivePort');for(let i=0;i<100&&!fs.existsSync(pf);i++)await pause(75);if(!fs.existsSync(pf))throw Error('No Chrome debug port');
 const port=fs.readFileSync(pf,'utf8').split('\n')[0];const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 await send('Page.enable');await send('Runtime.enable');
 const network=[];await send('Network.enable');ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Network.requestWillBeSent'&&/^https?:/.test(m.params.request.url))network.push(m.params.request.url);});
 await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await send('Page.navigate',{url:new URL('file:///'+file.replace(/\\/g,'/')).href});
 for(let i=0;i<100;i++){await pause(60);if(await evaluate('window.__fixture?.ready||false'))break;}
 requireCheck(await evaluate('window.__fixture?.ready||false'),'fixture initialized');await evaluate('document.body.dataset.automation="1"');
 for(const width of [320,390,1440]) {
  await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
  for(const c of baseCases) {
   const init=await openCase(c); const m=await evaluate('fixtureMetrics()'); metrics.push(m);
   const tag=width+' '+c.name;
   const expectedPage=c.page.startsWith('correction')?'correct':c.page.startsWith('supplement')?'supplement':['complete','direct','record'].includes(c.page)?'record':c.page.startsWith('archive')?'archive':c.page.startsWith('audit')?'audit':c.page.startsWith('trash')?'trash':c.page.startsWith('gorder')||c.page.startsWith('category')?'gorder':c.page==='mine-empty'?'mine':c.page==='detail'?'list':c.page==='labels-single'?'labels':c.page;
   check(init.view==='view-'+expectedPage,tag+' expected real APP view opened',init);
   check(m.docWidth<=width+1,tag+' no page horizontal overflow',{docWidth:m.docWidth,overflow:m.overflow});
   check(m.title===m.titleSpan,tag+' single-color title',{title:m.title,span:m.titleSpan});
   check(m.hiddenLeaks.length===0&&m.listLeaks.length===0&&m.repairLeaks.length===0,tag+' role-hidden controls remain hidden',{admin:m.hiddenLeaks,list:m.listLeaks,repair:m.repairLeaks});
   if(width<=600){check(!m.badFields.length,tag+' visible mobile inputs >=16px',m.badFields);check(!m.badButtons.length,tag+' footer/dialog/label primary buttons >=44px',m.badButtons);}
   if(m.footer){check(m.footer.clear,tag+' footer does not cover final field at scroll end',m.footer);check(m.footer.position===(width>=900?'static':'fixed'),tag+' footer breakpoint retained',m.footer);}
   if(c.page==='reply')check(await evaluate('document.getElementById("rp-expected").disabled')===(c.role!=='admin'),tag+' expected-date disabled permission');
   if(['complete','record','direct'].includes(c.page)){
    check(await evaluate('document.getElementById("rf-type").disabled')===(c.page==='complete'),tag+' native type select disabled condition');
    check(await evaluate('getComputedStyle(document.getElementById("rf-supplierWrap")).display')===(c.page==='record'?'block':'none'),tag+' supplier initial conditional display');
    await evaluate('document.getElementById("rf-mode").value="outer";document.getElementById("rf-mode").dispatchEvent(new Event("change",{bubbles:true}))');
    check(await evaluate('document.getElementById("rf-supplierWrap").style.display')==='',tag+' native change clears supplier inline hiding');
    check(await evaluate('visible(document.getElementById("rf-supplierWrap"))')===(c.role==='admin'),tag+' supplier remains admin-only after mode change');
    await evaluate('document.getElementById("rf-mode").value="inner";document.getElementById("rf-mode").dispatchEvent(new Event("change",{bubbles:true}))');
    check(!await evaluate('visible(document.getElementById("rf-supplierWrap"))'),tag+' native change hides supplier');
    const fold=await evaluate('(()=>{const f=[...document.querySelectorAll("#view-record .fold")].find(visible);if(!f)return null;return {open:f.classList.contains("open"),body:getComputedStyle(f.querySelector(".fold-body")).display}})()');
    if(fold){await evaluate('[...document.querySelectorAll("#view-record .fold-head")].find(visible).click()');const after=await evaluate('(()=>{const f=[...document.querySelectorAll("#view-record .fold")].find(visible);return {open:f.classList.contains("open"),body:getComputedStyle(f.querySelector(".fold-body")).display}})()');check(fold.open!==after.open&&after.body===(after.open?'block':'none'),tag+' real fold handler toggles display',{before:fold,after});}
   }
   if(c.page==='category-invalid')check(await evaluate('document.getElementById("cat-warn").textContent.includes("不能为空")'),tag+' invalid category preserves real validation warning');
   if(c.page==='category-merge')check(await evaluate('document.getElementById("cat-warn").textContent.includes("合并")'),tag+' merge warning visible');
   if(width===390&&['report-reporter','correction-general','supplement-reporter','complete-admin','archive-edit','gorder-all','category-merge','mine-summary','labels'].includes(c.name))await screenshot(c.name+'_390');
   caseChecks.push({width,name:c.name,view:init.view});
  }
 }
 // Keyboard/focus and readonly in-memory interactions, not any business save.
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:760,deviceScaleFactor:1,mobile:false});
 await openCase(baseCases.find(c=>c.name==='report-reporter'));
 await send('Page.bringToFront');
 const focusPoint=await evaluate('(()=>{const e=document.getElementById("rp-place");e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
 await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...focusPoint});
 await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...focusPoint});
 await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const focusData=await evaluate('(()=>{const e=document.getElementById("rp-place"),s=getComputedStyle(e);return {active:document.activeElement.id,shadow:s.boxShadow,border:s.borderColor,focused:e.matches(":focus"),documentFocus:document.hasFocus()}})()');
 check(focusData.active==='rp-place'&&focusData.shadow!=='none','native pointer focuses input with visible ring',focusData);
 await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
 check(await evaluate('document.activeElement.id!=="rp-place"'),'native keyboard tab moves focus');
 // Range selection uses the real APP, but never calls send/print/download paths.
 await openCase(baseCases.find(c=>c.name==='labels'));
 await evaluate('document.getElementById("label-from").value="2";document.getElementById("label-to").value="3";onLabelRangeChange()');
 check(await evaluate('labelRangeInfo().ok&&labelRangeInfo().codes.length===2'),'label range real valid selection');
 await evaluate('document.getElementById("label-from").value="3";document.getElementById("label-to").value="1";onLabelRangeChange()');
 check(await evaluate('!labelRangeInfo().ok'),'label range invalid selection');
 await evaluate('document.getElementById("label-from").value="1";document.getElementById("label-to").value="3";onLabelRangeChange()');
 // Compare the same CSS layout viewport: toolbar-height changes can otherwise toggle the native 15px scrollbar gutter.
 // The fixture stabilizes only the browser gutter, never label geometry, text, or rendering functions.
 await evaluate('document.documentElement.style.overflowY="scroll"');
 check(await evaluate('document.querySelectorAll(".label-qr svg").length===3&&!document.getElementById("labels-wrap").textContent.includes("生成失败")'),'real QR generator produced three SVG labels');
 const labelEvidence=[];
 for(const width of [320,390,1440]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
  await openCase(baseCases.find(c=>c.name==='labels'));
  const screenCurrent=await evaluate('fixtureLabelSignature()');
  await evaluate('document.getElementById("product-css").textContent='+JSON.stringify(oldCss));
  const screenOld=await evaluate('fixtureLabelSignature()');
  const screenSame=JSON.stringify(screenCurrent)===JSON.stringify(screenOld);check(screenSame,width+' label screen card geometry/content frozen');
  await send('Emulation.setEmulatedMedia',{media:'print'});
  const printOld=await evaluate('fixturePrintSignature()');
  await evaluate('document.getElementById("product-css").textContent='+JSON.stringify(css));
  const printCurrent=await evaluate('fixturePrintSignature()');
  const printSame=JSON.stringify(printOld)===JSON.stringify(printCurrent);check(printSame,width+' print computed geometry/format frozen');
  labelEvidence.push({width,screenSame,printSame,screenOld,screenCurrent,printOld,printCurrent});
  await send('Emulation.setEmulatedMedia',{media:''});
 }
 labelComparison=labelEvidence.every(e=>e.screenSame);printComparison=labelEvidence.every(e=>e.printSame);
 fs.writeFileSync(path.join(out,'label_and_print_frozen_evidence.json'),JSON.stringify(labelEvidence,null,2)+'\n');
 const boundary=await evaluate('({violations:__fixture.violations,apiReads:__fixture.apiReads,attemptedNetwork:__fixture.attemptedNetwork,runtimeErrors:__fixture.runtimeErrors})');
 check(boundary.violations.length===0,'no write/notify/download/print/hardware operation attempted',boundary.violations);
 check(boundary.runtimeErrors.length===0,'no uncaught browser errors',boundary.runtimeErrors);
 check(boundary.attemptedNetwork.every(u=>u==='http://127.0.0.1:15216/local/ServerInfo'),'only existing caught label local-probe attempts (blocked before network)',boundary.attemptedNetwork);
 check(network.length===0,'zero actual HTTP(S) browser network requests',network);
 fs.writeFileSync(path.join(out,'remaining_ui_validation.json'),JSON.stringify({ok:failures.length===0,baseline,sourceHashes,checks:checks.length,passed:checks.length-failures.length,failures,cases:caseChecks,metrics,labelComparison,printComparison,boundary,network,screenshots,file},null,2)+'\n');
 console.log(JSON.stringify({ok:failures.length===0,baseline,sourceHashes,checks:checks.length,passed:checks.length-failures.length,failed:failures.length,screens:baseCases.length,viewportCases:caseChecks.length,labelComparison,printComparison,file,failures},null,2));
 if(failures.length)process.exitCode=1;
})().catch(e=>{console.error(e.stack||e);fs.writeFileSync(path.join(out,'remaining_ui_fatal.json'),JSON.stringify({error:e.stack||String(e),checks,failures,metrics},null,2));process.exitCode=1;}).finally(()=>{clearTimeout(deadline);if(ws){try{ws.send(JSON.stringify({id:++nextId,method:'Browser.close'}));ws.close();}catch(e){}}chrome.kill();fs.closeSync(log);});
