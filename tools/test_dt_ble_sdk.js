/* Real vendored SDK + page adapter regression. OFFLINE ONLY: native Bluetooth/GATT are fake.
 * No SDK methods are replaced. No browser, network, physical adapter, printing or real writes.
 * Run: node tools/test_dt_ble_sdk.js
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const SDK_BYTES = fs.readFileSync(path.join(ROOT, 'docs/equipment/js/lpapi-ble-1.8.261015.umd.js'));
const ADAPTER = fs.readFileSync(path.join(ROOT, 'docs/equipment/js/dt-ble.js'), 'utf8');
let passed = 0;
function ok(name, condition) { assert.ok(condition, name); passed++; }

function fixture(options = {}) {
    const elements = {}, timers = new Set(), logs = [], calls = { choose: [], connect: 0, disconnect: 0, services: 0, writes: 0 };
    const nativeError = new DOMException('OFFLINE AUDIT: mock GATT connection refused', 'NetworkError');
    let priorOutput, priorLevel;
    const gatt = {
        connected: false,
        async connect() { calls.connect++; throw nativeError; },
        disconnect() { calls.disconnect++; this.connected = false; },
        async getPrimaryServices() { calls.services++; throw new Error('Unexpected GATT service discovery'); },
        async getPrimaryService() { calls.services++; throw new Error('Unexpected GATT service access'); },
        async writeValueWithoutResponse() { calls.writes++; throw new Error('Unexpected write'); }
    };
    const device = {
        id: options.missingId ? '' : 'offline-authorized-device',
        name: options.name || 'DT-353-C60890706', gatt,
        addEventListener() {}, removeEventListener() {}
    };
    const quietConsole = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(level => [level, (...args) => logs.push({ level, args })]));
    const bluetooth = {
        async requestDevice(request) {
            calls.choose.push(request);
            // getInstance resets SDK logLevel before invoking the native chooser. Establish
            // an exact pre-capture state here without replacing or wrapping any SDK method.
            if (options.customLogger) {
                sandbox.LPAPI.logger.setLogOutput(quietConsole);
                sandbox.LPAPI.logger.setLevel(options.loggerLevel === undefined ? 3 : options.loggerLevel);
            }
            priorOutput = sandbox.LPAPI.logger.output;
            priorLevel = sandbox.LPAPI.logger.logLevel;
            if (options.chooserError) throw new DOMException('OFFLINE AUDIT: chooser refused', options.chooserError);
            return device;
        },
        async getDevices() { throw new Error('Unexpected getDevices: no silent discovery is allowed'); }
    };
    const sandbox = {
        console: quietConsole, navigator: { userAgent: 'OfflineAudit Chrome/123', bluetooth },
        isSecureContext: true, addEventListener() {}, removeEventListener() {},
        setTimeout(fn, ms, ...args) {
            const timer = setTimeout(() => { timers.delete(timer); fn(...args); }, ms);
            timers.add(timer); return timer;
        },
        clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
        TextEncoder, TextDecoder, Uint8Array, Uint8ClampedArray, ArrayBuffer, DataView, DOMException,
        document: {
            getElementById(id) { return elements[id] || (elements[id] = { style: {}, textContent: '', disabled: false }); },
            createElement(tag) {
                if (tag !== 'canvas') throw new Error('Network/script injection is forbidden in offline test');
                return { getContext() { return {}; } };
            }
        },
        dtPrinting: false,
        confirm() { throw new Error('Printing is forbidden in connection tests'); },
        fetch() { throw new Error('Network access is forbidden in offline test'); }
    };
    sandbox.window = sandbox; sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SDK_BYTES.toString('utf8'), sandbox, { filename: 'lpapi-ble-1.8.261015.umd.js' });
    vm.runInContext(ADAPTER, sandbox, { filename: 'dt-ble.js' });
    return {
        sandbox, calls, logs, device, nativeError,
        status() { return elements['dt-ble-status'].textContent; },
        checkNoHardwareWork() { ok('no service discovery or writes after failed selection/connection', calls.services === 0 && calls.writes === 0); },
        checkLoggerRestored() {
            ok('exact SDK logger output restored', sandbox.LPAPI.logger.output === priorOutput);
            ok('exact SDK logger level restored', sandbox.LPAPI.logger.logLevel === priorLevel);
        },
        close() { for (const timer of timers) clearTimeout(timer); timers.clear(); }
    };
}
async function withFixture(options, run) {
    const test = fixture(options);
    try { await run(test); } finally { test.close(); }
}
async function main() {
    ok('vendor SDK hash remains the pinned upstream bytes', crypto.createHash('sha256').update(SDK_BYTES).digest('hex') === '68e886c427f439bceaddda30951f650178ae8ff88ab3b4aa493d0e5f90e51db3');
    await withFixture({}, async t => {
        const result = await t.sandbox.DtBle.connect();
        ok('real SDK GATT failure returns false to page', result === false);
        ok('one explicit chooser, no automatic scans', t.calls.choose.length === 1);
        ok('tryTimes:1 results in exactly one native GATT attempt', t.calls.connect === 1);
        const request = t.calls.choose[0];
        ok('real SDK chooser filters DT names', request.filters.length === 1 && request.filters[0].namePrefix === 'DT');
        ok('real SDK supplies its four permitted services', request.optionalServices.length === 4 && request.optionalServices.includes('0000ff00-0000-1000-8000-00805f9b34fb'));
        ok('page retains SDK error code and name', /SDK\s*4/.test(t.status()) && t.status().includes('ERROR_CONNECT_FAILED'));
        ok('page exposes original native error despite SDK generic wrapper', t.status().includes('NetworkError') && t.status().includes(t.nativeError.message));
        ok('page identifies selected printer and connection failure stage', t.status().includes(t.device.name) && t.status().includes('失败阶段'));
        ok('no misleading empty-list advice after a device was selected', !t.status().includes('若列表为空'));
        t.checkLoggerRestored(); t.checkNoHardwareWork();
    });
    for (const loggerLevel of [0, 3, 4]) await withFixture({ customLogger: true, loggerLevel }, async t => {
        await t.sandbox.DtBle.connect();
        ok('custom logger also captures native GATT diagnostic at prior level ' + loggerLevel, t.status().includes('NetworkError'));
        t.checkLoggerRestored(); t.checkNoHardwareWork();
    });
    for (const chooserError of ['NotFoundError', 'SecurityError']) await withFixture({ chooserError }, async t => {
        await t.sandbox.DtBle.connect();
        ok(chooserError + ' chooser rejection never opens GATT', t.calls.connect === 0);
        ok(chooserError + ' chooser rejection leaves no SDK active connection', !t.sandbox.LPAPI.LPAPI.getInstance().isConnected());
        t.checkLoggerRestored(); t.checkNoHardwareWork();
    });
    const cachedChoice = {};
    await withFixture(cachedChoice, async t => {
        await t.sandbox.DtBle.connect();
        cachedChoice.chooserError = 'NotFoundError';
        await t.sandbox.DtBle.connect();
        ok('cancelling after a cached failed selection never reopens old GATT', t.calls.choose.length === 2 && t.calls.connect === 1);
        ok('cached cancellation remains cancellation in UI', t.status().includes('已取消选择'));
        t.checkLoggerRestored(); t.checkNoHardwareWork();
    });
    await withFixture({ name: 'DT-999-OTHER' }, async t => {
        await t.sandbox.DtBle.connect();
        ok('wrong model rejected before native GATT connection', t.calls.connect === 0);
        ok('wrong model gives explicit model refusal', t.status().includes('请选择 DT353'));
        t.checkLoggerRestored(); t.checkNoHardwareWork();
    });
    await withFixture({ missingId: true }, async t => {
        await t.sandbox.DtBle.connect();
        ok('missing browser authorization id rejected before GATT', t.calls.connect === 0);
        ok('missing id refusal is explicit', t.status().includes('未取得蓝牙设备标识'));
        t.checkNoHardwareWork();
    });
    await withFixture({}, async t => {
        const sdk = t.sandbox.LPAPI.LPAPI.getInstance({ webBLE: true, webHID: false, models: 'DT-353', bleFilters: 'DT', logLevel: 0 });
        let selected;
        await sdk.requestDevice({ webBLE: true, webHID: false, bleFilters: 'DT', deviceFound(items) { selected = items[0]; } });
        ok('real SDK callback preserves exact native device identity', selected.gattDevice === t.device && selected.type === 100);
        const result = await sdk.openPrinter({ deviceId: 'not-authorized-or-cached', type: selected.type, autoScan: false, webBLE: true, webHID: false, tryTimes: 1 });
        ok('unknown id + autoScan:false fails as ERROR_NO_PRINTER, not generic GATT code4', result.statusCode === 2 && result.codeName === 'ERROR_NO_PRINTER');
        ok('unknown id triggers neither scan nor native GATT', t.calls.choose.length === 1 && t.calls.connect === 0);
        t.checkNoHardwareWork();
    });
    console.log('Real SDK offline regression: ' + passed + ' passed / 0 failed (no hardware/network)');
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
