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
        var text = (r && (r.errMsg || r.codeName)) || fallback;
        // 厂商的通用 errMsg 会遮住状态码及 resultInfo 中的浏览器异常，诊断时必须保留。
        if (r && typeof r.statusCode === 'number') text += '（SDK ' + r.statusCode + (r.codeName ? ' / ' + r.codeName : '') + '）';
        var info = r && r.resultInfo, detail = '';
        if (typeof info === 'string') detail = info;
        else if (info && typeof info === 'object') {
            detail = [info.name, info.message || info.errMsg].filter(function (v) { return typeof v === 'string'; }).join(': ');
        }
        if (detail && text.indexOf(detail) < 0) text += '：' + detail.slice(0, 240);
        return new Error(text);
    }
    function check(r, fallback) { if (!r || r.statusCode !== 0) throw responseError(r, fallback); return r; }
    // SDK 把原生 GATT 异常转成通用代码4，只通过公开 logger 输出原异常。
    // 临时监听本次连接的警告并原样恢复 logger；不改厂商文件、不包装 GATT、不额外连接。
    function connectionDiagnostics() {
        var logger = window.LPAPI && window.LPAPI.logger, nativeError = '', closed = false;
        var previousOutput, previousLevel, capture, level;
        function close() {
            if (closed) return; closed = true;
            if (!capture) return;
            if (logger.output === capture) logger.setLogOutput(previousOutput);
            if (logger.logLevel === level) logger.setLevel(previousLevel);
        }
        if (logger && typeof logger.setLogOutput === 'function' && typeof logger.setLevel === 'function') {
            previousOutput = logger.output; previousLevel = logger.logLevel;
            level = Math.max(Number(previousLevel) || 0, 2);
            capture = {};
            ['log', 'warn', 'error'].forEach(function (kind) {
                capture[kind] = function () {
                    var args = Array.prototype.slice.call(arguments);
                    if (!closed && kind === 'warn' && typeof args[0] === 'string' && args[0].indexOf('device.gatt.connect:') >= 0) {
                        args.slice(1).some(function (e) {
                            if (!e || typeof e.message !== 'string') return false;
                            nativeError = (typeof e.name === 'string' ? e.name + ': ' : '') + e.message.slice(0, 240);
                            return true;
                        });
                    }
                    var threshold = kind === 'log' ? 4 : (kind === 'warn' ? 2 : 1);
                    var out = previousOutput || (typeof console !== 'undefined' ? console : null);
                    if (previousLevel >= threshold && out && typeof out[kind] === 'function') out[kind].apply(out, args);
                };
            });
            logger.setLogOutput(capture); logger.setLevel(level);
        }
        return { close: close, detail: function () { return nativeError; } };
    }
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
        var attempt = ++sequence, connectStage = '设备选择', diagnostics = null;
        function connectError(e) {
            var nativeDetail = diagnostics ? diagnostics.detail() : '';
            if (diagnostics) diagnostics.close();
            drop(device); forget(); phase = 'error';
            var reason = String(e && e.message || e);
            if (nativeDetail && reason.indexOf(nativeDetail) < 0) reason += '；浏览器：' + nativeDetail;
            var prefix = selected ? ('已选择 ' + selected.name + '，但打印连接未建立。失败阶段：' + connectStage + '；') : '蓝牙未连接：';
            var help = quarantined ? '上次连接仍在结束中，请等待或刷新页面，暂不允许重连。'
                : '请关闭其他标签软件、手机 App 或其他网页对这台打印机的连接，再重试连接。';
            setMessage(prefix + reason + '。' + help + '本次未发送标签，不会自动打印。');
            return false;
        }
        try {
            if (!api) api = readyApi().getInstance({ webBLE: true, webHID: false, models: 'DT-353', bleFilters: 'DT', logLevel: 0 });
            phase = 'connecting'; setMessage('请点选 DT353 那一行，再点右下角“配对”；“已配对”只表示配对记录，不代表网页已连接。连接不会出纸。');
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
                connectStage = '建立蓝牙连接/读取打印服务';
                setMessage('已选择 ' + selected.name + '；正在建立打印连接。“已配对”不等于已连接，请等待结果；不会出纸。');
                diagnostics = connectionDiagnostics();
                var opening = api.openPrinter({
                    deviceId: selected.deviceId, type: selected.type, autoScan: false,
                    webBLE: true, webHID: false, tryTimes: 1, // 每次点击仅连接一次；不执行 SDK 默认的五次重试
                    connectionStateChange: function (state) {
                        if (attempt !== sequence || state.connected !== false) return;
                        connected = false; stopped = true;
                        if (printing) safeStop();
                        setMessage('蓝牙连接已断开；本批已停止，不会自动重连或重打。');
                    }
                });
                return deadline(opening, 25000, function () { quarantine(opening, selected); drop(selected); }).then(function (opened) {
                    diagnostics.close();
                    check(opened, '蓝牙连接失败');
                    if (attempt !== sequence) return false;
                    connectStage = '校验打印机连接';
                    var info = api.getPrinterInfo() || {};
                    if (info.deviceId !== selected.deviceId) throw new Error('连接到的蓝牙设备与所选设备不一致，已停止');
                    connected = !!api.isConnected();
                    if (!connected) throw new Error('打印机未建立有效连接，请检查是否被其他软件占用');
                    phase = 'connected';
                    setMessage('蓝牙已连接：' + (selected.name || 'DT353') + ' · ' + (info.printerDPI || '?') + 'dpi；请先试打 1 张。');
                    return true;
                });
            }).catch(connectError);
        } catch (e) {
            return Promise.resolve(connectError(e));
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
