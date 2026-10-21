/* 统一登录态存储
 *
 * 为什么不用 sessionStorage:
 *   sessionStorage 只在"当前页面实例"里活着。手机端 WebView(企业微信/微信内置浏览器、
 *   iOS 的 WKWebView)在切回聊天、被系统回收时会销毁实例,登录态随之丢失 —— 表现为
 *   "刚登录过,再打开又要登录"。
 *
 * 做法:
 *   - 主存 localStorage(跨会话保留),同时镜像一份到 sessionStorage 兜底
 *   - 30 天过期,与服务端 sessions.exp 对齐;过期自动清除
 *   - localStorage 被禁用(隐私模式/配额满)时自动退回 sessionStorage
 */
(function (w) {
    var KEY = 'roi_session';
    var AT = 'roi_session_at';
    var TTL = 30 * 24 * 3600 * 1000;   // 30 天

    function lsGet(k) { try { return w.localStorage.getItem(k); } catch (e) { return null; } }
    function ssGet(k) { try { return w.sessionStorage.getItem(k); } catch (e) { return null; } }

    w.SessionStore = {
        // 返回原始 JSON 字符串(与原来的 getItem 行为一致,调用方照旧 JSON.parse)
        raw: function () {
            var s = lsGet(KEY) || ssGet(KEY);
            if (!s) return null;
            var at = parseInt(lsGet(AT) || '0', 10);
            if (at && (Date.now() - at) > TTL) {
                w.SessionStore.clear();
                return null;
            }
            return s;
        },
        write: function (s) {
            if (!s) return;
            try {
                w.localStorage.setItem(KEY, s);
                w.localStorage.setItem(AT, String(Date.now()));
            } catch (e) { }
            try { w.sessionStorage.setItem(KEY, s); } catch (e) { }
        },
        clear: function () {
            try {
                w.localStorage.removeItem(KEY);
                w.localStorage.removeItem(AT);
            } catch (e) { }
            try { w.sessionStorage.removeItem(KEY); } catch (e) { }
        },
        // 登录时间戳(毫秒),用于界面上提示"登录已 7 天"这类信息
        savedAt: function () {
            var at = parseInt(lsGet(AT) || '0', 10);
            return at || 0;
        }
    };
})(window);
