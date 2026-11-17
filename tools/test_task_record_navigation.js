'use strict';
// Synthetic/offline integration of the real task filters, selection and timeline renderer.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), elements = {}, store = {};
let scrolled = 0, passed = 0;
const element = () => ({ value: '', innerHTML: '', textContent: '', style: {}, hidden: false,
    classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, addEventListener() {},
    querySelector() { return null; }, scrollIntoView() { scrolled++; } });
const storage = { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
const sandbox = { console, Promise, setTimeout: () => 0, clearTimeout() {}, localStorage: storage, sessionStorage: storage,
    location: { search: '', pathname: '/equipment/' }, navigator: {}, addEventListener() {}, scrollTo() {},
    document: { getElementById: id => elements[id] || (elements[id] = element()), querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
    fetch() { throw Error('Business network forbidden'); }, print() { throw Error('Printing forbidden'); } };
sandbox.window = sandbox;
const ctx = vm.createContext(sandbox), run = s => vm.runInContext(s, ctx);
for (const file of ['docs/equipment/js/equipment-time.js', 'docs/js/session.js', 'docs/equipment/js/equipment-api.js', 'docs/equipment/js/equipment-app.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx, { filename: file });
}
for (const id of ['f-q', 'f-line', 'f-cat', 'detail-content', 'list-task-notice', 'detail-task-notice']) sandbox.document.getElementById(id);
const records = [
    { id: 'old-open', no: 'WO-OPEN', status: 'open', reportAt: '2020-01-01', symptom: 'OLD OPEN' },
    { id: 'old-pending', no: 'WO-PENDING', status: 'done', doneAt: '2020-02-01', symptom: 'OLD PENDING' },
    { id: 'old-normal', no: 'WO-NORMAL', status: 'done', doneAt: '2020-03-01', cause3: 'normal', symptom: 'NORMAL HISTORY' },
    { id: 'delayed', no: 'WO-DELAY', status: 'done', doneAt: '2020-04-03', expectedAt: '2020-04-01T09:00', cause3: 'normal', symptom: 'MISSING DELAY REASON' }
];
const fixture = { A: { code: 'A', name: 'Synthetic A', line: '测试部', records }, B: { code: 'B', name: 'Synthetic B', line: '其他部', records: records.slice(0, 1) } };
run('ROLE="admin"; EQ=' + JSON.stringify(fixture) + '; EquipApi.getDevice=function(code){return Promise.resolve({ok:true,role:ROLE,equipment:EQ[code]})};');
const html = () => elements['detail-content'].innerHTML;
function check(name, f) { f(); passed++; console.log('PASS ' + name); }
async function settle() { await Promise.resolve(); await Promise.resolve(); }
(async () => {
    run('setTaskFilter("open")'); await settle();
    check('click selects first matching device and scrolls to task notice', () => { assert.equal(run('currentCode'), 'A'); assert(scrolled > 0); });
    check('open view includes prior-year work and hides unrelated records with explanation', () => {
        assert(html().includes('OLD OPEN')); assert(!html().includes('OLD PENDING')); assert(!html().includes('NORMAL HISTORY'));
        assert(html().includes('不限年月')); assert(html().includes('其他履历未删除')); assert(html().includes('查看全部履历'));
    });
    check('task list expands matching equipment and keeps global record totals', () => {
        assert(elements['eq-list'].innerHTML.includes('eq-card-sub-item')); assert(html().includes('4 条'));
        assert.equal(elements['list-task-notice'].hidden, false);
    });
    run('setTaskFilter("pending")'); await settle();
    check('pending spans all years and includes missing classification and delay reason', () => {
        assert(html().includes('OLD PENDING')); assert(html().includes('MISSING DELAY REASON')); assert(!html().includes('OLD OPEN')); assert(!html().includes('NORMAL HISTORY'));
        assert(html().includes('待补全 2 条'));
    });
    run('EQ.A.records[1].cause3="fixed"; EQ.A.records[3].delayReason="fixed"; tlRerender()');
    check('finishing last task leaves explicit empty task state', () => { assert(html().includes('已没有此类待处理记录')); assert(html().includes('查看全部履历')); });
    run('showAllDeviceHistory()');
    check('full history restores all dates and clears task list without losing search scope', () => {
        for (const r of records) assert(html().includes(r.symptom));
        assert(html().includes('全部年份')); assert.equal(run('taskFilter'), ''); assert.equal(elements['list-task-notice'].hidden, true);
    });
    elements['f-line'].value = '不存在的部门'; run('setTaskFilter("open")'); await settle();
    check('empty filtered result does not open unrelated equipment', () => { assert.equal(run('currentCode'), ''); assert(elements['list-task-notice'].innerHTML.includes('没有匹配设备')); });
    elements['f-line'].value = '测试部'; run('setTaskFilter("open"); setTaskFilter("open")'); await settle();
    check('selection respects department and uses task view', () => { assert.equal(run('currentCode'), 'A'); assert.equal(run('detailTaskFilter'), 'open'); });
    run('ROLE="repairer"; setTaskFilter("pending")');
    check('repairer cannot enter admin-only pending filter', () => assert.equal(run('taskFilter'), 'open'));
    run('pendingWo="WO-NORMAL"; openDetail("A",true)');
    check('specific work-order navigation overrides task filter and date scope', () => { assert(html().includes('NORMAL HISTORY')); assert.equal(run('detailTaskFilter'), ''); });
    console.log(passed + ' passed / 0 failed (synthetic/offline; no production operations)');
})().catch(e => { console.error(e); process.exitCode = 1; });
