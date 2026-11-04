/* Durable report intentions only. No session/token, network, login or retry logic.
 * Every intention has its own key, so creating another fault never replaces an
 * unknown result (including multiple simultaneous faults on a GEN card).
 * localStorage is preferred; sessionStorage is a refresh-surviving fallback.
 * A returned create/mark has been written AND read back. No memory fallback.
 */
(function (root, factory) {
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && root.window === root) root.EquipReportIntent = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
    'use strict';
    var PREFIX = 'equip_report_intent_v1:';
    function fail(code, message) { var e = new Error(message); e.code = code; throw e; }
    function validateId(id) {
        return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    }
    function accountName(account) {
        if (typeof account !== 'string' || !account.trim()) fail('INVALID_ARGUMENT', '缺少报修账号');
        return account; // Account identity is exact, never lowercased or guessed from a session.
    }
    function idName(id) {
        if (!validateId(id)) fail('INVALID_ID', '报修请求编号无效');
        return id.toLowerCase();
    }
    function codeName(code) {
        if (typeof code !== 'string' || !code.trim()) fail('INVALID_ARGUMENT', '缺少设备编号');
        return code; // Exact code: whitespace must never redirect a report to another device.
    }
    function payloadValue(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('INVALID_ARGUMENT', '报修内容无效');
        var out = {};
        ['symptom', 'place', 'reportBy'].forEach(function (key) {
            if (payload[key] != null && typeof payload[key] !== 'string') fail('INVALID_ARGUMENT', '报修字段必须是文本');
            out[key] = (payload[key] || '').trim();
        });
        if (!out.symptom || !out.place) fail('INVALID_ARGUMENT', '请填写故障现象和设备位置');
        return out;
    }
    function copy(value) { return JSON.parse(JSON.stringify(value)); }
    function prefix(account) { return PREFIX + encodeURIComponent(account) + ':'; }
    function keyFor(account, id) { return prefix(account) + id; }
    function stores() {
        var out = { available: [], failed: 0 };
        ['localStorage', 'sessionStorage'].forEach(function (name) {
            try {
                var store = root[name];
                if (!store) { out.failed++; return; }
                if (out.available.indexOf(store) < 0) out.available.push(store);
            } catch (e) { out.failed++; }
        });
        return out;
    }
    function identity(it) {
        return JSON.stringify([it.requestId, it.account, it.code, it.payload.symptom, it.payload.place, it.payload.reportBy, it.createdAt]);
    }
    function decode(raw, account, id) {
        var it;
        try { it = JSON.parse(raw); } catch (e) { fail('INTENT_CORRUPT', '已保存的报修意图损坏，请勿直接另报'); }
        if (!it || it.account !== account || it.requestId !== id || !validateId(it.requestId)
            || typeof it.code !== 'string' || !it.code.trim() || !it.payload || typeof it.payload !== 'object'
            || Array.isArray(it.payload) || Object.keys(it.payload).sort().join(',') !== 'place,reportBy,symptom'
            || ['symptom', 'place', 'reportBy'].some(function (k) { return typeof it.payload[k] !== 'string'; })
            || !it.payload.symptom.trim() || !it.payload.place.trim() || typeof it.createdAt !== 'string'
            || !it.createdAt || (it.state !== 'pending' && it.state !== 'uncertain')) {
            fail('INTENT_CORRUPT', '已保存的报修意图无效，请勿直接另报');
        }
        // Do not pass through injected/session fields such as token, even if another
        // script corrupted a key. Only the documented intention shape leaves here.
        return { requestId: it.requestId, account: it.account, code: it.code,
            payload: { symptom: it.payload.symptom, place: it.payload.place, reportBy: it.payload.reportBy },
            createdAt: it.createdAt, state: it.state };
    }
    function merge(found, item) {
        if (!found) return item;
        if (identity(found) !== identity(item)) fail('INTENT_CONFLICT', '同一报修编号存在不同内容，请保留原报修并联系管理员');
        // If a partial update left two copies, never downgrade an unknown outcome.
        if (item.state === 'uncertain') found.state = 'uncertain';
        return found;
    }
    function locate(account, id) {
        var found = null, locations = [], readable = 0, sources = stores(), failed = sources.failed;
        sources.available.forEach(function (store) {
            var raw;
            try { raw = store.getItem(keyFor(account, id)); readable++; } catch (e) { failed++; return; }
            if (raw !== null) { found = merge(found, decode(raw, account, id)); locations.push(store); }
        });
        // An unreadable store is NOT evidence that an unknown submission is absent.
        // A readable mirror is enough to recover/retry that exact original ID.
        if (!readable || (failed && !found)) fail('STORAGE_UNAVAILABLE', '无法完整读取报修意图，请勿另报新故障');
        return { item: found, locations: locations };
    }
    function collect(account) {
        var items = Object.create(null), readable = 0, sources = stores(), failed = sources.failed, ownPrefix = prefix(account);
        sources.available.forEach(function (store) {
            var keys = [];
            try {
                for (var i = 0, n = store.length; i < n; i++) {
                    var key = store.key(i);
                    if (typeof key === 'string' && key.indexOf(ownPrefix) === 0) keys.push(key);
                }
                readable++;
            } catch (e) { failed++; }
            keys.forEach(function (key) {
                var raw;
                try { raw = store.getItem(key); } catch (e) { failed++; return; }
                if (raw === null) return;
                var id = key.slice(ownPrefix.length), it = decode(raw, account, id);
                items[id] = merge(items[id], it);
            });
        });
        return { items: items, readable: readable, failed: failed };
    }
    function writeConfirmed(store, key, raw) {
        try { store.setItem(key, raw); return store.getItem(key) === raw; } catch (e) { return false; }
    }
    function secureUuid() {
        var crypto;
        try { crypto = root.crypto || root.msCrypto; } catch (e) { }
        if (crypto && typeof crypto.randomUUID === 'function') {
            var id;
            try { id = crypto.randomUUID(); } catch (e) { }
            if (typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return id.toLowerCase();
        }
        if (crypto && typeof crypto.getRandomValues === 'function') {
            var bytes = new Uint8Array(16);
            try { crypto.getRandomValues(bytes); } catch (e) { fail('CRYPTO_UNAVAILABLE', '无法安全生成报修请求编号，请勿发送报修'); }
            bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
            var hex = Array.prototype.map.call(bytes, function (n) { return ('0' + n.toString(16)).slice(-2); }).join('');
            return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
        }
        fail('CRYPTO_UNAVAILABLE', '无法安全生成报修请求编号，请勿发送报修');
    }
    return {
        validateId: validateId,
        create: function (account, code, payload) {
            account = accountName(account); code = codeName(code); payload = payloadValue(payload);
            // New IDs are forbidden while either store's older unknown intentions
            // cannot be inspected; otherwise a temporary read fault could hide one.
            var existing = collect(account);
            if (!existing.readable || existing.failed) fail('STORAGE_UNAVAILABLE', '无法完整读取已有报修意图，请勿另报新故障');
            var id = secureUuid(), key = keyFor(account, id);
            // Even a broken/mock crypto source cannot overwrite an older unknown intent.
            if (locate(account, id).item) fail('ID_COLLISION', '报修请求编号重复，未覆盖原报修');
            var item = { requestId: id, account: account, code: code, payload: payload,
                createdAt: new Date().toISOString(), state: 'pending' };
            var raw = JSON.stringify(item), available = stores().available, confirmed = 0;
            // Mirror the SAME ID/payload wherever writes work. A quota failure in one
            // readable store may fall back to the other; never create another ID.
            available.forEach(function (store) { if (writeConfirmed(store, key, raw)) confirmed++; });
            if (!confirmed) fail('STORAGE_UNAVAILABLE', '无法保存并确认报修意图，请勿发送报修');
            return copy(item);
        },
        list: function (account, code) {
            account = accountName(account);
            if (code !== undefined) code = codeName(code);
            var found = collect(account);
            var rows = Object.keys(found.items).map(function (id) { return found.items[id]; }).filter(function (it) {
                return code === undefined || it.code === code;
            });
            if (!found.readable || (found.failed && !rows.length)) fail('STORAGE_UNAVAILABLE', '无法完整读取报修意图，请勿另报新故障');
            return rows.sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.requestId.localeCompare(b.requestId); });
        },
        get: function (account, id) {
            return locate(accountName(account), idName(id)).item;
        },
        mark: function (account, id, state) {
            account = accountName(account); id = idName(id);
            if (state !== 'pending' && state !== 'uncertain') fail('INVALID_STATE', '报修意图状态无效');
            var found = locate(account, id);
            if (!found.item) fail('NOT_FOUND', '报修意图不存在');
            found.item.state = state;
            var raw = JSON.stringify(found.item), key = keyFor(account, id), confirmed = 0;
            found.locations.forEach(function (store) { if (writeConfirmed(store, key, raw)) confirmed++; });
            if (confirmed !== found.locations.length) fail('STORAGE_UNAVAILABLE', '无法保存报修意图状态，请保留原意图');
            return copy(found.item);
        },
        // Caller removes ONLY after a confirmed server/local receipt, never on timeout.
        remove: function (account, id) {
            account = accountName(account); id = idName(id);
            var key = keyFor(account, id), found = locate(account, id), removed = 0;
            found.locations.forEach(function (store) {
                try { store.removeItem(key); if (store.getItem(key) === null) removed++; } catch (e) { }
            });
            if (removed !== found.locations.length) fail('STORAGE_UNAVAILABLE', '无法清除已确认的报修意图');
            return true;
        }
    };
});