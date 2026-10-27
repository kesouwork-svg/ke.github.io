'use strict';
/* Permanent OFFLINE range contract.
 * Run: node tools/test_label_range.js
 * Executes the COMPLETE production app and dt-ble.js, and checks actual HTML/CSS.
 * Only SDK, QR generation, DOM/canvas, timers and native I/O boundaries are fake.
 * Never uses a browser, network, real Bluetooth/USB, OS print or disk downloads.
 * Deliberately does not extract/reimplement/replace any application function.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const APP = read('docs/equipment/js/equipment-app.js');
const BLE = read('docs/equipment/js/dt-ble.js');
const HTML = read('docs/equipment/index.html');
const CSS = read('docs/equipment/css/equipment.css');
const SDK = fs.readFileSync(path.join(ROOT, 'docs/equipment/js/lpapi-ble-1.8.261015.umd.js'));
const ALL = Array.from({ length: 22 }, (_, i) => 'PS04-' + String(i + 1).padStart(2, '0')).concat(['PS04-60', 'PS04-95', 'PS04-96']);
const EQUIPMENT = Object.fromEntries(ALL.map((code, i) => [code, {
    code, name: code === 'PS04-95' ? '端点平面磨床九五' : code === 'PS04-60' ? '前一张磨床六零' : code === 'PS04-96' ? '终点平面磨床九六' : '平面磨床' + (i + 1),
    number: 'M-' + (i + 1), line: '模具部', category: 'prod', family: '磨削/抛光', model: 'M618', records: []
}]));
let passed = 0, failed = 0;
async function test(name, check) {
    try { await check(); passed++; console.log('  PASS ' + name); }
    catch (error) { failed++; console.error('  FAIL ' + name + '\n       ' + (error.stack || error)); }
}
function same(actual, expected) { assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected); }
async function tick() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function attrs(text) {
    const out = {};
    for (const match of text.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) out[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
    return out;
}
function strip(text) { return String(text).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'); }
function fixture(options = {}) {
    const elements = {}, created = [], timers = new Map(), storage = new Map();
    const calls = { choose: [], open: [], send: [], stop: 0, disconnect: 0, confirmations: [], fetch: [], downloads: [], browserPrint: 0, native: [], qr: [], canvases: [], scripts: [] };
    let timerId = 0, latestQr = '', active = 0, maxActive = 0;
    const printInfo = { printerDPI: 300, printerWidth: 472, deviceId: 'offline-device-only' };
    const printer = { name: 'DT-353-OFFLINE', deviceId: printInfo.deviceId, type: 100, gattDevice: { gatt: { disconnect() { calls.disconnect++; api.connected = false; } } } };
    const api = {
        connected: false,
        requestDevice(params) { calls.choose.push(params); params.deviceFound([printer]); return Promise.resolve({ statusCode: 0, resultInfo: [printer] }); },
        openPrinter(params) { calls.open.push(params); this.connected = true; return Promise.resolve({ statusCode: 0, resultInfo: printInfo }); },
        isConnected() { return this.connected; }, getPrinterInfo() { return printInfo; },
        printImageData(params) {
            calls.send.push(params); active++; maxActive = Math.max(maxActive, active);
            const pending = options.send ? options.send(params, calls.send.length) : Promise.resolve({ statusCode: 0 });
            return Promise.resolve(pending).then(value => { active--; return value; }, error => { active--; throw error; });
        },
        stopPrint() { calls.stop++; }
    };
    function makeElement(tag, initial = {}) {
        const attributes = { ...initial }, listeners = {};
        let html = '', text = '', value = initial.value || '';
        const classes = new Set((initial.class || '').split(/\s+/).filter(Boolean));
        const element = {
            tagName: tag.toUpperCase(), id: initial.id || '', style: {}, children: [], disabled: false,
            type: initial.type || '', min: initial.min || '', max: initial.max || '', step: initial.step || '',
            get value() { return value; }, set value(v) { value = String(v); },
            get textContent() { return text || strip(html); }, set textContent(v) { text = String(v); html = ''; },
            get innerHTML() { return html; }, set innerHTML(v) { html = String(v); text = ''; },
            get className() { return [...classes].join(' '); }, set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
            classList: { add(...v) { v.forEach(c => classes.add(c)); }, remove(...v) { v.forEach(c => classes.delete(c)); }, contains(c) { return classes.has(c); }, toggle(c, force) { const yes = force === undefined ? !classes.has(c) : force; if (yes) classes.add(c); else classes.delete(c); return yes; } },
            getAttribute(name) { return Object.hasOwn(attributes, name) ? attributes[name] : null; },
            setAttribute(name, v) { attributes[name] = String(v); if (name === 'id') this.id = String(v); },
            removeAttribute(name) { delete attributes[name]; },
            addEventListener(name, cb) { (listeners[name] || (listeners[name] = [])).push(cb); },
            dispatchEvent(event) {
                const eventName = event.type;
                if (attributes['on' + eventName]) vm.runInContext(attributes['on' + eventName], context);
                for (const cb of listeners[eventName] || []) cb.call(this, event);
                return true;
            },
            appendChild(child) {
                this.children.push(child); child.parentNode = this;
                if (child.tagName === 'SCRIPT') { calls.scripts.push(child.src); throw Error('OFFLINE: script injection is forbidden'); }
                return child;
            },
            removeChild(child) { this.children = this.children.filter(c => c !== child); child.parentNode = null; return child; },
            querySelectorAll() { return []; }, querySelector() { return null; }, contains(other) { return this === other || this.children.includes(other); },
            focus() {}, click() { if (this.tagName === 'A') calls.downloads.push({ href: this.href, name: this.download }); }
        };
        created.push(element); return element;
    }
    function makeCanvas() {
        const cv = makeElement('canvas'); cv.width = 0; cv.height = 0; cv._qr = latestQr; cv._texts = [];
        const ctx = {
            fillStyle: '#000', font: '', textBaseline: '', textAlign: '',
            fillRect() {}, fillText(text) { cv._texts.push(String(text)); }, measureText(text) { return { width: String(text ?? '').length * 12 }; },
            translate() {}, rotate() {}, drawImage(source) { cv._source = source; },
            getImageData(x, y, width, height) {
                const source = cv._source || cv, data = new Uint8ClampedArray(width * height * 4); data.fill(255);
                return { width, height, data, _qr: source._qr, _texts: source._texts.slice() };
            }
        };
        cv.getContext = kind => { assert.equal(kind, '2d'); return ctx; };
        cv.toDataURL = format => { assert.equal(format, 'image/png'); return 'data:image/png;base64,' + Buffer.from(JSON.stringify({ qr: cv._qr, text: cv._texts })).toString('base64'); };
        calls.canvases.push(cv); return cv;
    }
    // Materialize only elements actually present in the real HTML, not arbitrary IDs.
    for (const tag of HTML.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="[^"]+"[^>]*)>/gi)) {
        const attributes = attrs(tag[2]);
        assert(!elements[attributes.id], 'duplicate DOM ID: ' + attributes.id);
        elements[attributes.id] = makeElement(tag[1], attributes);
    }
    const store = { getItem(key) { return storage.has(key) ? storage.get(key) : null; }, setItem(key, value) { storage.set(key, String(value)); }, removeItem(key) { storage.delete(key); } };
    const forbiddenNative = name => () => { calls.native.push(name); throw Error('OFFLINE native boundary forbidden: ' + name); };
    const sandbox = {
        console, Uint8Array, Uint8ClampedArray, ArrayBuffer, DataView, TextEncoder, TextDecoder, Blob, DOMException,
        setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
        setInterval() { return 0; }, clearInterval() {},
        navigator: { userAgent: 'OfflineRangeTest', bluetooth: { requestDevice: forbiddenNative('bluetooth'), getDevices: forbiddenNative('bluetooth discovery') }, usb: { requestDevice: forbiddenNative('usb') } },
        isSecureContext: true, location: { origin: 'https://offline.invalid', pathname: '/equipment/index.html', search: '', hash: '' },
        localStorage: store, sessionStorage: store, addEventListener() {}, removeEventListener() {}, scrollTo() {},
        alert() {}, prompt() { return null; }, confirm(message) { calls.confirmations.push(message); return options.confirm !== false; },
        print() { calls.browserPrint++; },
        atob(value) { return Buffer.from(value, 'base64').toString('binary'); },
        URL: { createObjectURL(blob) { calls.lastBlob = blob; return 'blob:offline'; }, revokeObjectURL() {} },
        fetch(url, init) {
            const text = String(url); calls.fetch.push({ url: text, init });
            let resultInfo;
            if (text === 'http://127.0.0.1:15216/local/ServerInfo') resultInfo = { version: 'OFFLINE' };
            else if (text === 'http://127.0.0.1:15216/lpapi/GetPrinters') resultInfo = { printers: [{ name: printer.name, deviceDPI: 300, isOnline: true }] };
            else if (text.startsWith('http://127.0.0.1:15216/lpapi/PrintImageD?')) resultInfo = 'OFFLINE_OK';
            else throw Error('OFFLINE: unexpected network attempt ' + text);
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ statusCode: 0, resultInfo }) });
        },
        document: {
            getElementById(id) { return elements[id] || created.find(el => el.id === id && el.parentNode) || null; },
            querySelectorAll(selector) { return selector === '.view' ? Object.values(elements).filter(el => el.classList.contains('view')) : []; },
            querySelector() { return null; }, addEventListener() {},
            createElement(tag) { return tag === 'canvas' ? makeCanvas() : makeElement(tag); },
            head: makeElement('head'), body: makeElement('body')
        },
        LPAPI: { LPAPI: { getInstance(params) { calls.sdkOptions = params; return api; } } },
        qrcode() { return { addData(value) { this.text = String(value); latestQr = this.text; calls.qr.push(this.text); }, make() {}, getModuleCount() { return 21; }, isDark(r, c) { return (r * 7 + c * 3) % 5 < 2; }, createSvgTag() { return '<svg data-qr="' + this.text + '"></svg>'; } }; }
    };
    sandbox.window = sandbox; sandbox.self = sandbox;
    const context = vm.createContext(sandbox);
    const run = code => vm.runInContext(code, context, { timeout: 10000 });
    vm.runInContext(APP, context, { filename: 'equipment-app.js', timeout: 10000 });
    vm.runInContext(BLE, context, { filename: 'dt-ble.js', timeout: 10000 });
    run('ROLE="admin"; EQ=' + JSON.stringify(EQUIPMENT) + '; _libs.qr=Promise.resolve();');
    return {
        run, calls, elements, sandbox, api, maxActive: () => maxActive,
        async show(codes = ALL) { run('showLabels(' + JSON.stringify(codes) + ')'); await tick(); },
        async select(from, to) {
            assert(elements['label-from'] && elements['label-to'], 'actual HTML must supply range inputs');
            elements['label-from'].value = from; elements['label-to'].value = to;
            run('onLabelRangeChange()'); await tick();
        },
        traffic() { return { bluetooth: calls.send.length, usb: calls.fetch.length, downloads: calls.downloads.length, browser: calls.browserPrint, native: calls.native.length, confirmations: calls.confirmations.length }; },
        async flushUsb() {
            for (let n = 0; n < ALL.length + 5; n++) {
                await tick();
                const next = [...timers].filter(([, timer]) => timer.ms === 120);
                if (!next.length) return;
                for (const [id, timer] of next) { timers.delete(id); timer.fn(); }
            }
            throw Error('USB fake timer did not settle');
        }
    };
}
function info(t, from, to) {
    const result = t.run('labelRangeInfo()');
    assert.equal(result.ok, true); assert.equal(result.total, ALL.length); assert.equal(result.from, from); assert.equal(result.to, to);
    same(result.codes, ALL.slice(from - 1, to)); same(t.run('labelTargets()'), ALL.slice(from - 1, to));
    return result;
}
function checkEndpoint(t, id, code) {
    const text = t.elements[id].textContent;
    assert(text.includes(code), id + ' must include code ' + code + ': ' + text);
    assert(text.includes(EQUIPMENT[code].name), id + ' must include equipment name: ' + text);
}
function rangeText(t, from, to) {
    const text = t.run('labelRangeText()');
    assert(text.includes('第 ' + from + '–' + to + ' 张 / 共 ' + ALL.length + ' 张'), 'absolute range text: ' + text);
    for (const code of [ALL[from - 1], ALL[to - 1]]) { assert(text.includes(code)); assert(text.includes(EQUIPMENT[code].name)); }
    return text;
}
function sentCodes(t) { return t.calls.send.map(send => new URL(send.imageData._qr).searchParams.get('code')); }
function printCalls(t) { return t.calls.fetch.filter(call => call.url.includes('/lpapi/PrintImageD?')); }
function zipNames(bytes) {
    const buffer = Buffer.from(bytes), names = [];
    for (let offset = 0; offset + 46 <= buffer.length; offset++) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) continue;
        const length = buffer.readUInt16LE(offset + 28); names.push(buffer.subarray(offset + 46, offset + 46 + length).toString('utf8'));
        offset += 45 + length + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
    }
    return names;
}
async function main() {
    console.log('Label range offline regression (full production APP + dt-ble + HTML/CSS)');
    await test('global range API contract exists in complete app', () => {
        const t = fixture();
        for (const name of ['labelAllTargets', 'labelRangeInfo', 'labelTargets', 'labelRangeText', 'showLabels', 'onLabelRangeChange', 'resetLabelRange']) assert.equal(t.run('typeof ' + name), 'function', name);
    });
    await test('HTML has unique accessible range controls and endpoint/message containers', () => {
        for (const id of ['label-from', 'label-to', 'label-range-message', 'label-from-device', 'label-to-device']) assert.equal([...HTML.matchAll(new RegExp('id="' + id + '"', 'g'))].length, 1, id);
        for (const id of ['label-from', 'label-to']) {
            const tag = HTML.match(new RegExp('<input\\b[^>]*id="' + id + '"[^>]*>'));
            assert(tag, 'native input ' + id); assert(/(?:aria-label="[^"]+"|aria-labelledby="[^"]+")/.test(tag[0]) || HTML.includes('for="' + id + '"'));
            assert(/on(?:input|change)="onLabelRangeChange\(\)"/.test(tag[0]), 'real DOM event wired to range validation');
        }
        assert(/onclick="resetLabelRange\(\)"/.test(HTML));
    });
    await test('range UI has styles and its sequence helper is hidden in print media', () => {
        assert(/\.label-range[\w-]*\s*\{/.test(CSS), 'range-specific screen CSS');
        const print = CSS.slice(CSS.indexOf('@media print'));
        assert(print.includes('label-range'), 'range controls hidden for browser printing');
        assert(/\.label-(?:index|sequence|ordinal|no|seq|number)/.test(print), 'on-screen absolute sequence helper hidden when printing');
    });
    await test('vendor SDK bytes and manual BLE connection parameters remain pinned', async () => {
        assert.equal(crypto.createHash('sha256').update(SDK).digest('hex'), '68e886c427f439bceaddda30951f650178ae8ff88ab3b4aa493d0e5f90e51db3');
        const t = fixture(); assert.equal(await t.sandbox.DtBle.connect(), true);
        const options = t.calls.open[0]; assert.equal(options.tryTimes, 1); assert.equal(options.autoScan, false); assert.equal(options.webBLE, true); assert.equal(options.webHID, false);
        assert.equal(t.calls.sdkOptions.models, 'DT-353'); same(t.calls.native, []); assert.equal(t.calls.send.length, 0);
        assert(!BLE.includes('.closePrinter('), 'never auto-flush via closePrinter');
    });
    await test('1..N defaults and full-snapshot order are defensive copies', async () => {
        const t = fixture(); await t.show(); info(t, 1, ALL.length); rangeText(t, 1, ALL.length);
        assert.equal(t.elements['label-from'].value, '1'); assert.equal(t.elements['label-to'].value, String(ALL.length));
        same(t.run('labelAllTargets()'), ALL); t.run('labelAllTargets().reverse()'); same(t.run('labelAllTargets()'), ALL);
        t.run('labelRangeInfo().codes.pop(); labelTargets().shift()'); same(t.run('labelTargets()'), ALL);
        checkEndpoint(t, 'label-from-device', ALL[0]); checkEndpoint(t, 'label-to-device', ALL.at(-1));
    });
    await test('24..N starts PS04-95, not previous absolute #23 PS04-60', async () => {
        const t = fixture(); await t.show(); assert.equal(ALL[22], 'PS04-60'); assert.equal(ALL[23], 'PS04-95');
        await t.select('24', String(ALL.length)); info(t, 24, ALL.length); rangeText(t, 24, ALL.length);
        checkEndpoint(t, 'label-from-device', 'PS04-95'); checkEndpoint(t, 'label-to-device', ALL.at(-1));
        assert(!t.run('labelTargets()').includes('PS04-60')); same(t.run('labelAllTargets()'), ALL);
    });
    await test('actual HTML input/change handlers update range and endpoint text', async () => {
        const t = fixture(); await t.show();
        const from = t.elements['label-from'], to = t.elements['label-to'];
        const dispatch = element => {
            const type = ['input', 'change'].find(name => element.getAttribute('on' + name));
            assert(type, 'actual HTML event attribute required'); element.dispatchEvent({ type });
        };
        from.value = '24'; dispatch(from); await tick(); info(t, 24, 25); checkEndpoint(t, 'label-from-device', 'PS04-95');
        to.value = '24'; dispatch(to); await tick(); info(t, 24, 24); checkEndpoint(t, 'label-to-device', 'PS04-95');
    });
    await test('explicit non-sorted batch preserves caller order rather than re-filtering', async () => {
        const t = fixture(), ordered = ['PS04-96', 'PS04-01', 'PS04-60', 'PS04-95']; await t.show(ordered);
        same(t.run('labelAllTargets()'), ordered); await t.select('2', '3'); same(t.run('labelTargets()'), ordered.slice(1, 3));
        checkEndpoint(t, 'label-from-device', 'PS04-01'); checkEndpoint(t, 'label-to-device', 'PS04-60');
    });
    await test('single from=to retains original absolute position and both endpoints', async () => {
        const t = fixture(); await t.show(); await t.select('24', '24'); info(t, 24, 24); rangeText(t, 24, 24);
        checkEndpoint(t, 'label-from-device', 'PS04-95'); checkEndpoint(t, 'label-to-device', 'PS04-95');
    });
    await test('explicit single device never expands to department/filter batch', async () => {
        const t = fixture(); await t.show(['PS04-95']);
        same(t.run('labelAllTargets()'), ['PS04-95']); same(t.run('labelTargets()'), ['PS04-95']);
        const value = t.run('labelRangeInfo()'); assert.equal(value.total, 1); assert.equal(value.from, 1); assert.equal(value.to, 1);
        assert(t.run('labelRangeText()').includes('PS04-95')); assert.equal(t.elements['label-to'].value, '1');
    });
    await test('showLabels captures caller order, ignores later caller mutation and filter changes', async () => {
        const t = fixture(); t.run('var callerCodes=' + JSON.stringify(ALL) + '; showLabels(callerCodes); callerCodes.reverse();'); await tick();
        await t.select('24', String(ALL.length));
        t.elements['f-q'].value = 'PS04-01'; t.elements['f-line'].value = '不存在车间'; t.elements['f-cat'].value = 'admin'; t.run('taskFilter="open"');
        same(t.run('labelAllTargets()'), ALL); info(t, 24, ALL.length); checkEndpoint(t, 'label-from-device', 'PS04-95');
    });
    await test('navigation/new batch resets 1..N; reset button restores full original snapshot', async () => {
        const t = fixture(); await t.show(); await t.select('24', '24');
        t.run('switchView("list")'); await t.show(ALL.slice(0, 3));
        assert.equal(t.elements['label-from'].value, '1'); assert.equal(t.elements['label-to'].value, '3'); same(t.run('labelTargets()'), ALL.slice(0, 3));
        await t.show(); await t.select('24', '24'); t.run('resetLabelRange()'); await tick(); info(t, 1, ALL.length);
        checkEndpoint(t, 'label-from-device', ALL[0]); checkEndpoint(t, 'label-to-device', ALL.at(-1));
    });
    await test('fallback before first batch still honors original current filters', () => {
        const t = fixture(); t.elements['f-q'].value = 'PS04-95';
        same(t.run('labelAllTargets()'), ['PS04-95']); same(t.run('labelTargets()'), ['PS04-95']);
    });
    const invalid = [['', '25'], ['1', ''], ['0', '25'], ['1', '0'], ['-1', '25'], ['1', '-1'], ['1.5', '25'], ['1', '24.5'], ['1e1', '25'], ['1', '2e1'], ['26', '26'], ['1', '26'], ['25', '24'], ['NaN', '25'], ['Infinity', '25'], ['1x', '25']];
    for (const [from, to] of invalid) await test('invalid [' + from + ', ' + to + '] is never clamped/expanded and all print/export channels are inert', async () => {
        const t = fixture(); await t.show(); await t.sandbox.DtBle.connect(); await t.select(from, to);
        const result = t.run('labelRangeInfo()'); assert.equal(result.ok, false); same(result.codes, []); same(t.run('labelTargets()'), []);
        assert(result.message && String(result.message).trim()); assert(t.elements['label-range-message'].textContent.trim(), 'visible validation explanation');
        assert.equal(t.elements['label-from'].value, from); assert.equal(t.elements['label-to'].value, to);
        const before = t.traffic(); t.run('downloadLabelPngs(); printLabels(); dtPrintLabels()'); await t.sandbox.DtBle.print(); await tick();
        same(t.traffic(), before); same(t.calls.native, []);
    });
    await test('recovering valid input clears validation and updates endpoint devices', async () => {
        const t = fixture(); await t.show(); await t.select('', '25'); await t.select('24', '25'); info(t, 24, 25);
        assert(!t.elements['label-range-message'].classList.contains('label-range-error'), 'old validation error styling cleared');
        assert.equal(t.elements['label-from'].getAttribute('aria-invalid'), 'false');
        assert.equal(t.elements['label-to'].getAttribute('aria-invalid'), 'false');
        assert(!t.elements['label-range-message'].textContent.includes('正整数'), 'old invalid-input explanation cleared');
        checkEndpoint(t, 'label-from-device', 'PS04-95');
    });
    await test('default BLE 1..N sends the entire original batch exactly once in order', async () => {
        const t = fixture(); await t.show(); await t.sandbox.DtBle.connect(); assert.equal(await t.sandbox.DtBle.print(), true);
        same(sentCodes(t), ALL); assert.equal(t.calls.send.length, ALL.length); assert.equal(t.maxActive(), 1);
        assert(t.calls.confirmations[0].includes('第 1–25 张 / 共 25 张')); assert.equal(t.calls.native.length, 0);
    });
    await test('cancelled BLE and USB confirmations send zero labels', async () => {
        const t = fixture({ confirm: false }); await t.show(); await t.select('24', '25'); await t.sandbox.DtBle.connect();
        assert.equal(await t.sandbox.DtBle.print(), false); t.run('dtPrintLabels()'); await tick();
        assert.equal(t.calls.send.length, 0); assert.equal(printCalls(t).length, 0); assert.equal(t.calls.downloads.length, 0); assert.equal(t.calls.browserPrint, 0);
        assert.equal(t.calls.confirmations.length, 2); assert.equal(t.run('dtPrinting'), false);
    });
    await test('BLE serially sends selected snapshot; confirmation includes absolute endpoints', async () => {
        const gates = [deferred(), deferred()], t = fixture({ send: (_, index) => gates[index - 1].promise });
        await t.show(); await t.select('24', '25'); await t.sandbox.DtBle.connect();
        const job = t.sandbox.DtBle.print(); await tick(); assert.equal(t.calls.send.length, 1); same(sentCodes(t), ['PS04-95']);
        const confirmation = t.calls.confirmations[0]; assert(confirmation.includes('2 张')); assert(confirmation.includes('第 24–25 张 / 共 25 张'));
        for (const code of ['PS04-95', 'PS04-96']) { assert(confirmation.includes(code)); assert(confirmation.includes(EQUIPMENT[code].name)); }
        gates[0].resolve({ statusCode: 0 }); await tick(); assert.equal(t.calls.send.length, 2); same(sentCodes(t), ['PS04-95', 'PS04-96']);
        gates[1].resolve({ statusCode: 0 }); assert.equal(await job, true); assert.equal(t.maxActive(), 1);
        assert(t.calls.send.every(item => item.printCopies === 1 && item.orientation === 0)); same(t.calls.native, []);
    });
    await test('BLE locks range while sending; edits after completion affect only next explicit job', async () => {
        const first = deferred(), t = fixture({ send: (_, index) => index === 1 ? first.promise : Promise.resolve({ statusCode: 0 }) });
        await t.show(); await t.select('23', '25'); await t.sandbox.DtBle.connect();
        const job = t.sandbox.DtBle.print(); await tick(); same(sentCodes(t), ['PS04-60']);
        for (const id of ['label-from', 'label-to', 'label-range-reset']) assert.equal(t.elements[id].disabled, true, id + ' locked for active job');
        // A forced script assignment is not a user edit of a disabled native control.
        // Busy events/reset must not change the captured application range or send queue.
        await t.select('1', '1'); t.run('resetLabelRange()'); same(t.run('labelTargets()'), ALL.slice(22));
        await t.sandbox.DtBle.print(); assert.equal(t.calls.send.length, 1, 'no duplicate/reentrant job');
        first.resolve({ statusCode: 0 }); assert.equal(await job, true); await tick(); same(sentCodes(t), ['PS04-60', 'PS04-95', 'PS04-96']);
        assert.equal(t.calls.confirmations.length, 1, 'no queued/automatic continuation');
        for (const id of ['label-from', 'label-to', 'label-range-reset']) assert.equal(t.elements[id].disabled, false, id + ' unlocked after active job');
        await t.select('1', '1'); same(t.run('labelTargets()'), [ALL[0]]);
        assert.equal(await t.sandbox.DtBle.print(), true); same(sentCodes(t), ['PS04-60', 'PS04-95', 'PS04-96', ALL[0]]); assert.equal(t.maxActive(), 1);
        assert(t.calls.confirmations[0].includes('第 23–25 张 / 共 25 张')); assert(t.calls.confirmations[1].includes('第 1–1 张 / 共 25 张'));
    });
    await test('BLE error stops selected range without retry/resume', async () => {
        const t = fixture({ send: () => Promise.resolve({ statusCode: 23, errMsg: 'OFFLINE simulated rejection' }) });
        await t.show(); await t.select('23', '25'); await t.sandbox.DtBle.connect(); assert.equal(await t.sandbox.DtBle.print(), false); await tick();
        same(sentCodes(t), ['PS04-60']); assert.equal(t.calls.open.length, 1); assert.equal(t.run('dtPrinting'), false);
    });
    await test('USB selected range uses actual production draw/rotate/send and absolute confirmation', async () => {
        const t = fixture(); await t.show(); await t.select('24', '25'); t.run('dtPrintLabels()'); await t.flushUsb();
        const sent = printCalls(t); assert.equal(sent.length, 2); same(sent.map(call => new URL(call.url).searchParams.get('jobName')), ['EQ-PS04-95', 'EQ-PS04-96']);
        assert(t.calls.confirmations[0].includes('第 24–25 张 / 共 25 张')); assert(t.calls.confirmations[0].includes(EQUIPMENT['PS04-95'].name));
        assert.equal(t.run('dtPrinting'), false); assert.equal(t.calls.browserPrint, 0); same(t.calls.native, []);
    });
    await test('ZIP export contains only chosen PNG filenames, never previous #23', async () => {
        const t = fixture(); await t.show(); await t.select('24', '25'); t.run('downloadLabelPngs()'); await tick();
        assert.equal(t.calls.downloads.length, 1); assert(t.calls.lastBlob); const bytes = await t.calls.lastBlob.arrayBuffer(); same(zipNames(bytes), ['PS04-95.png', 'PS04-96.png']);
        assert.equal(printCalls(t).length, 0); assert.equal(t.calls.send.length, 0); assert.equal(t.calls.browserPrint, 0);
    });
    await test('browser print honors selected cards and keeps original absolute sequence on screen only', async () => {
        const t = fixture(); await t.show(); await t.select('24', '25'); t.run('printLabels()'); await tick(); assert.equal(t.calls.browserPrint, 1);
        const cards = t.elements['labels-wrap'].innerHTML; assert(cards.includes('PS04-95')); assert(cards.includes('PS04-96')); assert(!cards.includes('PS04-60')); assert(!cards.includes('PS04-01'));
        assert(/第\s*24\s*张/.test(cards) && /第\s*25\s*张/.test(cards), 'page sequence retains absolute #24/#25, not relative #1/#2');
        assert.equal(t.calls.send.length, 0); assert.equal(printCalls(t).length, 0);
    });
    await test('selection/sequence hints never alter PNG text or QR URL payload', async () => {
        const t = fixture(); await t.show(); await t.select('24', '25');
        const before = t.run('drawLabelCanvas("PS04-95").toDataURL("image/png")');
        await t.select('24', '24'); const after = t.run('drawLabelCanvas("PS04-95").toDataURL("image/png")'); assert.equal(after, before);
        const payload = JSON.parse(Buffer.from(after.split(',')[1], 'base64').toString('utf8'));
        assert.equal(payload.qr, 'https://offline.invalid/equipment/?code=PS04-95');
        assert(payload.text.join('').includes(EQUIPMENT['PS04-95'].name)); assert(payload.text.join('').includes('PS04-95'));
        assert(!/第\s*\d+\s*张|共\s*\d+\s*张|24[–-]25/.test(payload.text.join(''))); assert(!payload.qr.includes('from=') && !payload.qr.includes('to='));
    });
    console.log('\nLabel range: ' + passed + ' passed / ' + failed + ' failed (OFFLINE; no real hardware/network)');
    if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
