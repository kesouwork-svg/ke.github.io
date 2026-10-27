'use strict';
// Offline regression for the compact equipment-list actions. No network, database,
// login, hardware, downloads or printing: only the four dispatch targets are stubbed.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'docs/equipment/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'docs/equipment/css/equipment.css'), 'utf8');
let passed = 0;
const failures = [];
function ok(name, condition) {
    if (!condition) throw new Error(name);
    passed++;
}
function suite(name, fn) {
    try { fn(); } catch (e) { failures.push(name + ': ' + e.message); }
}

// Deliberately small DOM, parsed from the real HTML rather than duplicating toolbar
// markup. It models the DOM methods used by the actual app and records listeners.
function makeDocument() {
    const byId = Object.create(null), listeners = Object.create(null);
    let document;
    function element(tag = 'div', attrs = {}) {
        const e = {
            tagName: tag.toUpperCase(), attrs: Object.assign({}, attrs), children: [],
            parentNode: null, style: {}, value: '', innerHTML: '', textContent: '',
            open: Object.prototype.hasOwnProperty.call(attrs, 'open'), focusCount: 0,
            isConnected: true,
            getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
            setAttribute(name, value) {
                this.attrs[name] = String(value);
                if (name === 'open') this.open = true;
                if (name === 'id') byId[String(value)] = this;
            },
            removeAttribute(name) { delete this.attrs[name]; if (name === 'open') this.open = false; },
            hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); },
            appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
            contains(target) { for (let n = target; n; n = n.parentNode) if (n === this) return true; return false; },
            querySelectorAll(selector) { return descendants(this).filter(n => matches(n, selector)); },
            querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
            focus() { this.focusCount++; document.activeElement = this; },
            addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); },
            listeners: Object.create(null)
        };
        Object.defineProperty(e, 'className', { get() { return this.attrs.class || ''; }, set(v) { this.attrs.class = String(v); } });
        Object.defineProperty(e, 'id', { get() { return this.attrs.id || ''; }, set(v) { this.setAttribute('id', v); } });
        e.classList = {
            contains(token) { return e.className.split(/\s+/).includes(token); },
            add(...tokens) { e.className = [...new Set(e.className.split(/\s+/).filter(Boolean).concat(tokens))].join(' '); },
            remove(...tokens) { e.className = e.className.split(/\s+/).filter(t => t && !tokens.includes(t)).join(' '); },
            toggle(token, force) {
                const on = force === undefined ? !this.contains(token) : !!force;
                if (on) this.add(token); else this.remove(token);
                return on;
            }
        };
        if (attrs.id) byId[attrs.id] = e;
        if (attrs.value) e.value = attrs.value;
        if (attrs.style) attrs.style.split(';').forEach(item => {
            const pair = item.split(':'); if (pair[0] && pair[1]) e.style[pair[0].trim()] = pair.slice(1).join(':').trim();
        });
        return e;
    }
    function descendants(e) { return e.children.flatMap(child => [child].concat(descendants(child))); }
    function matches(e, selector) {
        selector = selector.trim();
        if (selector.includes(',')) return selector.split(',').some(s => matches(e, s));
        const parts = selector.split(/\s+/);
        if (parts.length > 1) {
            if (!matches(e, parts.pop())) return false;
            let n = e.parentNode;
            while (parts.length) {
                const part = parts.pop();
                while (n && !matches(n, part)) n = n.parentNode;
                if (!n) return false;
                n = n.parentNode;
            }
            return true;
        }
        if (selector === '*') return true;
        const tag = selector.match(/^[a-z][a-z0-9-]*/i);
        if (tag && e.tagName.toLowerCase() !== tag[0].toLowerCase()) return false;
        const id = selector.match(/#([\w-]+)/);
        if (id && e.id !== id[1]) return false;
        for (const m of selector.matchAll(/\.([\w-]+)/g)) if (!e.classList.contains(m[1])) return false;
        for (const m of selector.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
            if (!e.hasAttribute(m[1]) || (m[2] !== undefined && e.getAttribute(m[1]) !== m[2])) return false;
        }
        return true;
    }
    const tree = element('document'), stack = [tree];
    const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    for (const token of html.match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || []) {
        if (/^<!/.test(token)) continue;
        if (/^<\//.test(token)) { if (stack.length > 1) stack.pop(); continue; }
        if (token[0] !== '<') { stack[stack.length - 1].textContent += token; continue; }
        const tag = token.match(/^<([\w-]+)/);
        if (!tag) continue;
        const attrs = {};
        for (const a of token.slice(tag[0].length).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1]] = a[2] === undefined ? (a[3] === undefined ? (a[4] || '') : a[3]) : a[2];
        const node = element(tag[1], attrs);
        stack[stack.length - 1].appendChild(node);
        if (!voidTags.has(tag[1].toLowerCase()) && !/\/>$/.test(token)) stack.push(node);
    }
    document = {
        listeners, activeElement: null,
        getElementById(id) { return byId[id] || (byId[id] = element('div', { id })); },
        querySelectorAll(selector) { return descendants(tree).filter(n => matches(n, selector)); },
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
        addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
        createElement: element,
        body: descendants(tree).find(n => n.tagName === 'BODY'),
        head: descendants(tree).find(n => n.tagName === 'HEAD')
    };
    return document;
}

