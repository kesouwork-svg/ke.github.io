/* Web Bluetooth regression: mocked vendor API only. Never scans/connects/prints real hardware. */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'docs/equipment/js/dt-ble.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'docs/equipment/js/equipment-app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'docs/equipment/index.html'), 'utf8');
let pass = 0;
function ok(name, cond) { assert.ok(cond, name); pass++; }
function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
const tick = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
function context(opts = {}) {
    const els = {}, timers = new Map(), scripts = [], calls = {choose:0,open:[],print:[],stop:0,disconnect:0,confirm:[],codes:[],load:0,rotate:0};
    let timerId = 0, callback;
    const info = Object.assign({printerDPI:300,printerWidth:432,deviceId:'opaque-browser-id'}, opts.info);
    const chosen = {name:opts.name || 'DT-353-C60890706',deviceId:'opaque-browser-id',type:100,
        gattDevice:{gatt:{disconnect(){calls.disconnect++;api.connected=false;}}}};
    const api = {
        connected: false,
        requestDevice(p) {calls.choose++;calls.choiceOptions=p; if(!opts.cancel) p.deviceFound([chosen]); return Promise.resolve(opts.choice || {statusCode:0,resultInfo:[{name:'DT-353-OLD',deviceId:'old-cache'},chosen]});},
        openPrinter(p) {calls.open.push(p);callback=p.connectionStateChange;api.connected=true; return opts.openPromise || Promise.resolve(opts.open || {statusCode:0,resultInfo:info});},
        isConnected(){return api.connected;}, getPrinterInfo(){return info;},
        printImageData(p){calls.print.push(p); if(opts.printThrow) throw new Error('sync transport error'); if(opts.disconnectOnPrint){api.connected=false;callback({connected:false});} return opts.printPromise || Promise.resolve(opts.printResult || {statusCode:0});},
        stopPrint(){calls.stop++;if(opts.stopThrow)throw new Error('stopped after disconnect');}
    };
    const SDK = {LPAPI:{getInstance(p){calls.init=p;return api;}}};
    const sandbox = {console,Promise,Array,Math,Number,String,Object,Error,isFinite,Uint8ClampedArray,
        navigator:opts.unsupported ? {} : {bluetooth:{requestDevice(){throw new Error('REAL BLUETOOTH MUST NOT BE USED');}}},
        isSecureContext:!opts.insecure,
        setTimeout(fn,ms){timers.set(++timerId,{fn,ms});return timerId;},clearTimeout(id){timers.delete(id);},
        document:{getElementById(id){return els[id] || (els[id]={style:{},textContent:'',disabled:false});},
            createElement(){return {};}, head:{appendChild(s){scripts.push(s);s.parentNode=this;},removeChild(s){s.parentNode=null;}}},
        LPAPI:opts.noSdk ? undefined : SDK,
        LABEL_DPI:300,dtPrinting:false,labelScope:'单台 加工中心 · 模具部',
        labelTargets(){return opts.codes || ['PS00-42'];},showToast(s){calls.toast=s;},
        confirm(s){calls.confirm.push(s);return !opts.noConfirm;},
        loadLib(){calls.load++;return opts.qrFail ? Promise.reject(new Error('QR failed')) : Promise.resolve();},
        drawLabelCanvas(code){calls.codes.push(code);return {};},
        dtRotateCanvas(){calls.rotate++;return {width:472,height:709,getContext(){return {getImageData(x,y,w,h){
            const data = new Uint8ClampedArray(w*h*4);data.fill(255);
            if(opts.inkOutside && x===0 && w===472)data[0]=0;
            return {width:w,height:h,data,x,y};
        }};}};}
    };
    sandbox.window=sandbox;
    vm.createContext(sandbox);vm.runInContext(JS,sandbox,{filename:'dt-ble.js'});
    return {b:sandbox.DtBle,s:sandbox,api,chosen,calls,els,timers,scripts,SDK,
        timer(ms){const entries=[...timers.entries()].filter(([,t])=>t.ms===ms);ok('expected timer '+ms,entries.length>0);for(const [id,t]of entries){timers.delete(id);t.fn();}},
        lost(){api.connected=false;callback({connected:false});}};
}
async function main(){
    {
        const t=context();await t.b.prepare();ok('prepare never opens chooser',t.calls.choose===0);ok('prepare never connects/prints',!t.calls.open.length&&!t.calls.print.length);
        await t.b.connect();ok('explicit click opens chooser once',t.calls.choose===1);ok('exact SDK model',t.calls.init.models==='DT-353');ok('BLE only, never HID',t.calls.init.webBLE===true&&t.calls.init.webHID===false);
        ok('uses actual chooser item rather than first cached printer',t.calls.open[0].deviceId==='opaque-browser-id');ok('no autoscan',t.calls.open[0].autoScan===false);ok('no ambiguous name option',!('name' in t.calls.open[0]));ok('one manual attempt disables SDK five retries',t.calls.open[0].tryTimes===1);ok('connection never prints',t.calls.print.length===0);
        ok('shows connected state',t.els['dt-ble-status'].textContent.includes('已连接'));ok('shows single test button',t.els['dt-ble-test'].style.display==='');
        await t.b.print(false);ok('single displayed label prints once',t.calls.print.length===1);ok('single scope passed to confirm',t.calls.confirm[0].includes('1 张')&&t.calls.confirm[0].includes('单台'));
        ok('uses existing canvas and clockwise rotation',t.calls.codes.join() === 'PS00-42'&&t.calls.rotate===1);ok('only white margins cropped to real head width',t.calls.print[0].imageData.width===432&&t.calls.print[0].imageData.x===20);
        ok('height unchanged, no second rotation',t.calls.print[0].imageData.height===709&&t.calls.print[0].orientation===0);ok('single copy',t.calls.print[0].printCopies===1);
        ok('does not claim physical completion',t.els['dt-ble-status'].textContent.includes('发送成功不等于出纸成功'));ok('releases shared USB lock',t.s.dtPrinting===false&&!t.b.isBusy());
        t.b.disconnect();ok('native GATT disconnect used',t.calls.disconnect===1);ok('no SDK closePrinter method or auto flush',!JS.includes('.closePrinter('));
    }
    {
        const t=context({cancel:true});await t.b.connect();ok('cancel with stale cached result never opens old device',t.calls.open.length===0);ok('cancel never prints',t.calls.print.length===0);ok('cancel restores UI',t.els['dt-ble-status'].textContent.includes('已取消'));
    }
    {
        const t=context({name:'DP30S-OTHER'});await t.b.connect();ok('other model rejected before connect',t.calls.open.length===0);
        const bad=context({open:{statusCode:5}});await bad.b.connect();ok('failed handshake disconnects safely',bad.calls.disconnect===1);ok('failed connect never exposes print',bad.els['dt-ble-print'].style.display==='none');
    }
    {
        const t=context({open:{statusCode:4,errMsg:'打印机链接失败',codeName:'ERROR_CONNECT_FAILED',resultInfo:{name:'NetworkError',message:'GATT connection failed'}}});
        await t.b.connect();const status=t.els['dt-ble-status'].textContent;
        ok('failed selected device is not described as unpaired',status.includes('已选择 DT-353-C60890706')&&status.includes('连接未建立'));
        ok('generic SDK message no longer hides failure code',status.includes('SDK 4')&&status.includes('ERROR_CONNECT_FAILED'));
        ok('failure includes stage and available native detail',status.includes('失败阶段')&&status.includes('NetworkError: GATT connection failed'));
        ok('does not blame unsupported BLE after a valid selection',!status.includes('不代表支持 BLE'));
        ok('connection error explicitly says no labels sent',status.includes('未发送标签')&&t.calls.print.length===0);
        const pending=deferred(),waiting=context({openPromise:pending.promise});const connecting=waiting.b.connect();await tick();
        ok('during open paired and connected remain distinct',waiting.els['dt-ble-status'].textContent.includes('已配对')&&waiting.els['dt-ble-status'].textContent.includes('正在建立'));
        ok('during open no print controls are exposed',waiting.els['dt-ble-print'].style.display==='none');
        pending.resolve({statusCode:0});await connecting;
    }
    {
        const t=context({unsupported:true});await t.b.prepare();await t.b.connect();ok('unsupported browser no chooser/load/connection',t.calls.choose===0&&t.scripts.length===0&&t.calls.open.length===0);ok('fallback explains alternatives',t.els['dt-ble-status'].textContent.includes('下载图片'));
        const insecure=context({insecure:true});await insecure.b.connect();ok('insecure context refused',insecure.calls.choose===0);
    }
    {
        const t=context({noSdk:true});const ready=t.b.prepare();ok('SDK only lazy loaded from this site',t.scripts.length===1&&t.scripts[0].src==='./js/lpapi-ble-1.8.261015.umd.js');ok('SDK has pinned SRI',t.scripts[0].integrity.startsWith('sha256-'));
        ok('loading never auto connects',t.calls.choose===0);t.s.LPAPI=t.SDK;t.scripts[0].onload();await ready;ok('onload still never connects',t.calls.choose===0);
        const retry=context({noSdk:true});const pending=retry.b.connect();retry.s.LPAPI=retry.SDK;retry.scripts[0].onload();await pending;ok('async load asks for fresh click, not chooser',retry.calls.choose===0);ok('retry message explicit',retry.els['dt-ble-status'].textContent.includes('再点一次'));
        const failed=context({noSdk:true});const fail=failed.b.prepare();failed.scripts[0].onerror();await fail;ok('failed load unlocks retry button',failed.els['dt-ble-connect'].disabled===false);const again=failed.b.prepare();ok('failed load can retry',failed.scripts.length===2);failed.scripts[1].onerror();await again;
        const timeout=context({noSdk:true});const l=timeout.b.prepare();timeout.timer(15000);await l;ok('SDK load timeout releases UI',timeout.els['dt-ble-connect'].disabled===false);
    }
    {
        const t=context({codes:['A','B','C']});await t.b.connect();await t.b.print(true);ok('test is capped to exactly one',t.calls.print.length===1&&t.calls.codes.join()==='A');ok('test confirmation identifies first code',t.calls.confirm[0].includes('仅打印：A'));
        const cancelled=context({noConfirm:true});await cancelled.b.connect();await cancelled.b.print(false);ok('cancel print sends nothing',cancelled.calls.print.length===0&&!cancelled.s.dtPrinting);
        const empty=context({codes:[]});await empty.b.connect();await empty.b.print(false);ok('empty page does not send',empty.calls.print.length===0);
    }
    for(const id of ['wrong-id',undefined]) {const t=context({info:{deviceId:id}});await t.b.connect();await t.b.print(true);ok('unverified identity refuses print',!t.calls.print.length);}
    for(const opt of [{info:{printerDPI:203}},{info:{printerDPI:0}},{info:{printerWidth:0}},{info:{printerWidth:NaN}},{inkOutside:true}]){
        const t=context(opt);await t.b.connect();await t.b.print(true);ok('DPI/head/crop guard sends zero '+JSON.stringify(opt),t.calls.print.length===0);ok('guard releases USB lock',!t.s.dtPrinting&&!t.b.isBusy());
    }
    {
        const t=context({info:{printerWidth:500}});await t.b.connect();await t.b.print(true);ok('wide head does not scale image',t.calls.print[0].imageData.width===472);
        const d=deferred(),serial=context({codes:['A','B','C'],printPromise:d.promise});await serial.b.connect();const job=serial.b.print(false);await tick();ok('batch strictly serial',serial.calls.print.length===1);ok('locks USB during BLE send',serial.s.dtPrinting&&serial.b.isBusy());
        await serial.b.print(true);ok('duplicate click never sends second job',serial.calls.print.length===1);serial.b.stop();d.resolve({statusCode:0});await job;ok('stop prevents remaining labels',serial.calls.print.length===1);ok('stop acknowledges possible in-flight paper',serial.els['dt-ble-status'].textContent.includes('可能已出纸'));
        const fail=context({codes:['A','B','C'],printResult:{statusCode:23,errMsg:'write failed'}});await fail.b.connect();await fail.b.print(false);ok('first error stops entire batch/no retry',fail.calls.print.length===1);ok('partial error asks user to verify',fail.els['dt-ble-status'].textContent.includes('勿直接重打'));ok('error unlocks USB',!fail.s.dtPrinting);
        const lost=context({codes:['A','B'],disconnectOnPrint:true});await lost.b.connect();await lost.b.print(false);ok('disconnect stops remaining labels',lost.calls.print.length===1);ok('disconnect hides print button',lost.els['dt-ble-print'].style.display==='none');
        const sync=context({printThrow:true,stopThrow:true});await sync.b.connect();await sync.b.print(true);ok('sync SDK throw and stop error still unlock',!sync.s.dtPrinting&&!sync.b.isBusy());
        const qr=context({qrFail:true});await qr.b.connect();await qr.b.print(true);ok('QR error sends nothing/unlocks',qr.calls.print.length===0&&!qr.s.dtPrinting);
    }
    {
        const d=deferred(),t=context({openPromise:d.promise});const connecting=t.b.connect();await tick();t.timer(25000);await connecting;ok('connect timeout quarantines unresolved operation',t.b.isBusy()&&t.calls.disconnect>=1);await t.b.connect();ok('cannot reconnect into unresolved old operation',t.calls.choose===1);d.resolve({statusCode:0});await tick();ok('late connection cleaned and quarantine released',!t.b.isBusy()&&t.calls.disconnect>=2&&t.calls.print.length===0);
        const write=deferred(),p=context({printPromise:write.promise});await p.b.connect();const job=p.b.print(true);await tick();p.timer(60000);await job;ok('send timeout stops and disconnects',p.calls.stop>0&&p.calls.disconnect===1);ok('send timeout keeps old operation quarantined',!p.s.dtPrinting&&p.b.isBusy());write.resolve({statusCode:0});await tick();ok('late send never retries and releases quarantine',p.calls.print.length===1&&!p.b.isBusy());
    }
    {
        const t=context();await t.b.connect();t.s.dtPrinting=true;await t.b.print(false);ok('USB lock blocks BLE',t.calls.print.length===0);t.s.dtPrinting=false;
        const start=APP.indexOf('function dtPrintLabels()'),end=APP.indexOf('// 页面上显示/隐藏',start),usb=APP.slice(start,end);
        ok('USB checks shared state before and after async probe',(usb.match(/DtBle\.isBusy\(\)/g)||[]).length===2);
        ok('existing single-scope source untouched',APP.includes('var codes = labelTargets();'));ok('BLE lazy preparation only from label page',APP.includes("if (typeof DtBle !== 'undefined') DtBle.prepare();"));
        ok('new script included',/src="\.\/js\/dt-ble\.js(?:\?v=[a-f0-9]+)?"/.test(HTML));ok('official SDK not eager HTML script',!HTML.includes('<script src="./js/lpapi-ble-'));
        ok('separate trial button is one only',HTML.includes('onclick="DtBle.print(true)"'));ok('existing USB button retained',HTML.includes('onclick="dtPrintLabels()"'));
        ok('BLE status hidden when printing',fs.readFileSync(path.join(ROOT,'docs/equipment/css/equipment.css'),'utf8').includes('.toast,#dt-ble-status{display:none!important}'));
        ok('no MAC-based silent access',!JS.includes('28:D4:1E'));
        const data=fs.readFileSync(path.join(ROOT,'docs/equipment/js/lpapi-ble-1.8.261015.umd.js'));
        ok('vendor integrity matches upstream exactly',crypto.createHash('sha256').update(data).digest('hex')==='68e886c427f439bceaddda30951f650178ae8ff88ab3b4aa493d0e5f90e51db3');
    }
    console.log('通过 '+pass+' / 失败 0');
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
