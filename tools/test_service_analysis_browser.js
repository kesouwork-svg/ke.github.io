'use strict';
// Real current HTML/CSS/controller with existing read-only synthetic RPC fixture.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const harness = require('./test_equipment_analysis_browser');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'outputs/Service_Analysis_20261117');
fs.mkdirSync(out, { recursive: true });
const rec = (id, extra = {}) => ({ id, no: 'SYN-' + id, type: 'fault', status: 'done', reportAt: '2026-10-01', doneAt: '2026-10-03',
    expectedAt: '2026-10-02T12:00', repairMode: 'inner', handler: '员工甲', cost: 10, symptom: '合成测试现象', ...extra });
for (const code of Object.keys(harness.fixtureData)) delete harness.fixtureData[code];
harness.fixtureData['SYN A&设备'] = { name: '合成测试设备', line: '模具部', family: '测试类', records: [rec('inner'),
    rec('outer', { repairMode: 'outer', supplier: '外协甲', cost: 100 }), rec('conflict', { supplier: '矛盾外协' }),
    rec('unknown', { repairMode: '' }), rec('missing', { repairMode: 'outer', supplier: '' }),
    rec('unsafe', { handler: '<img src=x onerror="window.injected=1">' }), rec('maintain', { type: 'maintain' })] };