const fixture = {
    OPEN: { code: 'OPEN', name: '运行设备', line: '测试部', category: 'prod', family: '试验类别', records: [{ status: 'open' }, {}] },
    PENDING: { code: 'PENDING', name: '待补全设备', line: '测试部', category: 'prod', family: '试验类别', records: [{ status: 'done' }, { status: 'done', cause3: '分类', expectedAt: '2026-10-01', doneAt: '2026-10-02' }] },
    COMPLETE: { code: 'COMPLETE', name: '完成设备', line: '其他部', category: 'misc', family: '其他类别', records: [{ status: 'done', cause3: '分类', expectedAt: '2026-10-01', doneAt: '2026-10-02', delayReason: '已说明' }, { doneAt: '2026-10-01', cause3: '分类' }] }
};
function freshVM(role = 'admin') {
    const document = makeDocument(), windowListeners = Object.create(null), calls = [];
    const store = { roi_session: JSON.stringify({ token: 'offline', account: 'admin', name: '离线测试', level: 1, tools: [] }) };
    const storage = { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
    const forbidden = name => () => { throw new Error(name + ' forbidden in offline regression'); };
    const sandbox = {
        console, Promise, document, localStorage: storage, sessionStorage: storage,
        setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        location: { origin: 'https://offline.invalid', pathname: '/equipment/index.html', search: '' },
        history: { replaceState() {} }, scrollTo() {}, confirm: () => false,
        fetch: forbidden('Network'), print: forbidden('Printing'), open: forbidden('Window/download'),
        navigator: {}, addEventListener(type, fn) { (windowListeners[type] || (windowListeners[type] = [])).push(fn); }
    };
    sandbox.window = sandbox;
    const ctx = vm.createContext(sandbox);
    for (const file of ['docs/js/session.js', 'docs/equipment/js/equipment-api.js', 'docs/equipment/js/equipment-app.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx, { filename: file });
    }
    const run = source => vm.runInContext(source, ctx);
    run('EqConfig.cloud=false;ROLE=' + JSON.stringify(role) + ';EQ=' + JSON.stringify(fixture));
    sandbox.recordDispatch = action => calls.push({ action, open: document.getElementById('list-more').open });
    run("exportXlsx=function(){recordDispatch('export')};showLabels=function(){recordDispatch('labels')};openGroupOrder=function(){recordDispatch('order')};openTrash=function(){recordDispatch('trash')};");
    return {
        run, calls, document, windowListeners,
        menu: document.querySelector('#list-more'),
        summary: document.querySelector('#list-more summary'),
        el: id => document.getElementById(id),
        emit(type, values = {}) {
            const event = Object.assign({ type, target: document.body, key: '', preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, values);
            for (const fn of document.listeners[type] || []) fn(event);
            return event;
        }
    };
}

suite('HTML structure and permission hooks', () => {
    const d = makeDocument(), rows = d.querySelectorAll('.list-actions');
    ok('exactly one new list-actions row', rows.length === 1);
    const row = rows[0], menu = d.querySelector('#list-more');
    ok('list-actions retains the toolbar layout class', row.classList.contains('toolbar'));
    ok('native details menu is in that row and remains admin-only', !!menu && menu.tagName === 'DETAILS' && row.contains(menu) && menu.classList.contains('admin-only'));
    ok('menu starts collapsed', !menu.open);
    const summary = menu.querySelector('summary');
    ok('native summary has the exact accessible name', !!summary && summary.getAttribute('aria-label') === '更多设备操作');
    ok('summary remains keyboard-operable without negative tabindex', summary.getAttribute('tabindex') !== '-1');
    const mainButtons = row.children.filter(e => e.tagName === 'BUTTON');
    ok('three frequent actions remain direct siblings on one row', mainButtons.length === 3);
    ok('new action retains original handler and admin-only', mainButtons.some(e => e.classList.contains('admin-only') && /openArchiveForm\(''\)/.test(e.getAttribute('onclick') || '')));
    for (const [id, filter, badge] of [['btn-todo', 'open', 'todo-count'], ['btn-finish', 'pending', 'finish-count']]) {
        const button = d.querySelector('#' + id);
        ok(id + ' retains ID, handler, badge and row', !!button && mainButtons.includes(button) && button.getAttribute('onclick') === "setTaskFilter('" + filter + "')" && button.contains(d.querySelector('#' + badge)));
        ok(id + ' starts aria-pressed false', button.getAttribute('aria-pressed') === 'false');
    }
    ok('pending filter retains administrator hook', d.querySelector('#btn-finish').classList.contains('admin-only'));
    ok('ongoing filter stays available to repairers', !d.querySelector('#btn-todo').classList.contains('admin-only'));
    const buttons = menu.querySelectorAll('button');
    ok('menu contains exactly four low-frequency actions', buttons.length === 4);
    for (const key of ['export', 'labels', 'order', 'trash']) {
        const onclick = "runListAction('" + key + "')";
        const all = d.querySelectorAll('button').filter(b => b.getAttribute('onclick') === onclick);
        ok(key + ' appears once and only in native details', all.length === 1 && menu.contains(all[0]));
    }
    for (const handler of ['exportXlsx', 'showLabels', 'openGroupOrder', 'openTrash']) {
        ok('no legacy direct low-frequency ' + handler + ' button', !d.querySelectorAll('button').some(b => new RegExp('^\\s*' + handler + '\\(\\)\\s*;?\\s*$').test(b.getAttribute('onclick') || '')));
    }
    const listOnly = d.querySelector('#view-list .list-only');
    ok('there are only two list toolbars: filters and compact actions', listOnly.querySelectorAll('.toolbar').length === 2);
});

suite('CSS compact scope and role visibility', () => {
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selectors: m[1].trim().split(',').map(s => s.trim()), body: m[2] }));
    const row = rules.find(r => r.selectors.some(s => s === '.list-actions' || s === '.toolbar.list-actions'));
    ok('compact row spacing is scoped to list-actions', !!row && /gap\s*:\s*(?:[0-6](?:\.\d+)?)px/.test(row.body));
    ok('compact button sizing is local to list-actions', rules.some(r => r.selectors.every(s => s.includes('.list-actions')) && r.selectors.some(s => /\.btn(?:$|[:\s.>])/.test(s)) && /(?:padding|min-height|font-size)\s*:/.test(r.body)));
    const globalBtn = rules.find(r => r.selectors.length === 1 && r.selectors[0] === '.btn');
    ok('global .btn retains original padding and minimum height', !!globalBtn && /padding\s*:\s*9px\s+14px/.test(globalBtn.body) && /min-height\s*:\s*42px/.test(globalBtn.body));
    ok('non-admin admin-only visibility guard remains', rules.some(r => r.selectors.includes('body:not(.is-admin) .admin-only') && /display\s*:\s*none/.test(r.body)));
    for (const role of ['reporter', 'view']) ok(role + ' cannot see management list row', rules.some(r => r.selectors.includes('body.is-' + role + ' .list-only') && /display\s*:\s*none/.test(r.body)));
});

