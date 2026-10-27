/* 德佟官方 lpapi-ble 的 Web Bluetooth 接入。仅用户点击连接后才申请蓝牙权限。
 * 不依赖 dtpweb/USB；不猜测 GATT 指令；不自动连接、自动试打或失败重打。
 */
var DtBle = (function () {
    'use strict';
    var SDK_URL = './js/lpapi-ble-1.8.261015.umd.js'; // 固定版本，不覆盖同名文件
    var SDK_SRI = 'sha256-aOiGxCf0Obzq3dowlR9lAXiuj/iKs7SqST0OX5DlHbM=';
    var loading = null, api = null, device = null, phase = 'idle';
    var printing = false, stopped = false, connected = false;
    var message = '', sequence = 0, quarantined = false;

    function el(id) { return document.getElementById(id); }
    function supported() {
        return typeof window !== 'undefined' && window.isSecureContext === true
            && typeof navigator !== 'undefined' && !!navigator.bluetooth
            && typeof navigator.bluetooth.requestDevice === 'function';
    }
    function toast(s) { if (typeof showToast === 'function') showToast(s); }
    function locked() { return quarantined || printing || phase === 'connecting' || (typeof dtPrinting !== 'undefined' && dtPrinting); }
    function readyApi() { return window.LPAPI && window.LPAPI.LPAPI; }
    function draw() {
        var b = el('dt-ble-connect'), p = el('dt-ble-print'), test = el('dt-ble-test'), s = el('dt-ble-status'), stop = el('dt-ble-stop');
        var support = supported();
        if (b) {
            b.style.display = support ? '' : 'none';
            b.disabled = quarantined || phase === 'loading' || phase === 'connecting' || printing;
            b.textContent = phase === 'loading' ? '蓝牙组件加载中…' : (phase === 'connecting' ? '正在连接蓝牙…' : (connected ? '断开蓝牙' : '连接蓝牙打印机'));
        }
        if (p) { p.style.display = connected ? '' : 'none'; p.disabled = locked(); }
        if (test) { test.style.display = connected ? '' : 'none'; test.disabled = locked(); }
        if (stop) { stop.style.display = printing ? '' : 'none'; stop.disabled = stopped; }
        if (s) s.textContent = support
            ? (message || '蓝牙无需 USB；点连接后在浏览器中选择 DT353。')
            : '此浏览器不支持网页蓝牙：请用电脑 Chrome/Edge 或 Android Chrome；也可继续 USB 打印或下载图片。';
    }
    function setMessage(s) { message = s; draw(); }
    function prepare() {
        draw();
        if (!supported()) return Promise.resolve(false);
        if (readyApi()) { if (phase === 'idle' || phase === 'error') phase = 'ready'; draw(); return Promise.resolve(true); }
        if (loading) return loading;
        phase = 'loading'; draw();
        loading = new Promise(function (resolve, reject) {
            var script = document.createElement('script');
            var timer = setTimeout(function () { fail(); }, 15000);
            var done = false;
            function fail() {
                if (done) return; done = true; clearTimeout(timer);
                if (script.parentNode) script.parentNode.removeChild(script);
                reject(new Error('蓝牙组件加载失败，请检查网络后点连接重试'));
            }
            script.src = SDK_URL; script.integrity = SDK_SRI; script.async = true;
            script.onload = function () {
                if (done) return;
                if (!readyApi()) { fail(); return; }
                done = true; clearTimeout(timer); resolve(true);
            };
            script.onerror = fail;
            document.head.appendChild(script);
        }).then(function () {
            phase = 'ready'; message = ''; draw(); return true;
        }, function (e) {
            loading = null; phase = 'error'; setMessage(e.message); return false;
        });
        return loading;
    }
    function responseError(r, fallback) {
        return new Error((r && (r.errMsg || r.codeName)) || fallback + '（代码 ' + (r && r.statusCode) + '）');
    }
    function check(r, fallback) { if (!r || r.statusCode !== 0) throw responseError(r, fallback); return r; }
    function safeStop() { try { if (api) api.stopPrint(); } catch (e) { /* 断开后仍释放页面状态 */ } }
    function drop(d) { try { if (d && d.gattDevice && d.gattDevice.gatt) d.gattDevice.gatt.disconnect(); } catch (e) { } }
    function forget() { connected = false; device = null; }
    // 未结束的底层操作与下一次连接不能共用 SDK/GATT：超时后隔离，直到旧操作真正结束。
    function quarantine(pending, selected) {
        quarantined = true; draw();
        function settled() {
            drop(selected); api = null; quarantined = false;
            phase = 'ready'; setMessage('上次蓝牙操作已结束，请重新连接；实际出纸请先核对。');
        }
        Promise.resolve(pending).then(settled, settled);
    }
    function deadline(promise, ms, onTimeout) {
        return new Promise(function (resolve, reject) {
            var done = false;
            var timer = setTimeout(function () {
                if (done) return; done = true;
                onTimeout(); reject(new Error('蓝牙响应超时，请检查实物；不会自动重试'));
            }, ms);
            Promise.resolve(promise).then(function (r) {
                if (done) return;
                done = true; clearTimeout(timer); resolve(r);
            }, function (e) {
                if (done) return;
                done = true; clearTimeout(timer); reject(e);
            });
        });
    }
    // 不调用 SDK closePrinter：官方说明它可能提交尚未完成的打印数据。
    function disconnect() {
        if (locked()) { toast('打印或连接尚未结束，请先停止并等待结果'); return; }
        sequence++;
        var d = device; forget(); phase = 'ready';
        drop(d);
        setMessage('蓝牙已断开；需要打印时请重新连接。');
    }
    function connect() {
        if (!supported()) { draw(); return Promise.resolve(false); }
        if (locked()) { toast('打印或连接中，请稍候'); return Promise.resolve(false); }
        if (connected) { disconnect(); return Promise.resolve(false); }
        if (!readyApi()) {
            // 组件未就绪时只加载；不在异步回调中打开设备选择框（必须保留用户手势）。
            return prepare().then(function (ok) { if (ok) setMessage('蓝牙组件已就绪，请再点一次“连接蓝牙打印机”。'); return false; });
        }
        var attempt = ++sequence;
        try {
            if (!api) api = readyApi().getInstance({ webBLE: true, webHID: false, models: 'DT-353', bleFilters: 'DT', logLevel: 0 });
            phase = 'connecting'; setMessage('请在浏览器设备选择框中选择 DT353；连接不会出纸。');
            // requestDevice 才保证打开选择框；startDiscovery 可能只返回已授权设备。
            var selected = null;
            var choice = api.requestDevice({ webBLE: true, webHID: false, bleFilters: 'DT',
                deviceFound: function (items) { selected = items && items[0]; } });
            return Promise.resolve(choice).then(function (r) {
                check(r, '蓝牙设备选择失败');
                // resultInfo 含所有缓存设备，取消时也可能仍有旧设备；只认本次 deviceFound。
                if (!selected) { phase = 'ready'; setMessage('已取消选择，未连接、未打印。'); return false; }
                if (!/^DT[- ]?353(?:[- _]|$)/i.test(selected.name || '')) throw new Error('请选择 DT353 标签机，不支持的型号不会发送打印数据');
                device = selected;
                if (!selected.deviceId) throw new Error('未取得蓝牙设备标识，已停止');
                var opening = api.openPrinter({
                    deviceId: selected.deviceId, type: selected.type, autoScan: false,
                    webBLE: true, webHID: false,
                    connectionStateChange: function (state) {
                        if (attempt !== sequence || state.connected !== false) return;
                        connected = false; stopped = true;
                        if (printing) safeStop();
                        setMessage('蓝牙连接已断开；本批已停止，不会自动重连或重打。');
                    }
                });
                return deadline(opening, 25000, function () { quarantine(opening, selected); drop(selected); }).then(function (opened) {
                    check(opened, '蓝牙连接失败');
                    if (attempt !== sequence) return false;
                    var info = api.getPrinterInfo() || {};
                    if (info.deviceId !== selected.deviceId) throw new Error('连接到的蓝牙设备与所选设备不一致，已停止');
                    connected = !!api.isConnected();
                    if (!connected) throw new Error('打印机未建立有效连接，请检查是否被其他软件占用');
                    phase = 'connected';
                    setMessage('蓝牙已连接：' + (selected.name || 'DT353') + ' · ' + (info.printerDPI || '?') + 'dpi；请先试打 1 张。');
                    return true;
                });
            }).catch(function (e) {
                drop(device); forget(); phase = 'error';
                setMessage('蓝牙未连接：' + (e && e.message || e) + (quarantined ? '。上次连接仍在结束中，请等待或刷新页面，暂不允许重连。' : '。若列表为空，请断开其他软件连接；系统已配对不代表支持 BLE。'));
                return false;
            });
        } catch (e) {
            drop(device); forget(); phase = 'error'; setMessage('蓝牙连接失败：' + (e && e.message || e)); return Promise.resolve(false);
        }
    }
    // 沿用 300dpi 横版和顺时针90°方向。打印头窄于40mm时只裁掉两侧纯白边，绝不缩放二维码或裁掉墨迹。
    function raster(code, info) {
        if (Number(info.printerDPI) !== LABEL_DPI) throw new Error('当前标签为 ' + LABEL_DPI + 'dpi，打印机报告 ' + (info.printerDPI || '未知') + 'dpi，已停止以免尺寸失真');
        var width = Number(info.printerWidth);
        if (!isFinite(width) || width < 1 || Math.floor(width) !== width) throw new Error('未读取到打印头宽度，已停止');
        var cv = dtRotateCanvas(drawLabelCanvas(code));
        var ctx = cv.getContext('2d'), image = ctx.getImageData(0, 0, cv.width, cv.height);
        if (width >= cv.width) return image;
        var left = Math.floor((cv.width - width) / 2), right = left + width;
        for (var y = 0; y < image.height; y++) {
            for (var x = 0; x < image.width; x++) {
                if (x >= left && x < right) continue;
                var i = (y * image.width + x) * 4;
                if (image.data[i + 3] && (image.data[i] < 192 || image.data[i + 1] < 192 || image.data[i + 2] < 192)) {
                    throw new Error('内容超出打印头，已停止以免裁掉文字或二维码；请使用图片下载检查标签');
                }
            }
        }
        return ctx.getImageData(left, 0, width, cv.height);
    }
    function stop() {
        if (!printing) return;
        stopped = true;
        safeStop();
        setMessage('已请求停止；已发送的标签仍可能出纸，未发送的不会继续。请勿立即重复打印。');
    }
    function print(testOnly) {
        if (locked()) { toast('正在打印或连接，请稍候'); return Promise.resolve(false); }
        if (!connected || !api || !api.isConnected()) { forget(); draw(); toast('请先连接蓝牙打印机'); return Promise.resolve(false); }
        var codes = labelTargets().slice();
        if (!codes.length) { toast('当前标签页没有设备'); return Promise.resolve(false); }
        if (testOnly) codes = codes.slice(0, 1);
        var scope = labelScope;
        var name = (device || {}).name || 'DT353';
        if (!confirm('将通过蓝牙' + (testOnly ? '试打' : '打印') + ' ' + codes.length + ' 张到「' + name + '」\n'
            + (scope ? ('范围：' + scope + '\n') : '') + (testOnly ? ('本次仅打印：' + codes[0] + '\n') : '')
            + '横版60×40mm（送纸40×60），不弹系统打印框。\n失败不会自动重打；继续吗？')) return Promise.resolve(false);
        printing = true; dtPrinting = true; stopped = false; phase = 'printing'; draw();
        var sent = 0, current = '', attempting = false;
        return loadLib('qr', './js/qrcode.min.js').then(function () {
            function next() {
                if (stopped) return false;
                if (sent >= codes.length) return true;
                if (!connected || !api.isConnected()) throw new Error('蓝牙已断开');
                current = codes[sent];
                setMessage('蓝牙发送 ' + (sent + 1) + '/' + codes.length + ' · ' + current);
                var image = raster(current, api.getPrinterInfo() || {});
                attempting = true;
                var selectedDevice = device;
                var sending = api.printImageData({ imageData: image, orientation: 0, printCopies: 1,
                    threshold: 192, gapType: 255, printDarkness: 255, printSpeed: 255 });
                return deadline(sending, 60000, function () {
                    stopped = true; quarantine(sending, selectedDevice); safeStop(); drop(device); forget();
                }).then(function (r) {
                    check(r, '标签发送失败');
                    attempting = false; sent++;
                    return next();
                });
            }
            return next();
        }).then(function (completed) {
            if (completed) setMessage('已发送 ' + sent + ' 张到蓝牙打印机；请检查实际出纸（发送成功不等于出纸成功）。');
            else setMessage('本批已停止，已确认发送 ' + sent + ' 张；当前标签可能已出纸，请核对后再操作。');
            return completed;
        }).catch(function (e) {
            stopped = true;
            safeStop();
            setMessage('蓝牙打印已停止：' + (e && e.message || e) + '；已确认发送 ' + sent + ' 张。'
                + (attempting ? ('当前 ' + current + ' 可能已出纸，请核对，勿直接重打。') : '未自动重打。'));
            return false;
        }).then(function (result) {
            printing = false; dtPrinting = false; phase = connected ? 'connected' : 'ready'; draw(); return result;
        });
    }
    return { prepare: prepare, connect: connect, disconnect: disconnect, print: print,
        stop: stop, supported: supported, isBusy: locked, raster: raster };
}());