let passed = 0, ws, chrome, log, deadline, id = 0;
const pending = new Map(), errors = [], requests = [], results = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
function send(method, params = {}) { return new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); }); }
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
async function until(expression) { for (let n = 0; n < 120; n++) { if (await evaluate(expression)) return; await pause(40); } throw Error('Timeout: ' + expression); }
async function check(name, expression) { const ok = !!await evaluate(expression); results.push({ name, ok }); if (!ok) throw Error(name); passed++; }
async function click(expression) {
    const point = await evaluate('(()=>{const e=' + expression + ';e.scrollIntoView({block:"center",behavior:"instant"});const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); await pause(90);
}
async function navigate(role, width) {
    const file = path.join(out, 'preview_' + role + '_' + width + '.html'); fs.writeFileSync(file, harness.documentFor(role, false));
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: new URL('file:///' + file.replace(/\\/g, '/')).href });
    await until('window.__analysisFixture && !document.getElementById("refresh-data").disabled');
}
(async () => {
    const profile = path.join(out, 'chrome-' + Date.now()); fs.mkdirSync(profile);
    log = fs.openSync(path.join(out, 'browser.log'), 'w');
    chrome = cp.spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', log, log], windowsHide: true });
    deadline = setTimeout(() => { chrome.kill(); console.error('Browser deadline'); process.exit(1); }, 90000);
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let n = 0; n < 90 && !fs.existsSync(portFile); n++) await pause(65);
    if (!fs.existsSync(portFile)) throw Error('No Chrome debug port');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0], tabs = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    ws = new WebSocket(tabs[0].webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
    ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); if (p) m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); }
        if (m.method === 'Runtime.exceptionThrown') errors.push(m.params); if (m.method === 'Network.requestWillBeSent' && /^https?:/.test(m.params.request.url)) requests.push(m.params.request.url); });
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    for (const role of ['admin', 'repairer']) for (const width of [390, 1440]) {
        await navigate(role, width); const pre = role + '/' + width + ' ';
        await click('document.querySelector(".analysis-jump a[href=\\\"#service-title\\\"]")');
        await check(pre + 'section link scrolls heading below sticky header', 'location.hash==="#service-title" && document.getElementById("service-title").getBoundingClientRect().top >= document.querySelector(".analysis-header").getBoundingClientRect().bottom && document.getElementById("service-title").getBoundingClientRect().top < 180');
        await check(pre + 'two confirmed mode groups, unverified in quality panel, personnel groups preserved', 'document.querySelectorAll("#service-modes details").length===2 && document.querySelectorAll("#service-employees details").length===2 && document.querySelectorAll("#service-suppliers details").length===2 && document.querySelectorAll(".quality-panel #service-unverified details").length===1');
        await check(pre + 'unsafe names rendered as text', '!window.injected && !document.querySelector("#service-employees img")');
        await check(pre + 'no details generated until expanded', '!document.querySelector(".service-records table")');
        await click('document.querySelector("#service-unverified summary")');
        await check(pre + 'moved group expands correct unknown records and retains denominator', 'document.querySelectorAll("#service-unverified tbody tr").length===2 && document.querySelector("#service-unverified tbody").textContent.includes("内部维修与外协名称矛盾") && document.querySelector("#service-unverified tbody").textContent.includes("维修方式缺失或无效") && document.getElementById("service-caption").textContent.includes("待核实 2 单") && document.getElementById("service-modes").textContent.includes("33.3%")');
        await check(pre + 'moved original links keep record identifiers', '[...document.querySelectorAll("#service-unverified tbody a")].every(a=>["SYN-conflict","SYN-unknown"].includes(new URL(a.href).searchParams.get("wo")))');
        await click('document.querySelector("#service-suppliers summary")');
        await check(pre + 'supplier original work-order and internal contact visible', 'document.querySelector("#service-suppliers tbody").textContent.includes("员工甲") && document.querySelector("#service-suppliers tbody a")');
        await check(pre + 'encoded links target exact equipment and work order', '(()=>{const a=document.querySelector("#service-suppliers tbody a"),u=new URL(a.href);return u.searchParams.get("code")==="SYN A&设备"&&u.searchParams.get("wo").startsWith("SYN-")})()');
        await check(pre + 'work order is clickable in the second column without horizontal scrolling', '(()=>{const a=document.querySelector("#service-suppliers tbody a"), bounds=a.getBoundingClientRect(), table=a.closest(".table-scroll").getBoundingClientRect();return a.textContent.startsWith("SYN-") && a.closest("td").cellIndex===1 && bounds.left>=table.left && bounds.right<=table.right})()');
        await check(pre + 'no page-level horizontal overflow', 'document.documentElement.scrollWidth<=innerWidth');
        await evaluate('window.oldSummary=document.getElementById("summary-cards").textContent;document.getElementById("service-type").value="maintain";document.getElementById("service-type").dispatchEvent(new Event("change"))');
        await check(pre + 'type changes only this section and no extra reads', 'document.getElementById("service-caption").textContent.includes("共 1 单") && document.getElementById("summary-cards").textContent===oldSummary && JSON.stringify(__analysisFixture.calls)===JSON.stringify(["me","equipment_list"])');
        await check(pre + 'moved quality group follows selected type and clears previous detail rows', 'document.getElementById("service-unverified-caption").textContent.includes("保养") && document.getElementById("service-unverified-caption").textContent.includes("待核实 0 单") && !document.querySelector("#service-unverified tbody")');
        await evaluate('document.getElementById("reset-filters").click();document.getElementById("service-title").scrollIntoView({block:"start",behavior:"instant"})'); await pause(100);
        await check(pre + 'reset restores fault analysis', 'document.getElementById("service-type").value==="fault"&&document.getElementById("service-caption").textContent.includes("共 6 单")');
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(out, role + '_' + width + '.png'), Buffer.from(shot.data, 'base64'));
        await evaluate('__analysisFixture.mode="fail";document.getElementById("refresh-data").click()'); await until('!document.getElementById("refresh-data").disabled');
        await check(pre + 'read failure clears all service data', 'document.getElementById("analysis-content").hidden && ["service-modes","service-employees","service-suppliers","service-caption","service-unverified","service-unverified-caption"].every(id=>document.getElementById(id).textContent==="")');
    }
    for (const role of ['reporter', 'view']) { await navigate(role, 390); await check(role + 'cannot read service data', 'document.getElementById("analysis-content").hidden && !document.getElementById("service-modes").textContent && JSON.stringify(__analysisFixture.calls)===JSON.stringify(["me"])'); }
    if (errors.length || requests.length) throw Error(JSON.stringify({ errors, requests }));
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ passed, failed: 0, synthetic: true, errors, requests, results }, null, 2));
    console.log(passed + ' browser checks passed / 0 failed (synthetic, no production access)');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; }).finally(() => { clearTimeout(deadline); if (ws) { try { ws.send(JSON.stringify({ id: ++id, method: 'Browser.close' })); ws.close(); } catch (_) {} } if (chrome) chrome.kill(); if (log !== undefined) fs.closeSync(log); });
