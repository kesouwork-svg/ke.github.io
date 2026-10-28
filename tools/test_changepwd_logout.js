'use strict';
/* Offline forced-password logout regression: node tools/test_changepwd_logout.js.
 * Real page inline code + real SessionStore. Fresh VMs; fake browser/API only.
 * No network, real login, printing or product-file writes.
 */
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'docs/changepwd.html'), 'utf8');
const sessionCode = fs.readFileSync(path.join(root, 'docs/js/session.js'), 'utf8');
const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(m => !/\bsrc\s*=/i.test(m[1]) && m[2].trim()).map(m => m[2]);
const QR = 'equipment/index.html?code=PS04-95&wo=WO-20261028-01';
const TOKEN = 'offline-current-token-never-in-urls';
const ACCOUNT = { account: 'offline-user', name: '离线用户', tools: ['equipment-reporter', 'roi'], dept: '模具部', level: 2, must_change_pwd: true };
let checks = 0, scenarios = 0;
function ok(name, value) { assert.ok(value, name); checks++; }
function eq(name, actual, expected) { assert.deepStrictEqual(actual, expected, name); checks++; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function storage(seed, blocked) {
    const data = Object.assign(Object.create(null), seed);
    return { data,
        getItem(k) { if (blocked) throw Error('Storage unavailable'); return Object.hasOwn(data, k) ? data[k] : null; },
        setItem(k, v) { if (blocked) throw Error('Storage unavailable'); data[k] = String(v); },
        removeItem(k) { if (blocked) throw Error('Storage unavailable'); delete data[k]; },
        clear() { if (blocked) throw Error('Storage unavailable'); for (const k of Object.keys(data)) delete data[k]; }
    };
}
function make(options = {}) {
    scenarios++;
    const s = options.session === undefined ? { token: TOKEN, ...clone(ACCOUNT) } : options.session;
    const search = options.search === undefined ? '?next=' + encodeURIComponent(QR) : options.search;
    const ls = storage({ keep_local: 'untouched' }, options.localBlocked), ss = storage({ keep_tab: 'untouched' });
    if (options.user) ls.data.roi_users = JSON.stringify({ [options.user.account]: options.user });
    if (s) {
        const raw = JSON.stringify(s);
        if (!options.sessionOnly && !options.localBlocked) { ls.data.roi_session = raw; ls.data.roi_session_at = String(Date.now()); }
        ss.data.roi_session = raw;
    }
    const els = {}, events = {}, nav = [], timers = new Map();
    const calls = { logout: [], change: [], observations: [] };
    let now = 0, timerId = 0, ctx;
    for (const m of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
        const attrs = m[2], id = m[3];
        els[id] = { id, tagName: m[1].toUpperCase(), value: '', textContent: '', disabled: /\bdisabled(?:\s|=|$)/i.test(attrs),
            style: { display: /display\s*:\s*none/i.test(attrs) ? 'none' : '' },
            onclickSource: (attrs.match(/\bonclick="([^"]*)"/i) || [])[1],
            focus() { this.focused = true; }, addEventListener() {},
            click() { if (!this.disabled && this.onclickSource) return vm.runInContext(this.onclickSource, ctx); }
        };
    }
    const location = { search, pathname: '/changepwd.html', origin: 'https://offline.invalid', hash: '',
        get href() { return this.origin + this.pathname + search; },
        set href(url) { nav.push({ method: 'href', url: String(url), at: now }); },
        replace(url) { nav.push({ method: 'replace', url: String(url), at: now }); },
        assign(url) { nav.push({ method: 'assign', url: String(url), at: now }); }
    };
    const on = (name, fn) => { (events[name] || (events[name] = [])).push(fn); };
    const sb = { console, Promise, URL, URLSearchParams, location, localStorage: ls, sessionStorage: ss,
        document: { readyState: 'complete', getElementById: id => els[id] || null, addEventListener: on,
            querySelector: sel => sel[0] === '#' ? els[sel.slice(1)] || null : null,
            querySelectorAll: sel => /^input\[type=['"]?password['"]?\]$/.test(sel) ? ['cp-old', 'cp-new', 'cp-new2'].map(id => els[id]) : [] },
        addEventListener: on,
        setTimeout(fn, delay = 0) {
            const t = { id: ++timerId, fn, at: now + Math.max(0, Number(delay) || 0), cancelled: false };
            timers.set(t.id, t); return t.id;
        },
        clearTimeout(id) { const t = timers.get(id); if (t) { t.cancelled = true; timers.delete(id); } },
        fetch() { throw Error('Network forbidden by offline regression'); },
        XMLHttpRequest() { throw Error('Network forbidden by offline regression'); },
        WebSocket() { throw Error('Network forbidden by offline regression'); },
        print() { throw Error('Printing forbidden by offline regression'); }
    };
    sb.window = sb;
    function passwords() { return ['cp-old', 'cp-new', 'cp-new2'].map(id => els[id].value); }
    if (options.sdk !== 'missing') {
        sb.AppApi = { changePwd(...args) { calls.change.push(args); return options.change ? options.change(...args) : Promise.resolve({ ok: true }); } };
        if (options.sdk !== 'no-logout') sb.AppApi.logout = token => {
            calls.logout.push(token); calls.observations.push({ session: sb.SessionStore.get(), passwords: passwords() });
            return options.logout ? options.logout(token) : Promise.resolve({ ok: true });
        };
    }
    ctx = vm.createContext(sb);
    vm.runInContext(sessionCode, ctx, { filename: 'docs/js/session.js' });
    for (const code of inline) vm.runInContext(code, ctx, { filename: 'docs/changepwd.html:inline' });
    return { sb, els, nav, calls, ls, ss, timers, passwords,
        run(code) { return vm.runInContext(code, ctx); }, session() { return sb.SessionStore.get(); },
        fill(values = ['old-password', 'new-password', 'new-password']) { ['cp-old', 'cp-new', 'cp-new2'].forEach((id, i) => { els[id].value = values[i]; }); },
        event(name, data = {}) { for (const fn of [...(events[name] || [])]) fn(Object.assign({ type: name }, data)); },
        async tick(ms) {
            const end = now + ms;
            for (let budget = 100; ; budget--) {
                if (!budget) throw Error('Runaway fake timers');
                const next = [...timers.values()].filter(t => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
                if (!next) break;
                now = next.at; timers.delete(next.id); next.fn(); await flush();
            }
            now = end; await flush();
        }
    };
}
function cleared(t, label) {
    eq(label + ': SessionStore empty', t.session(), null);
    for (const [name, st] of [['LS', t.ls], ['SS', t.ss]]) {
        eq(label + ': ' + name + ' session removed', st.data.roi_session, undefined);
        eq(label + ': ' + name + ' timestamp removed', st.data.roi_session_at, undefined);
    }
    eq(label + ': passwords erased', t.passwords(), ['', '', '']);
    eq(label + ': unrelated LS retained', t.ls.data.keep_local, 'untouched');
    eq(label + ': unrelated SS retained', t.ss.data.keep_tab, 'untouched');
}
function loginNavigation(t, label, target = QR) {
    ok(label + ': navigated', t.nav.length > 0);
    for (const n of t.nav) {
        eq(label + ': history-replacing login navigation', n.method, 'replace');
        eq(label + ': next preserved exactly', n.url, 'login.html?next=' + encodeURIComponent(target));
        ok(label + ': token absent from URL', !n.url.includes(TOKEN) && !n.url.includes(encodeURIComponent(TOKEN)));
    }
}
async function main() {
    {
        const t = make();
        for (const name of ['doLogout', 'doChangePwd', 'doSkip', 'nextUrl', 'loginUrl']) eq('page exposes ' + name, t.run('typeof ' + name), 'function');
        ok('real SessionStore script included', /<script\b[^>]*src="\.\/js\/session\.js(?:\?[^"<>]*)?"/i.test(html));
        ok('logout button exists', t.els['cp-logout'] && t.els['cp-logout'].tagName === 'BUTTON');
        ok('logout button wired', /\bdoLogout\s*\(/.test(t.els['cp-logout'].onclickSource));
        ok('save has stable id and handler', t.els['cp-save'] && /\bdoChangePwd\s*\(/.test(t.els['cp-save'].onclickSource));
        ok('logout label explicit', /<button\b[^>]*id="cp-logout"[^>]*>[\s\S]*?退出登录[\s\S]*?<\/button>/i.test(html));
        eq('forced skip hidden', t.els['cp-skip'].style.display, 'none');
        t.run('doSkip()'); eq('direct skip cannot bypass required change', t.nav.length, 0);
        eq('skip leaves forced flag true', t.session().must_change_pwd, true);
        eq('QR work order retained', t.run('nextUrl()'), QR);
        eq('login URL wraps exact next', t.run('loginUrl()'), 'login.html?next=' + encodeURIComponent(QR));
    }
    for (const values of [['', '', ''], ['old', 'tiny', 'different']]) {
        const t = make(); t.fill(values); t.els['cp-logout'].click(); cleared(t, 'no validation on exit');
        eq('original token captured exactly once', t.calls.logout, [TOKEN]);
        eq('exit never submits changePwd', t.calls.change.length, 0);
        eq('session cleared before logout RPC', t.calls.observations[0].session, null);
        eq('passwords cleared before logout RPC', t.calls.observations[0].passwords, ['', '', '']);
        await flush(); await t.tick(1200); loginNavigation(t, 'no validation on exit');
    }
    for (const [label, options] of [
        ['resolved failure', { logout: () => Promise.resolve({ ok: false }) }],
        ['rejected RPC', { logout: () => Promise.reject(Error('offline logout rejection')) }],
        ['synchronous throw', { logout: () => { throw Error('offline logout throw'); } }],
        ['missing SDK', { sdk: 'missing' }], ['missing method', { sdk: 'no-logout' }],
        ['never settles', { logout: () => new Promise(() => {}) }]
    ]) {
        const t = make(options); t.fill(); t.run('doLogout()'); cleared(t, label);
        if (!options.sdk) eq(label + ': original token sent', t.calls.logout, [TOKEN]);
        if (label === 'never settles') ok('hung RPC has bounded fallback timer', [...t.timers.values()].some(timer => timer.at > 0 && timer.at <= 1100));
        await flush(); await t.tick(1200); loginNavigation(t, label); eq(label + ': one navigation', t.nav.length, 1);
    }
    {
        const pending = deferred(), t = make({ logout: () => pending.promise });
        t.run('doLogout(); doLogout(); doLogout()'); eq('repeated exit has single RPC', t.calls.logout, [TOKEN]);
        await t.tick(1200); loginNavigation(t, 'repeated hung exit');
        pending.resolve({ ok: true }); await flush(); t.run('doLogout()'); await t.tick(5000);
        eq('late RPC and repeated exit cannot navigate twice', t.nav.length, 1); cleared(t, 'idempotent exit');
    }
    {
        const t = make({ sessionOnly: true, localBlocked: true });
        eq('real SessionStore uses SS fallback', t.session().token, TOKEN);
        t.fill(); t.run('doLogout()'); cleared(t, 'blocked LS fallback');
        await flush(); await t.tick(1200); loginNavigation(t, 'blocked LS fallback');
    }
    for (const target of [
        'https://outside.invalid/equipment/index.html', 'http://outside.invalid/', '//outside.invalid/',
        'javascript:alert(1)', '\\\\outside.invalid\\path', 'equipment\\index.html',
        'equipment/index.html?code=%ZZ', 'equipment/index.html?code=%',
        'equipment/index.html?code=PS04-95\nignored', 'equipment/index.html?code=PS04-95\rignored',
        'equipment/index.html?code=PS04-95\tignored', 'equipment/index.html?code=PS04-95\u0000ignored',
        'login.html', './login.html?next=index.html', 'changepwd.html?next=index.html', './changepwd.html#again'
    ]) {
        const t = make({ search: '?next=' + encodeURIComponent(target) });
        eq('unsafe next rejected: ' + JSON.stringify(target), t.run('nextUrl()'), 'index.html');
        eq('unsafe next cannot enter login redirect', t.run('loginUrl()'), 'login.html?next=index.html');
    }
    for (const search of ['', '?next=%E0%A4%A', '?next=%', '?next=%ZZ']) {
        const t = make({ search }); eq('empty/malformed query safe: ' + search, t.run('nextUrl()'), 'index.html');
        t.run('doLogout()'); await flush(); await t.tick(1200); loginNavigation(t, 'malformed query exit', 'index.html');
    }
    for (const session of [null, { guest: true, token: '', must_change_pwd: false }]) {
        const t = make({ session }); await flush(); await t.tick(1200); loginNavigation(t, 'anonymous/guest init');
        eq('initial route sends no logout RPC', t.calls.logout.length, 0);
    }
    {
        const t = make(); t.fill(); t.sb.SessionStore.clear(); t.event('pageshow', { persisted: true });
        await flush(); await t.tick(1200); loginNavigation(t, 'logged-out BFCache page');
        eq('BFCache restore sends no stale token', t.calls.logout.length, 0);
    }
    for (const outcome of ['success', 'failure', 'rejection']) {
        const pending = deferred(), t = make({ change: () => pending.promise });
        t.fill(); t.els['cp-save'].click(); eq('pending save uses original token/passwords', t.calls.change, [[TOKEN, 'old-password', 'new-password']]);
        ok('logout enabled during pending save', !t.els['cp-logout'].disabled);
        t.els['cp-logout'].click(); cleared(t, 'pending-save ' + outcome);
        if (outcome === 'rejection') pending.reject(Error('offline late changePwd rejection'));
        else pending.resolve(outcome === 'success' ? { ok: true } : { ok: false, msg: 'offline late failure' });
        await flush(); await t.tick(5000); cleared(t, 'late-save ' + outcome); loginNavigation(t, 'late-save ' + outcome);
        eq('late save cannot add protected-page redirect: ' + outcome, t.nav.length, 1);
    }
    {
        const t = make(); t.fill(); t.run('doChangePwd()'); await flush();
        eq('successful save clears required flag', t.session().must_change_pwd, false);
        const successTimers = [...t.timers.values()]; ok('success schedules continuation', successTimers.length > 0);
        t.run('doLogout()'); ok('logout cancels success timer', successTimers.every(timer => timer.cancelled));
        // Model a callback already queued before cancellation: it must also be guarded.
        for (const timer of successTimers) timer.fn();
        await flush(); await t.tick(5000); cleared(t, 'logout after success'); loginNavigation(t, 'cancelled continuation');
        eq('queued success callback cannot redirect after exit', t.nav.length, 1);
    }
    {
        const t = make(); t.fill(); t.els['cp-save'].click(); await flush();
        eq('normal valid save merges flag retaining account/tools/dept', clone(t.session()), { token: TOKEN, ...clone(ACCOUNT), must_change_pwd: false });
        await t.tick(1200); eq('normal save continues to exact QR', t.nav.map(n => n.url), [QR]);
        eq('normal save never logs out', t.calls.logout.length, 0);
    }
    {
        const t = make({ session: { token: TOKEN, ...clone(ACCOUNT), must_change_pwd: false } });
        ok('voluntary skip visible', t.els['cp-skip'].style.display !== 'none'); t.run('doSkip()');
        eq('voluntary skip reaches QR', t.nav.map(n => n.url), [QR]); eq('voluntary skip calls no API', [t.calls.logout.length, t.calls.change.length], [0, 0]);
        eq('voluntary skip retains session', clone(t.session()), { token: TOKEN, ...clone(ACCOUNT), must_change_pwd: false });
    }
    {
        // Mock stored account only; do not invoke a backend or a login implementation.
        const user = { ...clone(ACCOUNT), pwd: 'offline-admin-issued-password' }, t = make({ user });
        const before = t.ls.data.roi_users; t.run('doLogout()'); await flush(); await t.tick(1200);
        eq('logout leaves stored user/password/forced flag untouched', t.ls.data.roi_users, before);
        eq('logout cannot change mocked backend password', t.calls.change.length, 0);
        const storedUser = JSON.parse(t.ls.data.roi_users)[user.account];
        const returning = make({ session: { token: 'offline-new-session', ...storedUser } });
        eq('fresh session from same stored user still forced', returning.session().must_change_pwd, true);
        eq('returning forced user skip hidden', returning.els['cp-skip'].style.display, 'none');
        returning.run('doSkip()'); eq('returning user cannot skip required change', returning.nav.length, 0);
    }
    console.log('changepwd logout: ' + checks + ' checks passed; ' + scenarios + ' fresh offline VM scenarios.');
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