for (const action of ['export', 'labels', 'order', 'trash']) suite('admin dispatch ' + action, () => {
    const t = freshVM();
    ok('admin has manageDevices capability', t.run('caps().manageDevices') === true);
    t.menu.open = true;
    t.run('runListAction(' + JSON.stringify(action) + ')');
    ok('dispatches only the requested existing function', t.calls.length === 1 && t.calls[0].action === action);
    ok('closes details before calling business action', t.calls[0].open === false && t.menu.open === false);
});

suite('strict whitelist rejects invalid and inherited keys', () => {
    const t = freshVM();
    for (const value of [undefined, null, false, 0, [], {}, ['export'], '', 'unknown', 'EXPORT', '__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'exportXlsx']) {
        t.menu.open = true;
        t.run('runListAction(' + (value === undefined ? 'undefined' : JSON.stringify(value)) + ')');
        ok('no dispatch for invalid key ' + String(value), t.calls.length === 0);
    }
});
for (const role of ['repairer', 'reporter', 'view', 'none']) suite('role guard ' + role, () => {
    const t = freshVM(role);
    ok(role + ' has no manageDevices capability', t.run('caps().manageDevices') === false);
    for (const action of ['export', 'labels', 'order', 'trash']) {
        t.menu.open = true;
        t.run('runListAction(' + JSON.stringify(action) + ')');
        ok(role + ' cannot dispatch ' + action, t.calls.length === 0);
    }
});

suite('close API and focus restoration', () => {
    const t = freshVM();
    t.menu.open = true;
    t.run('closeListActions(false)');
    ok('close(false) collapses details', !t.menu.open);
    ok('close(false) does not steal focus', t.summary.focusCount === 0);
    t.menu.open = true;
    t.run('closeListActions(true)');
    ok('close(true) collapses details and focuses summary', !t.menu.open && t.document.activeElement === t.summary && t.summary.focusCount === 1);
    t.run('closeListActions()');
    ok('repeated close is harmless and does not refocus', !t.menu.open && t.summary.focusCount === 1);
});
suite('document click and keyboard listeners', () => {
    const t = freshVM();
    ok('real app registered document click handler', (t.document.listeners.click || []).length > 0);
    ok('real app registered document keydown handler', (t.document.listeners.keydown || []).length > 0);
    t.menu.open = true;
    t.emit('click', { target: t.summary });
    ok('summary click stays inside menu without premature close', t.menu.open);
    t.emit('click', { target: t.menu.querySelector('button') });
    ok('menu-item click is inside until its own dispatch handler', t.menu.open);
    t.emit('click', { target: t.menu });
    ok('details container click remains inside', t.menu.open);
    t.emit('click', { target: t.el('f-q') });
    ok('outside click closes menu without stealing focus', !t.menu.open && t.summary.focusCount === 0);
    t.menu.open = true;
    t.emit('keydown', { key: 'Enter', target: t.summary });
    ok('unrelated key leaves menu unchanged', t.menu.open);
    const escape = t.emit('keydown', { key: 'Escape', target: t.menu.querySelector('button') });
    ok('Escape collapses menu and restores summary focus', !t.menu.open && t.document.activeElement === t.summary);
    ok('handled Escape prevents the default browser action', escape.defaultPrevented === true);
    const count = t.summary.focusCount;
    t.document.activeElement = t.el('f-q');
    t.emit('keydown', { key: 'Escape', target: t.el('f-q') });
    ok('Escape on already-closed menu does not steal focus', t.document.activeElement === t.el('f-q') && t.summary.focusCount === count);
});
suite('keyboard focus outside closes without stealing focus', () => {
    const t = freshVM();
    ok('real app registered document focusin handler', (t.document.listeners.focusin || []).length > 0);
    t.menu.open = true;
    t.emit('focusin', { target: t.summary });
    ok('focus on summary keeps menu open', t.menu.open);
    t.emit('focusin', { target: t.menu.querySelector('button') });
    ok('focus on menu action keeps menu open', t.menu.open);
    t.document.activeElement = t.el('f-q');
    t.emit('focusin', { target: t.el('f-q') });
    ok('tabbing outside closes without refocusing summary', !t.menu.open && t.document.activeElement === t.el('f-q') && t.summary.focusCount === 0);
});
suite('switching view closes the menu', () => {
    const t = freshVM();
    t.menu.open = true;
    t.run('switchView("record")');
    ok('switchView collapses native details', !t.menu.open);
    ok('switchView retains view activation', t.el('view-record').classList.contains('show') && !t.el('view-list').classList.contains('show'));
});
for (const role of ['admin', 'repairer', 'reporter', 'view', 'none']) suite('home closes menu for ' + role, () => {
    const t = freshVM(role);
    // Reporter home normally reads the API; record that navigation endpoint only.
    t.run('var homeCalls=[];loadMine=function(code,noAuto){homeCalls.push([code,noAuto])};');
    t.menu.open = true;
    t.run('goToolHome()');
    ok(role + ' home collapses native details', !t.menu.open);
    if (role === 'reporter') ok('reporter retains own home route', t.run('JSON.stringify(homeCalls)') === '[["",true]]');
    else ok(role + ' retains home view route', t.el(role === 'admin' || role === 'repairer' ? 'view-list' : 'view-scan').classList.contains('show'));
});

suite('filter toggle, aria and existing counts', () => {
    const t = freshVM();
    t.run('renderList();renderTodoBadge()');
    ok('ongoing badge counts records, not devices, including legacy status', Number(t.el('todo-count').textContent) === 2);
    ok('pending badge preserves missing classification and delayed-reason rules', Number(t.el('finish-count').textContent) === 2);
    ok('both nonzero filters remain visible', t.el('btn-todo').style.display !== 'none' && t.el('btn-finish').style.display !== 'none');
    t.run('setTaskFilter("open")');
    ok('open filter activates original toggle state and aria', t.run('taskFilter') === 'open' && t.el('btn-todo').classList.contains('active') && t.el('btn-todo').getAttribute('aria-pressed') === 'true');
    ok('open filter leaves pending inactive and aria false', !t.el('btn-finish').classList.contains('active') && t.el('btn-finish').getAttribute('aria-pressed') === 'false');
    ok('open filter preserves matching device set', t.run('JSON.stringify(filterCodes())') === '["OPEN"]' && t.el('eq-count').textContent === '共 1 台');
    t.run('setTaskFilter("pending")');
    ok('pending switches state and updates both aria values', t.run('taskFilter') === 'pending' && !t.el('btn-todo').classList.contains('active') && t.el('btn-todo').getAttribute('aria-pressed') === 'false' && t.el('btn-finish').classList.contains('active') && t.el('btn-finish').getAttribute('aria-pressed') === 'true');
    ok('pending filter preserves matching device set', t.run('JSON.stringify(filterCodes())') === '["PENDING"]');
    t.run('setTaskFilter("pending")');
    ok('clicking active filter clears it as before', t.run('taskFilter') === '' && t.el('btn-finish').getAttribute('aria-pressed') === 'false' && t.run('filterCodes().length') === 3);
    t.run('setTaskFilter("open");setTaskFilter("open")');
    ok('ongoing filter also toggles off and updates aria', t.run('taskFilter') === '' && !t.el('btn-todo').classList.contains('active') && t.el('btn-todo').getAttribute('aria-pressed') === 'false');
});
for (const [filter, id, badge, other] of [['open', 'btn-todo', 'todo-count', 'btn-finish'], ['pending', 'btn-finish', 'finish-count', 'btn-todo']]) suite('active zero-count ' + filter, () => {
    const t = freshVM();
    t.run('setTaskFilter(' + JSON.stringify(filter) + ');EQ={};renderTodoBadge()');
    ok(filter + ' active zero-count filter remains cancellable', Number(t.el(badge).textContent) === 0 && t.el(id).style.display !== 'none' && t.el(id).getAttribute('aria-pressed') === 'true');
    ok('inactive zero-count counterpart is hidden', t.el(other).style.display === 'none');
    t.run('setTaskFilter(' + JSON.stringify(filter) + ')');
    ok(filter + ' cancels and immediately hides inactive zero-count filter', t.run('taskFilter') === '' && t.el(id).style.display === 'none' && t.el(id).getAttribute('aria-pressed') === 'false');
});
for (const role of ['admin', 'repairer']) suite('home resets filter aria for ' + role, () => {
    const t = freshVM(role);
    for (const filter of ['open', 'pending']) {
        t.run('setTaskFilter(' + JSON.stringify(filter) + ')');
        t.el('f-q').value = 'stale'; t.el('f-line').value = '测试部'; t.el('f-cat').value = 'prod';
        t.run('goToolHome()');
        ok(role + ' home resets ' + filter + ' state and aria', t.run('taskFilter') === '' && ['btn-todo', 'btn-finish'].every(id => !t.el(id).classList.contains('active') && t.el(id).getAttribute('aria-pressed') === 'false'));
        ok(role + ' home preserves original reset of text/department/category', ['f-q', 'f-line', 'f-cat'].every(id => t.el(id).value === '') && t.el('eq-count').textContent === '共 3 台');
    }
});

for (const role of ['admin', 'repairer']) {
    for (const [filter, id] of [['open', 'btn-todo'], ['pending', 'btn-finish']]) suite('home immediately hides active zero-count ' + role + ' ' + filter, () => {
        // A fresh VM for every role/filter pair prevents a prior reset from masking
        // stale visibility. Only the data-change setup explicitly refreshes badges.
        const t = freshVM(role);
        t.run('setTaskFilter(' + JSON.stringify(filter) + ');EQ={};renderTodoBadge()');
        ok(role + ' ' + filter + ' starts with active zero-count button retained', t.run('taskFilter') === filter && t.el(id).style.display !== 'none' && t.el(id).getAttribute('aria-pressed') === 'true');
        t.run('goToolHome()');
        ok(role + ' home immediately hides both zero-count filter buttons', t.run('taskFilter') === '' && ['btn-todo', 'btn-finish'].every(buttonId => t.el(buttonId).style.display === 'none' && !t.el(buttonId).classList.contains('active') && t.el(buttonId).getAttribute('aria-pressed') === 'false'));
        ok(role + ' home preserves empty-list count and list route', t.el('eq-count').textContent === '共 0 台' && t.el('view-list').classList.contains('show'));
    });
}

for (const failure of failures) console.error('FAIL ' + failure);
console.log('通过 ' + passed + ' / 失败 ' + failures.length + '（紧凑操作栏离线回归，无网络/数据库/硬件/打印）');
if (failures.length) process.exitCode = 1;
