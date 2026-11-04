/* Real Chrome/CDP report idempotency integration, synthetic/offline only.
 * Real HTML/CSS/time/intent/session/API/APP; only the eqInit startup call is
 * replaced by fixtureStart. No product submit/open/navigation method is stubbed.
 * Native browser localStorage/sessionStorage and crypto; synthetic RPC ledger in
 * a SYNTHETIC sessionStorage key survives Page.reload. NOT a PostgreSQL test.
 * node --unhandled-rejections=strict tools/test_report_idempotency_browser.js
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'outputs/Report_Idempotency_20261104/browser');
fs.mkdirSync(OUT, { recursive: true });
const FILES = ['docs/equipment/index.html', 'docs/equipment/css/equipment.css', 'docs/js/session.js',
    'docs/equipment/js/equipment-time.js', 'docs/equipment/js/equipment-report-intent.js',
    'docs/equipment/js/equipment-api.js', 'docs/equipment/js/equipment-app.js'];
const sources = Object.fromEntries(FILES.map(file => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')]));
const hashes = Object.fromEntries(FILES.map(file => [file, crypto.createHash('sha256').update(sources[file]).digest('hex')]));
const escScript = s => s.replace(/<\/script/gi, '<\\/script');
const fixture = {
    'SYNTHETIC-A': { code: 'SYNTHETIC-A', number: 'SYNTHETIC-A', name: '隔离测试设备 A', line: '模具部', family: '隔离测试', category: 'prod', status: 'active', photos: [], records: [] },
    'SYNTHETIC-B': { code: 'SYNTHETIC-B', number: 'SYNTHETIC-B', name: '隔离测试设备 B', line: '模具部', family: '隔离测试', category: 'prod', status: 'active', photos: [], records: [] },
    'GEN-D07': { code: 'GEN-D07', number: '', name: '通用报修 · 隔离测试', line: '模具部', family: '隔离测试', category: 'misc', status: 'active', photos: [], records: [] }
};
const safety = `
window.SYNTHETIC_ERRORS=[];window.SYNTHETIC_EXTERNAL=[];
addEventListener('error',e=>SYNTHETIC_ERRORS.push(e.message));
addEventListener('unhandledrejection',e=>SYNTHETIC_ERRORS.push(String(e.reason)));
function forbidden(name){return function(){SYNTHETIC_EXTERNAL.push(name);throw Error('Forbidden external operation: '+name)}}
window.fetch=forbidden('fetch');window.XMLHttpRequest=forbidden('XHR');window.WebSocket=forbidden('WebSocket');
window.EventSource=forbidden('EventSource');window.print=forbidden('print');window.open=forbidden('open');
navigator.sendBeacon=forbidden('sendBeacon');
const NativeDate=Date;window.Date=class extends NativeDate{constructor(...a){super(...(a.length?a:['2026-11-04T07:00:00Z']))}static now(){return NativeDate.parse('2026-11-04T07:00:00Z')}};
`;
const setup = `
const SYNTHETIC_LEDGER_KEY='SYNTHETIC_REPORT_RPC_LEDGER_V1';
const SYNTHETIC_INITIAL=${JSON.stringify(fixture)};
window.SYNTHETIC={calls:[],held:[],mode:'hold',get ledger(){return JSON.parse(sessionStorage.getItem(SYNTHETIC_LEDGER_KEY))},
 save(d){sessionStorage.setItem(SYNTHETIC_LEDGER_KEY,JSON.stringify(d))},
 release(ok){this.held.splice(0).forEach(x=>ok?x.resolve(x.response):x.reject(Error('SYNTHETIC accepted but response lost')))},
 reportCalls(){return this.calls.filter(x=>x.name==='equipment_report_once')},
 client:{rpc(name,p){
   const S=SYNTHETIC,params=JSON.parse(JSON.stringify(p));S.calls.push({name,params});
   const d=S.ledger,u=SessionStore.get(),role=eqRole();
   const answer=data=>Promise.resolve({data,error:null});
   const equipment=code=>role==='reporter'?maskForReport(d.equipments[code]):d.equipments[code];
   if(name==='equipment_list'||name==='equipment_my_list'){
      const all={};Object.keys(d.equipments).forEach(code=>all[code]=equipment(code));
      return answer({ok:true,data:{role,dept:'模具部',generic:'GEN-D07',equipments:all}});
   }
   if(name==='equipment_get')return answer({ok:true,data:{role,equipment:equipment(p.p_code)}});
   if(name==='equip_group_order_get')return answer({ok:true,data:{}});
   if(name!=='equipment_report_once')throw Error('Unexpected RPC '+name);
   if(S.mode==='missing')return Promise.resolve({data:null,error:{code:'PGRST202',message:'SYNTHETIC RPC not installed'}});
   const intent=EquipReportIntent.get(u.account,p.p_request_id);
   if(!intent||intent.payload.symptom!==p.p_symptom||intent.payload.place!==p.p_place||intent.payload.reportBy!==p.p_reportby)throw Error('Intent was not durably read back before RPC');
   S.calls[S.calls.length-1].durableBeforeDispatch=true;
   const key=u.account+'|'+p.p_request_id, fingerprint=JSON.stringify([p.p_code,p.p_symptom,p.p_place,p.p_reportby]);
   let prior=d.receipts[key],receipt;
   if(prior&&prior.fingerprint!==fingerprint)return answer({ok:false,code:'REQUEST_ID_CONFLICT',msg:'SYNTHETIC conflict'});
   if(prior)receipt={...prior.receipt,replayed:true};
   else {
      receipt={ok:true,code:p.p_code,recordId:'SYNTHETIC-record-'+(++d.sequence),no:'SYNTHETIC-WO-'+d.sequence,expectedAt:'2026-11-05T15:00',replayed:false};
      d.equipments[p.p_code].records.push({id:receipt.recordId,no:receipt.no,type:'fault',status:'open',reportAt:'2026-11-04',createdAt:'2026-11-04 15:00:00',expectedAt:receipt.expectedAt,symptom:p.p_symptom,place:p.p_place,reportBy:p.p_reportby,parts:[],cost:0,photos:[]});
      d.receipts[key]={fingerprint,receipt};d.audit++;d.syntheticNotificationCount++;S.save(d);
   }
   const response={data:receipt,error:null};
   if(S.mode==='hold')return new Promise((resolve,reject)=>S.held.push({resolve,reject,response}));
   if(S.mode==='lose')return Promise.reject(Error('SYNTHETIC accepted but response lost'));
   return Promise.resolve(response);
 }}
};
window.supabase={createClient(){return SYNTHETIC.client}};
window.fixtureStart=function(){
 const role=new URL(location.href).searchParams.get('role')||'admin';
 if(!sessionStorage.getItem(SYNTHETIC_LEDGER_KEY))SYNTHETIC.save({equipments:SYNTHETIC_INITIAL,receipts:{},sequence:0,audit:0,syntheticNotificationCount:0});
 if(!SessionStore.get())SessionStore.write(JSON.stringify({account:'SYNTHETIC-'+role,token:'SYNTHETIC-token-'+role,name:'隔离测试·'+role,dept:'模具部',level:2,tools:role==='admin'?['equipment-admin']:role==='repairer'?['equipment']:['equipment-report']}));
 EqConfig.cloud=true;eqBoot();window.SYNTHETIC_READY=true;
};
`;
let html = sources[FILES[0]].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link[^>]+stylesheet[^>]*>/, '<style>' + sources[FILES[1]] + '</style>')
    .replace('../images/logo_cat.png', 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'docs/images/logo_cat.png')).toString('base64'))
    .replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'; form-action \'none\'">');
const app = sources[FILES[6]];
if ((app.match(/^    eqInit\(\);$/gm) || []).length !== 1) throw Error('Expected exactly one eqInit startup call');
html = html.replace('</body>', () => [safety, sources[FILES[2]], sources[FILES[3]], sources[FILES[4]], sources[FILES[5]],
    app.replace(/^    eqInit\(\);$/m, '    fixtureStart();'), setup].map(text => '<script>' + escScript(text) + '</script>').join('') + '</body>');
for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new (require('node:vm').Script)(script[1]);
fs.writeFileSync(path.join(OUT, 'fixture.html'), html);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws, serial = 0, passed = 0, dialogChoice = true;
const requests = new Map(), checks = [], blockedResources = [], screenshots = [], caseResults = [];
function send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++serial; requests.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function ev(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
}
async function until(expression) { for (let i = 0; i < 160; i++) { if (await ev(expression)) return; await sleep(25); } const diagnostic=await ev(`({href:location.href,errors:window.SYNTHETIC_ERRORS,external:window.SYNTHETIC_EXTERNAL,ready:window.SYNTHETIC_READY,submission:window.reportSubmission,calls:window.SYNTHETIC&&SYNTHETIC.calls,state:document.querySelector('#rp-submit-state')?.textContent,active:document.activeElement?.id,disabled:document.querySelector('#report-submit')?.disabled,views:[...document.querySelectorAll('.view.show')].map(e=>e.id)})`);throw Error('Wait failed: ' + expression+' '+JSON.stringify(diagnostic)); }
async function check(name, expression) { const ok = !!await ev(expression); checks.push({ name, ok }); if (!ok) throw Error(name); passed++; console.log('PASS ' + name); }
async function click(selector, count = 1) {
    const point = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Invisible '+${JSON.stringify(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (let i = 1; i <= count; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: i, ...point });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: i, ...point });
    }
    await sleep(35);
}
async function type(selector, text) { await click(selector); await send('Input.insertText', { text }); }
async function enter() { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }); await sleep(45); }
async function shot(name) { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); const filename = name + '.png'; fs.writeFileSync(path.join(OUT, filename), Buffer.from(r.data, 'base64')); screenshots.push(filename); }
async function open(code = 'SYNTHETIC-A', fresh = false) { await ev(`openReportForm(${JSON.stringify(code)},${fresh ? '{fresh:true}' : '{}'})`); await until(`$('view-report').classList.contains('show')`); }
async function fill() { await type('#rp-symptom', 'SYNTHETIC 同一故障'); await type('#rp-place', 'SYNTHETIC 隔离区'); }
async function submit(mode) { await ev('SYNTHETIC.mode=' + JSON.stringify(mode)); await click('#report-submit'); }
async function caseRun(role, width) {
    const tag = role + '/' + width + ' ', prefix = role + '_' + width;
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'https://synthetic-report-' + role + '-' + width + '.invalid/equipment/?role=' + role + '&code=SYNTHETIC-A' });
    await until(`window.SYNTHETIC_READY&&$('view-list').classList.contains('show')`);
    await open();
    await check(tag + 'fresh action is hidden; 44px buttons, no overflow and live status', `$('report-new').hidden&&getComputedStyle($('report-new')).display==='none'&&$('report-submit').getBoundingClientRect().height>=44&&$('report-cancel').getBoundingClientRect().height>=44&&document.documentElement.scrollWidth<=innerWidth+1&&$('rp-submit-state').getAttribute('role')==='status'&&$('rp-submit-state').getAttribute('aria-live')==='polite'`);
    await shot(prefix + '_fresh'); await fill(); await ev(`SYNTHETIC.mode='hold'`); await click('#report-submit', 2);
    await until('SYNTHETIC.held.length===1');
    await check(tag + 'pending double click sends once after durable storage', `SYNTHETIC.reportCalls().length===1&&SYNTHETIC.reportCalls()[0].durableBeforeDispatch&&SYNTHETIC.ledger.sequence===1&&['rp-symptom','rp-place','rp-reportBy','report-submit','report-cancel','report-new'].every(id=>$(id).disabled)`);
    await enter(); await check(tag + 'pending Enter cannot resubmit and payload stays locked', `SYNTHETIC.reportCalls().length===1&&$('rp-symptom').readOnly&&$('rp-place').readOnly&&$('rp-reportBy').readOnly`);
    await ev(`window.SYNTHETIC_FIRST={id:reportSubmission.saved.requestId,payload:reportSubmission.saved.payload,receipt:Object.values(SYNTHETIC.ledger.receipts)[0].receipt};sessionStorage.setItem('SYNTHETIC_FIRST',JSON.stringify(SYNTHETIC_FIRST));SYNTHETIC.release(false)`);
    await until(`reportSubmission&&!reportSubmission.busy&&$('report-submit').textContent==='重试确认'`);
    await check(tag + 'accepted lost response retains uncertain intent and frozen inputs', `EquipReportIntent.get(EquipApi.user().account,reportSubmission.saved.requestId).state==='uncertain'&&SYNTHETIC.ledger.sequence===1&&$('rp-symptom').readOnly&&!$('report-new').hidden&&!$('report-submit').disabled&&['report-submit','report-cancel','report-new'].every(id=>$(id).getBoundingClientRect().height>=44)`);
    await shot(prefix + '_uncertain');
    await send('Page.reload', { ignoreCache: true }); await until(`window.SYNTHETIC_READY&&$('view-list').classList.contains('show')`); await open();
    await ev(`window.SYNTHETIC_FIRST=JSON.parse(sessionStorage.getItem('SYNTHETIC_FIRST'))`);
    await check(tag + 'Page.reload restores exact payload/UUID without automatic retry', `reportSubmission.saved.requestId===SYNTHETIC_FIRST.id&&JSON.stringify(reportSubmission.saved.payload)===JSON.stringify(SYNTHETIC_FIRST.payload)&&$('rp-symptom').value===SYNTHETIC_FIRST.payload.symptom&&$('rp-place').value===SYNTHETIC_FIRST.payload.place&&SYNTHETIC.reportCalls().length===0&&EquipReportIntent.list(EquipApi.user().account).length===1`);
    await ev(`SYNTHETIC.mode='ok';$('report-submit').focus()`); await enter(); await until('reportSubmission===null');
    await check(tag + 'real Enter same-ID retry replays original order and removes only confirmed intent', `SYNTHETIC.reportCalls().length===1&&SYNTHETIC.reportCalls()[0].params.p_request_id===SYNTHETIC_FIRST.id&&SYNTHETIC.ledger.sequence===1&&SYNTHETIC.ledger.audit===1&&SYNTHETIC.ledger.syntheticNotificationCount===1&&Object.values(SYNTHETIC.ledger.receipts)[0].receipt.recordId===SYNTHETIC_FIRST.receipt.recordId&&EquipReportIntent.list(EquipApi.user().account).length===0`);
    await open(); await fill(); await submit('lose'); await until(`reportSubmission&&!reportSubmission.busy&&reportSubmission.saved`);
    await ev(`window.SYNTHETIC_OLD=reportSubmission.saved.requestId`);
    await type('#rp-symptom', 'MUST NOT EDIT');
    await check(tag + 'unknown input cannot be edited and canceling new-fault confirmation keeps ID', `$('rp-symptom').value==='SYNTHETIC 同一故障'&&reportSubmission.saved.requestId!==SYNTHETIC_FIRST.id`);
    dialogChoice = false; await click('#report-new'); await check(tag + 'new fault requires explicit confirmation', `reportSubmission.saved.requestId===SYNTHETIC_OLD&&$('rp-symptom').readOnly`);
    dialogChoice = true; await click('#report-new');
    await check(tag + 'confirmed fresh form keeps old unknown and hides new action again', `reportSubmission.saved===null&&!$('rp-symptom').readOnly&&$('report-new').hidden&&EquipReportIntent.get(EquipApi.user().account,SYNTHETIC_OLD).state==='uncertain'`);
    await fill(); await submit('ok'); await until('reportSubmission===null');
    await check(tag + 'different UUID same phenomenon creates another real order', `SYNTHETIC.ledger.sequence===3&&Object.keys(SYNTHETIC.ledger.receipts).length===3&&EquipReportIntent.list(EquipApi.user().account).length===1`);
    for (const code of ['SYNTHETIC-B', 'GEN-D07', 'GEN-D07']) { await open(code); await fill(); await submit('ok'); await until('reportSubmission===null'); }
    await check(tag + 'other device and repeated GEN phenomena have distinct orders/IDs', `SYNTHETIC.ledger.sequence===6&&SYNTHETIC.ledger.equipments['SYNTHETIC-B'].records.length===1&&SYNTHETIC.ledger.equipments['GEN-D07'].records.length===2&&new Set(Object.values(SYNTHETIC.ledger.receipts).map(x=>x.receipt.recordId)).size===6`);
    await open('SYNTHETIC-A'); await click('#report-cancel'); await until(`!$('view-report').classList.contains('show')`);
    await check(tag + 'cancel preserves unknown intent', `EquipReportIntent.get(EquipApi.user().account,SYNTHETIC_OLD).state==='uncertain'`);
    await open('GEN-D07'); await fill(); await submit('hold'); await until('SYNTHETIC.held.length===1');
    await ev(`switchView('scan');SYNTHETIC.release(true)`); await until('SYNTHETIC.held.length===0'); await sleep(50);
    await check(tag + 'late success after leaving does not steal navigation', `$('view-scan').classList.contains('show')&&reportSubmission===null&&EquipReportIntent.list(EquipApi.user().account).length===1`);
    await open('GEN-D07'); await fill(); await submit('hold'); await until('SYNTHETIC.held.length===1');
    await ev(`openDetail('SYNTHETIC-B');SYNTHETIC.release(false)`); await until(`currentCode==='SYNTHETIC-B'&&$('view-list').classList.contains('show')`); await sleep(50);
    await check(tag + 'late unknown after device change keeps new navigation and both unknowns', `currentCode==='SYNTHETIC-B'&&$('view-list').classList.contains('show')&&EquipReportIntent.list(EquipApi.user().account).length===2`);
    for (const identity of ['token', 'account']) {
        await open('SYNTHETIC-B'); await fill();
        await ev(`window.SYNTHETIC_SESSION=SessionStore.get();window.SYNTHETIC_BEFORE=SYNTHETIC.reportCalls().length;document.addEventListener('click',()=>SessionStore.merge(${identity === 'token' ? "{token:'SYNTHETIC-changed-token'}" : "{account:'SYNTHETIC-other-account',token:'SYNTHETIC-other-token'}"}),{once:true,capture:true})`);
        await click('#report-submit'); await until(`reportSubmission&&!reportSubmission.busy`);
        await check(tag + identity + ' switch before stale click dispatch causes zero RPC writes', `SYNTHETIC.reportCalls().length===SYNTHETIC_BEFORE&&SYNTHETIC.ledger.sequence===8`);
        await ev(`SessionStore.write(JSON.stringify(SYNTHETIC_SESSION))`);
        // The stale event is blocked before intent creation or RPC dispatch.
        await open('SYNTHETIC-B');
    }
    await open('SYNTHETIC-B', true); await fill();
    await ev(`window.SYNTHETIC_BEFORE=SYNTHETIC.reportCalls().length;window.SYNTHETIC_SB=window.supabase;_eqSb=null;window.supabase=null`);
    await click('#report-submit'); await until(`reportSubmission&&!reportSubmission.busy`);
    await check(tag + 'absent SDK never sends/falls back and preserves intent', `SYNTHETIC.reportCalls().length===SYNTHETIC_BEFORE&&reportSubmission.saved&&$('rp-submit-state').textContent.includes('Supabase')`);
    await ev(`window.supabase=SYNTHETIC_SB;_eqSb=null;SYNTHETIC.mode='missing'`); await click('#report-submit'); await until(`reportSubmission&&!reportSubmission.busy`);
    await check(tag + 'missing seven-argument RPC gives install guidance, never old fallback', `SYNTHETIC.reportCalls().length===SYNTHETIC_BEFORE+1&&$('rp-submit-state').textContent.includes('增量SQL')&&SYNTHETIC.calls.every(x=>x.name!=='equipment_report')&&SYNTHETIC.ledger.sequence===8`);
    await ev(`window.SYNTHETIC_GET=Storage.prototype.getItem;window.SYNTHETIC_KEY=Storage.prototype.key;window.SYNTHETIC_LENGTH=Object.getOwnPropertyDescriptor(Storage.prototype,'length');Storage.prototype.getItem=function(k){if(this===localStorage)throw new DOMException('SYNTHETIC LS read denied','SecurityError');return SYNTHETIC_GET.call(this,k)};Storage.prototype.key=function(i){if(this===localStorage)throw new DOMException('SYNTHETIC LS enumerate denied','SecurityError');return SYNTHETIC_KEY.call(this,i)};Object.defineProperty(Storage.prototype,'length',{configurable:true,enumerable:SYNTHETIC_LENGTH.enumerable,get(){if(this===localStorage)throw new DOMException('SYNTHETIC LS length denied','SecurityError');return SYNTHETIC_LENGTH.get.call(this)}});void 0`);
    await open('SYNTHETIC-A');
    await check(tag + 'unreadable localStorage recovers mirrored original UUID from native sessionStorage', `reportSubmission.saved.requestId===SYNTHETIC_OLD&&$('rp-symptom').readOnly&&EquipReportIntent.get(EquipApi.user().account,SYNTHETIC_OLD).state==='uncertain'`);
    await open('SYNTHETIC-A', true); await fill(); await ev(`window.SYNTHETIC_BEFORE=SYNTHETIC.reportCalls().length`); await click('#report-submit');
    await check(tag + 'partially unreadable native stores block fresh UUID instead of hiding unknowns', `SYNTHETIC.reportCalls().length===SYNTHETIC_BEFORE&&reportSubmission.saved===null&&SYNTHETIC.ledger.sequence===8`);
    await ev(`Storage.prototype.getItem=SYNTHETIC_GET;Storage.prototype.key=SYNTHETIC_KEY;Object.defineProperty(Storage.prototype,'length',SYNTHETIC_LENGTH);void 0`);
    await open('SYNTHETIC-A', true); await fill();
    await ev(`window.SYNTHETIC_BEFORE=SYNTHETIC.reportCalls().length;window.SYNTHETIC_SET=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(String(k).indexOf('equip_report_intent_v1:')===0)throw new DOMException('SYNTHETIC quota denied','QuotaExceededError');return SYNTHETIC_SET.call(this,k,v)}`);
    await click('#report-submit');
    await check(tag + 'both native browser intent storage writes unavailable blocks all sending', `SYNTHETIC.reportCalls().length===SYNTHETIC_BEFORE&&reportSubmission.saved===null&&SYNTHETIC.ledger.sequence===8`);
    await ev(`Storage.prototype.setItem=SYNTHETIC_SET`);
    await check(tag + 'seven params only; durable writes; no external operations/errors', `SYNTHETIC.reportCalls().every(x=>Object.keys(x.params).sort().join(',')==='p_code,p_expected,p_place,p_reportby,p_request_id,p_symptom,p_token'&&x.params.p_expected===''&&EquipReportIntent.validateId(x.params.p_request_id))&&SYNTHETIC_EXTERNAL.length===0&&SYNTHETIC_ERRORS.length===0&&document.documentElement.scrollWidth<=innerWidth+1`);
    const result = await ev(`({role:ROLE,width:innerWidth,accepted:SYNTHETIC.ledger.sequence,audits:SYNTHETIC.ledger.audit,syntheticNotifications:SYNTHETIC.ledger.syntheticNotificationCount,pending:EquipReportIntent.list(EquipApi.user().account).length,errors:SYNTHETIC_ERRORS,external:SYNTHETIC_EXTERNAL})`);
    caseResults.push(result); await shot(prefix + '_storage_blocked');
}
(async () => {
    const profile = path.join(OUT, 'chrome-' + Date.now()); fs.mkdirSync(profile);
    const fd = fs.openSync(path.join(OUT, 'chrome.log'), 'w');
    const browser = cp.spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
        '--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-component-update',
        '--disable-default-apps', '--disable-sync', '--no-pings', '--metrics-recording-only', '--disable-domain-reliability',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', fd, fd] });
    const guard = setTimeout(() => browser.kill(), 180000);
    try {
        const portFile = path.join(profile, 'DevToolsActivePort');
        for (let i = 0; i < 120 && !fs.existsSync(portFile); i++) await sleep(50);
        if (!fs.existsSync(portFile)) throw Error('No Chrome DevTools port');
        const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
        const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
        ws.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (requests.has(message.id)) { const request = requests.get(message.id); requests.delete(message.id); message.error ? request.reject(Error(message.error.message)) : request.resolve(message.result); }
            if (message.method === 'Fetch.requestPaused') {
                const p = message.params;
                if (/^https:\/\/synthetic-report-(admin|repairer|reporter)-(390|1440)\.invalid\/equipment\//.test(p.request.url)) {
                    send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }], body: Buffer.from(html).toString('base64') }).catch(error => console.error(error));
                } else { blockedResources.push(p.request.url); send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(error => console.error(error)); }
            }
            if (message.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: dialogChoice }).catch(error => console.error(error));
        });
        await send('Page.enable'); await send('Runtime.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
        for (const role of ['admin', 'repairer', 'reporter']) for (const width of [390, 1440]) await caseRun(role, width);
        if (blockedResources.some(url => !url.endsWith('/favicon.ico'))) throw Error('Unexpected blocked resource: ' + blockedResources.join(', '));
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ passed, failed: 0, checks, cases: caseResults, screenshots, hashes, blockedResources,
            caveat: 'Real Chrome and native storage; synthetic RPC ledger is not PostgreSQL/RLS/advisory-lock proof. No production HTTP, RPC, notification, print or real user data.' }, null, 2));
        console.log('Report idempotency browser: ' + passed + ' passed / 0 failed');
    } finally { clearTimeout(guard); if (ws) ws.close(); browser.kill(); fs.closeSync(fd); }
})().catch(error => { console.error(error.stack); fs.writeFileSync(path.join(OUT, 'failure.json'), JSON.stringify({ passed, checks, cases: caseResults, error: error.stack, hashes, blockedResources }, null, 2)); process.exitCode = 1; });
