'use strict';
// Complete real APP + real HTML in an isolated VM; only the DOM and EquipApi are
// fakes. No SDK, database, account login, network, hardware, downloads or printing.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'docs/equipment/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'docs/equipment/js/equipment-app.js'), 'utf8');
let passed = 0, failed = 0, suites = 0;
const failures = [];
function check(name, condition) {
    if (condition) passed++;
    else { failed++; failures.push(name); }
}
async function suite(name, fn) {
    suites++;
    try { await fn(); }
    catch (e) { failed++; failures.push(name + ': ' + (e && e.stack || e)); }
}
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const decode = value => String(value).replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Parse the actual HTML and dynamically assigned innerHTML. In particular, a
// SELECT behaves like a browser: its value must name an existing OPTION, and
// replacing options can lose selection. This catches the target-search bug that
// an unconstrained {value: ''} DOM fake would accidentally conceal.
function makeDocument() {
    const ids = Object.create(null), listeners = Object.create(null);
    let document;
    function descendants(node) { return node.children.flatMap(child => [child].concat(descendants(child))); }
    function matches(e, selector) {
        selector = selector.trim();
        if (selector.includes(',')) return selector.split(',').some(s => matches(e, s));
        const parts = selector.split(/\s+/);
        if (parts.length > 1) {
            if (!matches(e, parts.pop())) return false;
            let n = e.parentNode;
            while (parts.length) { const part = parts.pop(); while (n && !matches(n, part)) n = n.parentNode; if (!n) return false; n = n.parentNode; }
            return true;
        }
        if (selector === '*') return true;
        const tag = selector.match(/^[a-z][\w-]*/i);
        if (tag && e.tagName.toLowerCase() !== tag[0].toLowerCase()) return false;
        const id = selector.match(/#([\w-]+)/);
        if (id && e.id !== id[1]) return false;
        for (const m of selector.matchAll(/\.([\w-]+)/g)) if (!e.classList.contains(m[1])) return false;
        for (const m of selector.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) if (!e.hasAttribute(m[1]) || m[2] !== undefined && e.getAttribute(m[1]) !== m[2]) return false;
        return true;
    }
    function unregister(node) { for (const child of descendants(node)) if (child.id && ids[child.id] === child) delete ids[child.id]; }
    function element(tag = 'div', attrs = {}) {
        let markup = '', text = '', value = attrs.value || '';
        const e = {
            tagName: tag.toUpperCase(), attrs: {...attrs}, children: [], parentNode: null,
            style: {}, disabled: Object.prototype.hasOwnProperty.call(attrs, 'disabled'),
            open: Object.prototype.hasOwnProperty.call(attrs, 'open'), focusCount: 0,
            listeners: Object.create(null),
            getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
            setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') ids[String(v)] = this; if (k === 'disabled') this.disabled = true; },
            hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
            removeAttribute(k) { delete this.attrs[k]; if (k === 'disabled') this.disabled = false; },
            appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
            contains(target) { for (let n = target; n; n = n.parentNode) if (n === this) return true; return false; },
            querySelectorAll(selector) { return descendants(this).filter(n => matches(n, selector)); },
            querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
            focus() { this.focusCount++; document.activeElement = this; },
            scrollIntoView() {}, setSelectionRange() {},
            addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
        };
        Object.defineProperties(e, {
            id: {get() { return this.attrs.id || ''; }, set(v) { this.setAttribute('id', v); }},
            className: {get() { return this.attrs.class || ''; }, set(v) { this.attrs.class = String(v); }},
            innerHTML: {get() { return markup; }, set(v) { unregister(this); this.children = []; text = ''; markup = String(v); parse(markup, this); }},
            textContent: {get() { return text + this.children.map(c => c.textContent).join(''); }, set(v) { unregister(this); this.children = []; text = String(v); markup = ''; }},
            innerText: {get() { return this.textContent; }, set(v) { this.textContent = v; }},
            options: {get() { return descendants(this).filter(n => n.tagName === 'OPTION'); }},
            selectedIndex: {get() { return this.options.findIndex(o => o.selected); }, set(v) { this.options.forEach((o, i) => { o.selected = i === Number(v); }); }},
            value: {
                get() { if (this.tagName === 'SELECT') { const o = this.options.find(o => o.selected); return o ? o.value : ''; } return this.tagName === 'OPTION' && !Object.prototype.hasOwnProperty.call(this.attrs, 'value') ? this.textContent : value; },
                set(v) { value = String(v); if (this.tagName === 'SELECT') this.options.forEach(o => { o.selected = o.value === value; }); }
            }
        });
        e.selected = Object.prototype.hasOwnProperty.call(attrs, 'selected');
        e.classList = {
            contains(token) { return e.className.split(/\s+/).includes(token); },
            add(...tokens) { e.className = [...new Set(e.className.split(/\s+/).filter(Boolean).concat(tokens))].join(' '); },
            remove(...tokens) { e.className = e.className.split(/\s+/).filter(t => t && !tokens.includes(t)).join(' '); },
            toggle(token, force) { const on = force === undefined ? !this.contains(token) : !!force; if (on) this.add(token); else this.remove(token); return on; }
        };
        if (attrs.id) ids[attrs.id] = e;
        return e;
    }
    const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    function parse(source, parent) {
        const stack = [parent];
        for (const token of source.match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || []) {
            if (/^<!/.test(token)) continue;
            if (/^<\//.test(token)) { if (stack.length > 1) stack.pop(); continue; }
            if (token[0] !== '<') { const node = element('#text'); node.textContent = decode(token); stack[stack.length - 1].appendChild(node); continue; }
            const tag = token.match(/^<([\w-]+)/); if (!tag) continue;
            const attrs = {};
            for (const a of token.slice(tag[0].length).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1]] = decode(a[2] === undefined ? (a[3] === undefined ? a[4] || '' : a[3]) : a[2]);
            const node = element(tag[1], attrs); stack[stack.length - 1].appendChild(node);
            if (!voids.has(tag[1].toLowerCase()) && !/\/>$/.test(token)) stack.push(node);
        }
        for (const select of [parent].concat(descendants(parent)).filter(e => e.tagName === 'SELECT')) {
            const selected = select.options.filter(o => o.selected);
            if (selected.length > 1) selected.slice(0, -1).forEach(o => { o.selected = false; });
            if (!selected.length && select.options.length) select.options[0].selected = true;
        }
    }
    const tree = element('document'); parse(html, tree);
    document = {
        activeElement: null, listeners,
        getElementById(id) { return ids[id] || null; },
        querySelectorAll(selector) { return descendants(tree).filter(n => matches(n, selector)); },
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
        createElement: element,
        addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
        body: descendants(tree).find(n => n.tagName === 'BODY'), head: descendants(tree).find(n => n.tagName === 'HEAD')
    };
    return document;
}

const SOURCE = 'EQ-A-01', TARGET = 'EQ-A-02', GENERIC = 'GEN-A', CROSS = 'EQ-B-01';
const DEPT = '测试车间甲';
function fixture() {
    const record = {id: 'open-other', no: 'WX20261028-0007', status: 'open', reportAt: '2026-10-28', reportBy: '另一位报修人', symptom: '原现象', place: '原位置', updates: [], cost: 12345};
    return {
        [SOURCE]: {code: SOURCE, number: '厂内-A01', name: '源设备', family: '试验类别甲', category: 'prod', line: DEPT, records: [
            record,
            {...record, id: 'second', no: 'WX20261028-0008', symptom: '第二单'},
            {...record, id: 'done', no: 'WX20261028-0009', status: 'done', doneAt: '2026-10-28'},
            {...record, id: 'open-doneAt', no: 'WX20261028-0010', status: 'open', doneAt: '2026-10-28'},
            {...record, id: 'legacy-done', no: 'WX20261028-0011', status: undefined, doneAt: '2026-10-28'},
            {...record, id: 'legacy-open', no: 'WX20261028-0012', status: undefined, place: undefined}
        ]},
        [TARGET]: {code: TARGET, number: '厂内-A02', name: '目标设备', family: '给排水/通风', category: 'facility', line: DEPT, records: []},
        [GENERIC]: {code: GENERIC, name: '通用报修', family: '行政/杂项', category: 'misc', line: DEPT, records: []},
        [CROSS]: {code: CROSS, name: '跨车间设备', family: '其它类别', category: 'prod', line: '测试车间乙', records: [clone(record)]},
        'EQ-UNASSIGNED': {code: 'EQ-UNASSIGNED', name: '未分车间', category: 'misc', records: []},
        'EQ-XSS': {code: 'EQ-XSS', name: '<img src=x onerror=BAD_NAME>', number: '<b>BAD_NUMBER</b>', family: '<svg onload=BAD_FAMILY>', category: 'prod', line: DEPT, records: []}
    };
}
const controls = ['rc-find', 'rc-target', 'rc-symptom', 'rc-place', 'rc-reason', 'rc-save', 'rc-cancel'];
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function freshVM(role = 'admin') {
    const document = makeDocument(), calls = {correct: [], save: [], get: [], confirm: [], forbidden: []};
    let resolve, reject;
    const response = new Promise((yes, no) => { resolve = yes; reject = no; });
    const all = fixture();
    const apiUser = {name: '当前测试人', account: 'offline', dept: DEPT};
    const api = {
        user: () => apiUser,
        correctReport(code, id, payload) { calls.correct.push(clone({code, id, payload})); return response; },
        save(...args) { calls.save.push(args); throw new Error('Whole-equipment save is forbidden in correction UI'); },
        getDevice(code) { calls.get.push(code); return Promise.resolve({ok: true, role, equipment: clone(all[code])}); },
        groupOrderGet: () => Promise.resolve({ok: true, data: {}}),
        myList: () => Promise.resolve({ok: true, dept: DEPT, generic: GENERIC, equipments: clone(all)})
    };
    const forbidden = name => () => { calls.forbidden.push(name); throw new Error(name + ' forbidden in offline UI regression'); };
    const storage = {getItem: () => null, setItem() {}, removeItem() {}};
    const sandbox = {
        console, Promise, document, EquipApi: api, localStorage: storage, sessionStorage: storage,
        setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        location: {origin: 'https://offline.invalid', pathname: '/equipment/index.html', search: ''},
        history: {replaceState() {}}, scrollTo() {}, innerWidth: 1200,
        confirm(message) { calls.confirm.push(String(message)); return sandbox.confirmValue; }, confirmValue: true,
        alert: forbidden('Alert'), prompt: forbidden('Prompt'), fetch: forbidden('Network'),
        XMLHttpRequest: forbidden('XMLHttpRequest'), WebSocket: forbidden('WebSocket'),
        print: forbidden('Printing'), open: forbidden('Window/download'),
        navigator: {}, addEventListener() {}
    };
    sandbox.window = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(app, ctx, {filename: 'docs/equipment/js/equipment-app.js'});
    const run = source => vm.runInContext(source, ctx);
    run('ROLE=' + JSON.stringify(role) + ';MY_DEPT=' + JSON.stringify(DEPT) + ';MY_GENERIC=' + JSON.stringify(GENERIC) + ';EQ=' + JSON.stringify(all) + ';currentCode=' + JSON.stringify(SOURCE) + ';tlYear=2026;tlMonth=0;tlYearOnly=true;');
    const t = {
        run, calls, sandbox, document, apiUser, reject, el: id => document.getElementById(id),
        resolve(value) { if (value && value.ok && value.equipments) Object.assign(all, clone(value.equipments)); resolve(value); },
        open(id = 'open-other') { return run('openReportCorrection(' + JSON.stringify(id) + ')'); },
        fields(values = {}) { for (const [key, value] of Object.entries({target: TARGET, symptom: '新现象', place: '新位置', reason: '选错设备', ...values})) t.el('rc-' + key).value = value; },
        event(id, type) {
            const node = t.el(id), handler = node && node.getAttribute('on' + type);
            if (node && node.disabled) return;
            sandbox.__eventNode = node; sandbox.__event = {type, target: node, preventDefault() {}};
            if (handler) run('(function(event){' + handler + '}).call(__eventNode,__event)');
            for (const fn of node && node.listeners[type] || []) fn.call(node, sandbox.__event);
        },
        snapshot() { return clone(run('EQ')); },
        context() { return clone(run('reportCorrection')); },
        selected() { return t.el('rc-target').options.map(o => ({value: o.value, text: o.textContent})); }
    };
    return t;
}
function correctionLinks(markup) { return [...markup.matchAll(/onclick="openReportCorrection\((?:decodeURIComponent\()?'([^']+)'\)?\)"/g)].map(m => decodeURIComponent(decode(m[1]))); }
function serverSuccess(t, target = TARGET) {
    const map = t.snapshot(), rec = map[SOURCE].records.find(r => r.id === 'open-other');
    rec.symptom = '服务端最终现象'; rec.place = '服务端最终位置'; rec.serverOnly = 'authoritative';
    if (target !== SOURCE) { map[SOURCE].records = map[SOURCE].records.filter(r => r.id !== rec.id); map[target].records.unshift(rec); }
    map[SOURCE]._recordsRev = 'server-source-rev'; map[target]._recordsRev = 'server-target-rev';
    map[SOURCE].serverTag = 'source-authoritative'; map[target].serverTag = 'target-authoritative';
    return {ok: true, code: target, source_code: SOURCE, no: rec.no, moved: target !== SOURCE, equipments: {[SOURCE]: map[SOURCE], [target]: map[target]}};
}

async function main() {
    await suite('real HTML correction page and event hooks', () => {
        const d = makeDocument(), page = d.getElementById('view-correct');
        check('HTML: correction page exists as a view', !!page && page.classList.contains('view'));
        for (const id of ['rc-source', 'rc-target-info', ...controls]) check('HTML: unique actual element ' + id, d.querySelectorAll('#' + id).length === 1 && page && page.contains(d.getElementById(id)));
        check('HTML: target is a native select', d.getElementById('rc-target') && d.getElementById('rc-target').tagName === 'SELECT');
        for (const [id, event, handler] of [['rc-find', 'input', 'filterCorrectionTargets'], ['rc-target', 'change', 'drawReportCorrectionTarget'], ['rc-save', 'click', 'submitReportCorrection'], ['rc-cancel', 'click', 'cancelReportCorrection']]) check('HTML: ' + id + ' wires real ' + handler, new RegExp('\\b' + handler + '\\s*\\(').test(d.getElementById(id) && d.getElementById(id).getAttribute('on' + event) || ''));
        const t = freshVM();
        for (const name of ['canCorrectReport', 'openReportCorrection', 'filterCorrectionTargets', 'drawReportCorrectionTarget', 'submitReportCorrection', 'cancelReportCorrection', 'renderCorrections']) check('APP exports ' + name, t.run('typeof ' + name) === 'function');
    });

    for (const role of ['admin', 'reporter', 'repairer', 'view', 'none']) await suite('permission matrix ' + role, () => {
        const t = freshVM(role);
        for (const id of ['open-other', 'second', 'done', 'open-doneAt', 'legacy-done', 'legacy-open']) {
            const expected = role === 'admin' || role === 'reporter' && ['open-other', 'second', 'legacy-open'].includes(id);
            check(role + ' canCorrect ' + id, t.run('canCorrectReport(EQ[' + JSON.stringify(SOURCE) + '],EQ[' + JSON.stringify(SOURCE) + '].records.find(function(r){return r.id===' + JSON.stringify(id) + '}))') === expected);
        }
        check(role + ' cross-department source policy', t.run('canCorrectReport(EQ[' + JSON.stringify(CROSS) + '], EQ[' + JSON.stringify(CROSS) + '].records[0])') === (role === 'admin'));
        if (role === 'reporter') {
            t.apiUser.dept = ''; t.run('MY_DEPT=""');
            check('reporter empty department is not a wildcard', t.run('canCorrectReport(EQ[' + JSON.stringify(SOURCE) + '], EQ[' + JSON.stringify(SOURCE) + '].records[0])') === false);
        }
    });

    for (const role of ['admin', 'reporter']) await suite('open captures immutable fields and target list ' + role, () => {
        const t = freshVM(role), before = t.snapshot(); t.open();
        check(role + ' opening shows correction view', t.el('view-correct').classList.contains('show'));
        const context = t.context();
        check(role + ' opening captures exact expected snapshot', context && context.code === SOURCE && context.id === 'open-other' && same(context.expected, {symptom: '原现象', place: '原位置'}) && context.busy === false);
        check(role + ' prefilled editable fields and cleared reason/search', t.el('rc-symptom').value === '原现象' && t.el('rc-place').value === '原位置' && t.el('rc-reason').value === '' && t.el('rc-find').value === '');
        check(role + ' source is initial target', t.el('rc-target').value === SOURCE);
        check(role + ' source context contains immutable work order', t.el('rc-source').textContent.includes('WX20261028-0007') && t.el('rc-source').textContent.includes(SOURCE));
        const values = t.selected().map(o => o.value).filter(Boolean);
        const expectedCodes = Object.keys(before).filter(c => role === 'admin' || before[c].line === DEPT).sort();
        check(role + ' only existing authorized EQ codes offered incl GEN', same(values.slice().sort(), expectedCodes));
        for (const option of t.selected().filter(o => o.value && before[o.value])) {
            const e = before[option.value];
            check(role + ' option searchable identity ' + option.value, option.text.includes(option.value) && (!e.family || option.text.includes(e.family)) && (!e.line || option.text.includes(e.line)));
        }
        check(role + ' labels escape hostile name/category markup', !/<(?:img|svg)\b/i.test(t.el('rc-target').innerHTML) && t.el('rc-target').innerHTML.includes('&lt;'));
        check(role + ' open does not mutate EQ or call API', same(t.snapshot(), before) && t.calls.correct.length === 0 && t.calls.save.length === 0);
        t.run('EQ[' + JSON.stringify(SOURCE) + '].records[0].symptom="并发改变"');
        check(role + ' expected snapshot does not alias live record', t.context().expected.symptom === '原现象');
    });
    await suite('historical empty place opens as exact empty expected', () => {
        const t = freshVM('reporter'); t.open('legacy-open');
        check('missing historical place snapshots empty string', t.context().expected.place === '' && t.el('rc-place').value === '');
    });
    for (const role of ['repairer', 'view', 'none']) await suite('denied open cannot expose correction UI ' + role, () => {
        const t = freshVM(role), before = t.snapshot(); t.open();
        check(role + ' denied open remains outside correction view', !t.el('view-correct').classList.contains('show'));
        check(role + ' denied open has no context or writes', t.context() === null && same(t.snapshot(), before) && t.calls.correct.length === 0 && t.calls.save.length === 0);
    });
    for (const id of ['done', 'open-doneAt', 'legacy-done', 'missing']) await suite('reporter denied open ' + id, () => {
        const t = freshVM('reporter'); t.open(id);
        check('reporter denied ' + id + ' leaves no context', t.context() === null && !t.el('view-correct').classList.contains('show') && t.calls.correct.length === 0);
    });

    await suite('native select search preserves selected target and detail escapes', () => {
        const t = freshVM(); t.open(); t.el('rc-target').value = TARGET; t.event('rc-target', 'change');
        check('target detail displays selected real code and department', t.el('rc-target-info').textContent.includes(TARGET) && t.el('rc-target-info').textContent.includes(DEPT));
        t.el('rc-find').value = '完全不匹配的搜索'; t.event('rc-find', 'input');
        check('search never silently changes selected target', t.el('rc-target').value === TARGET);
        check('nonmatching search retains selected option', t.selected().some(o => o.value === TARGET));
        t.el('rc-find').value = '给排水'; t.event('rc-find', 'input');
        check('family search still offers matching target', t.selected().some(o => o.value === TARGET));
        check('search removes unrelated choices except retained selected', !t.selected().some(o => o.value === CROSS));
        t.el('rc-find').value = ''; t.event('rc-find', 'input');
        check('clearing search restores authorized list and retains choice', t.selected().filter(o => o.value).length === Object.keys(fixture()).length && t.el('rc-target').value === TARGET);
        t.el('rc-target').value = 'EQ-XSS'; t.event('rc-target', 'change');
        check('target info never interpolates executable hostile labels', !/<(?:img|svg|b)\b/i.test(t.el('rc-target-info').innerHTML) && t.el('rc-target-info').textContent.includes('<img'));
    });

    for (const field of ['symptom', 'place']) await suite('blank trimmed ' + field + ' rejected before request', async () => {
        const t = freshVM(); t.open(); t.fields({[field]: ' \n\t '}); const before = t.snapshot();
        t.event('rc-save', 'click'); await flush();
        check('blank ' + field + ' does not call correction or whole save', t.calls.correct.length === 0 && t.calls.save.length === 0);
        check('blank ' + field + ' leaves dialog/context/data intact', t.context() && !t.context().busy && t.el('view-correct').classList.contains('show') && same(t.snapshot(), before));
        check('blank ' + field + ' gives user feedback', !!t.el('toast').textContent);
    });
    await suite('optional correction reason is trimmed to empty', async () => {
        const t = freshVM(); t.open(); t.fields({reason: ' \n\t '}); t.run('submitReportCorrection()'); await flush();
        check('optional blank reason does not block valid correction', t.calls.correct.length === 1 && t.calls.save.length === 0);
        check('optional blank reason sent as exact empty string', t.calls.correct[0] && t.calls.correct[0].payload.reason === '');
        t.resolve({ok: false, msg: '离线预期失败'}); await flush();
    });
    await suite('missing target rejected before request', async () => {
        const t = freshVM(); t.open(); t.fields({target: 'NOT-IN-EQ'}); t.run('submitReportCorrection()'); await flush();
        check('invalid native-select target is rejected without API', t.calls.correct.length === 0 && t.calls.save.length === 0);
    });
    await suite('moving confirmation cancel is a clean no-op', async () => {
        const t = freshVM(); t.open(); t.fields(); t.sandbox.confirmValue = false; const before = t.snapshot();
        t.run('submitReportCorrection()'); await flush();
        check('move asks confirmation mentioning original immutable no', t.calls.confirm.length === 1 && t.calls.confirm[0].includes('WX20261028-0007'));
        check('cancelled move leaves context/values/unlocked controls', t.context() && !t.context().busy && t.el('rc-target').value === TARGET && controls.every(id => !t.el(id).disabled));
        check('cancelled move neither mutates nor calls any save', same(t.snapshot(), before) && t.calls.correct.length === 0 && t.calls.save.length === 0);
    });
    await suite('trimmed exact API payload uses opening snapshot', async () => {
        const t = freshVM(); t.open(); t.fields({symptom: ' \n更正现象\t ', place: '  新位置  ', reason: '  选错设备  '});
        t.run('EQ[' + JSON.stringify(SOURCE) + '].records[0].symptom="别人并发改了"');
        t.run('submitReportCorrection()'); await flush();
        check('one precise correctReport call, no full save', t.calls.correct.length === 1 && t.calls.save.length === 0);
        check('API exact payload has trimmed fields and original expected', same(t.calls.correct[0], {code: SOURCE, id: 'open-other', payload: {targetCode: TARGET, symptom: '更正现象', place: '新位置', reason: '选错设备', expected: {symptom: '原现象', place: '原位置'}}}));
        t.resolve({ok: false, msg: '离线预期失败'}); await flush();
    });

    await suite('pending prevents double submit, cancel and context replacement', async () => {
        const t = freshVM(); t.open(); t.fields(); const before = t.snapshot(); t.run('submitReportCorrection()');
        check('pending marks context busy and locks every editable/action control', t.context().busy === true && controls.every(id => t.el(id).disabled));
        check('pending leaves local data unmodified until server success', same(t.snapshot(), before));
        const pending = t.context();
        t.run('submitReportCorrection();cancelReportCorrection();openReportCorrection("second");'); await flush();
        check('pending duplicate calls never send a second API request', t.calls.correct.length === 1);
        check('pending cancellation/open cannot change in-flight context', same(t.context(), pending) && t.el('view-correct').classList.contains('show'));
        t.resolve({ok: false, msg: '版本已变化，请刷新后重试'}); await flush();
        check('server failure clears busy and unlocks all controls', t.context() && t.context().busy === false && controls.every(id => !t.el(id).disabled));
        check('server failure keeps attempted field values', t.el('rc-target').value === TARGET && t.el('rc-symptom').value === '新现象' && t.el('rc-place').value === '新位置' && t.el('rc-reason').value === '选错设备');
        check('server failure remains in dialog with visible error', t.el('view-correct').classList.contains('show') && t.el('toast').textContent.includes('版本已变化'));
        check('failure never retries or writes local/full equipment data', t.calls.correct.length === 1 && t.calls.save.length === 0 && same(t.snapshot(), before));
    });
    await suite('rejected API promise retains form and does not retry', async () => {
        const t = freshVM(); t.open(); t.fields(); const before = t.snapshot(); t.run('submitReportCorrection()');
        t.reject(new Error('离线异常测试')); await flush();
        check('exception unlocks controls and retains correction context', t.context() && !t.context().busy && controls.every(id => !t.el(id).disabled));
        check('exception retains values, visible error and no auto retry', t.el('rc-reason').value === '选错设备' && !!t.el('toast').textContent && t.calls.correct.length === 1 && t.calls.save.length === 0);
        check('exception is zero local data mutation', same(t.snapshot(), before));
    });

    for (const role of ['admin', 'reporter']) for (const target of [TARGET, SOURCE, GENERIC]) await suite('server-authoritative success ' + role + ' to ' + target, async () => {
        const t = freshVM(role); t.open(); t.fields({target}); const before = t.snapshot();
        t.run('window.__untouched=EQ[' + JSON.stringify(CROSS) + ']');
        const result = serverSuccess(t, target);
        t.run('submitReportCorrection()'); t.resolve(result); await flush();
        const after = t.snapshot();
        check(role + '/' + target + ' success merges actual code-keyed server map exactly', Object.keys(result.equipments).every(c => same(after[c], result.equipments[c])));
        check(role + '/' + target + ' success preserves unreturned EQ objects by identity', same(after[CROSS], before[CROSS]) && t.run('EQ[' + JSON.stringify(CROSS) + ']===window.__untouched'));
        check(role + '/' + target + ' no bogus source/target placeholder keys', !Object.prototype.hasOwnProperty.call(after, 'source') && !Object.prototype.hasOwnProperty.call(after, 'target'));
        check(role + '/' + target + ' clears context and displays exact target', t.context() === null && t.run('currentCode') === target && t.el('view-list').classList.contains('show') && t.el('detail-content').innerHTML.includes('服务端最终现象'));
        check(role + '/' + target + ' preserves original record id and no in rendered target', after[target].records.some(r => r.id === 'open-other' && r.no === 'WX20261028-0007') && t.el('detail-content').innerHTML.includes('WX20261028-0007'));
        check(role + '/' + target + ' no full save; only permitted target read for reporter', t.calls.correct.length === 1 && t.calls.save.length === 0 && (role === 'admin' ? t.calls.get.length === 0 : same(t.calls.get, [target])));
        check(role + '/' + target + ' confirms only device moves, never same-device edits', t.calls.confirm.length === (target === SOURCE ? 0 : 1));
        if (target !== SOURCE) check(role + '/' + target + ' move has one source removal one target insertion', !after[SOURCE].records.some(r => r.id === 'open-other') && after[target].records.filter(r => r.id === 'open-other').length === 1);
        if (target === SOURCE) check(role + ' same-device update keeps stable record ordering', same(after[SOURCE].records.map(r => r.id), before[SOURCE].records.map(r => r.id)));
    });
    await suite('idle cancel discards context without any write', () => {
        const t = freshVM(); t.open(); t.fields(); const before = t.snapshot(); t.event('rc-cancel', 'click');
        check('cancel clears correction context and closes dialog', t.context() === null && !t.el('view-correct').classList.contains('show'));
        check('cancel never sends correction/save or mutates records', t.calls.correct.length === 0 && t.calls.save.length === 0 && same(t.snapshot(), before));
    });

    for (const role of ['admin', 'repairer', 'reporter', 'view', 'none']) await suite('timeline authorization ' + role, () => {
        const t = freshVM(role);
        if (role === 'reporter' || role === 'view' || role === 'none') t.run('renderLimitedDetail(EQ[' + JSON.stringify(SOURCE) + '],ROLE)');
        else t.run('renderManageDetail(EQ[' + JSON.stringify(SOURCE) + '])');
        const links = correctionLinks(t.el('detail-content').innerHTML).sort();
        const expected = role === 'admin' ? fixture()[SOURCE].records.map(r => r.id).sort() : role === 'reporter' ? ['legacy-open', 'open-other', 'second'] : [];
        check(role + ' correction actions exactly follow canCorrectReport', same(links, expected));
        check(role + ' action label appears only when allowed', t.el('detail-content').innerHTML.includes('更正报修') === !!expected.length);
    });
    await suite('aggregate action uses its own device instead of stale currentCode', () => {
        const t = freshVM('reporter');
        t.run('currentCode=' + JSON.stringify(CROSS) + ';renderMineAll()');
        const buttons = t.el('all-list').querySelectorAll('.correction-act');
        check('aggregate actions omit closed and cross-department records', buttons.length === 3);
        const button = buttons.find(b => (b.getAttribute('onclick') || '').includes("'" + SOURCE + "'") && b.getAttribute('onclick').includes("'open-other'"));
        check('aggregate has a device-qualified action for the own-workshop record', !!button && /openReportCorrectionForDevice\(/.test(button.getAttribute('onclick')));
        if (!button) return;
        t.run(button.getAttribute('onclick'));
        check('aggregate action captures correct source/id despite stale currentCode', t.context() && t.context().code === SOURCE && t.context().id === 'open-other' && t.run('currentCode') === SOURCE);
        check('aggregate action opens real dialog without an API mutation', t.el('view-correct').classList.contains('show') && t.calls.correct.length === 0 && t.calls.save.length === 0);
    });
    for (const key of ['_corrections', 'corrections']) await suite('safe correction history rendering ' + key, () => {
        const t = freshVM('reporter');
        const h = {at: '<time onmouseover=BAD_AT>2026</time>', by: '<b>BAD_BY</b>', summary: '<svg onload=BAD_SUMMARY>', reason: '<img src=x onerror=BAD_REASON>', oldcost: 987654321, unknown: 'PRIVATE_UNKNOWN', old: {cost: 'PRIVATE_OLD_COST'}, new: {cost: 'PRIVATE_NEW_COST'}};
        t.sandbox.__historyRecord = {[key]: [h]};
        const rendered = t.run('renderCorrections(window.__historyRecord)');
        check(key + ' shows escaped at/by/summary/reason', typeof rendered === 'string' && ['&lt;time', '&lt;b&gt;BAD_BY', '&lt;svg', '&lt;img'].every(s => rendered.includes(s)));
        check(key + ' never inserts executable history tags', !/<(?:time|b|svg|img)\b/i.test(rendered));
        check(key + ' excludes arbitrary fields and cost snapshots', !/987654321|PRIVATE_UNKNOWN|PRIVATE_OLD_COST|PRIVATE_NEW_COST|oldcost|unknown/.test(rendered));
        check(key + ' no history returns empty string', t.run('renderCorrections({})') === '');
        t.run('EQ[' + JSON.stringify(SOURCE) + '].records[0][' + JSON.stringify(key) + ']=window.__historyRecord[' + JSON.stringify(key) + '];renderLimitedDetail(EQ[' + JSON.stringify(SOURCE) + '],"reporter")');
        check(key + ' reporter timeline includes safe history', t.el('detail-content').innerHTML.includes('&lt;img src=x onerror=BAD_REASON&gt;'));
        t.run('ROLE="admin";renderManageDetail(EQ[' + JSON.stringify(SOURCE) + '])');
        check(key + ' management timeline includes safe history', t.el('detail-content').innerHTML.includes('&lt;img src=x onerror=BAD_REASON&gt;'));
        t.run('ROLE="reporter";renderMineAll()');
        check(key + ' workshop aggregate timeline includes safe history', t.el('all-list').innerHTML.includes('&lt;img src=x onerror=BAD_REASON&gt;'));
    });
    console.log('Report correction UI: ' + passed + ' passed / ' + failed + ' failed / ' + (passed + failed) + ' assertions in ' + suites + ' suites.');
    console.log('Complete real APP + actual HTML in VM; fake DOM/API only. No network, SDK/database, login, hardware, printing or live-browser verification.');
    for (const failure of failures) console.error('FAIL ' + failure);
    if (failed) process.exitCode = 1;
}
main().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
