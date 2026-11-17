'use strict';
// Deterministic delivery-analysis contracts: synthetic inputs, no network or business writes.
const assert = require('node:assert/strict');
const core = require('../docs/equipment/js/equipment-analysis-core');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS ' + name); }
const record = (id, extra = {}) => ({ id, no: 'SYN-' + id, type: 'fault', status: 'done', reportAt: '2026-10-01', doneAt: '2026-10-03',
    expectedAt: '2026-10-02T12:00', repairMode: 'inner', handler: '员工甲', supplier: '', cost: 10, ...extra });
const options = { asOf: '2026-10-31', start: '2026-10-01', end: '2026-10-31' };
function analyze(records, extra = {}, equipment = {}) {
    const input = { A: { name: '合成设备', line: '合成部', family: '合成类', records, ...equipment } };
    const before = JSON.stringify(input), result = core.analyze(input, { ...options, ...extra });
    assert.equal(JSON.stringify(input), before); return result;
}
const fixture = [record('inner'), record('outer', { repairMode: 'outer', handler: '员工甲', supplier: '外协甲', cost: 100 }),
    record('conflict', { supplier: '外协乙' }), record('missing', { repairMode: '' }), record('blank-supplier', { repairMode: 'outer', supplier: '' })];
check('mode totals partition all completed records without duplicate employee credit', () => {
    const r = analyze(fixture).services;
    assert.deepEqual(r.modes.map(g => g.count), [1, 2, 2]); assert.equal(r.total, 5);
    assert.equal(r.employees[0].count, 1); assert.equal(r.suppliers.reduce((n, g) => n + g.count, 0), 2);
    assert(r.modes[2].records.some(r => r.issues.includes('内部维修与外协名称矛盾')));
});
check('only valid completion dates in period and explicit status count', () => {
    const r = analyze([record('ok', { reportAt: '2025-01-01' }), record('open', { status: 'open' }), record('past', { doneAt: '2026-09-30' }), record('bad', { doneAt: '2026-02-30' }), record('none', { doneAt: '' })]);
    assert.equal(r.services.total, 1); assert.equal(r.services.total, r.summary.completedCount);
});
check('optional type affects only delivery section', () => {
    const rows = [record('fault'), record('maintain', { type: 'maintain' })];
    const a = analyze(rows), b = analyze(rows, { serviceType: 'maintain' });
    assert.deepEqual(a.summary, b.summary); assert.equal(a.services.modes[0].records[0].recordId, 'fault');
    assert.equal(b.services.modes[0].records[0].recordId, 'maintain');
    assert.throws(() => analyze(rows, { serviceType: 'unknown' }));
});
check('department and family filters also constrain employees and suppliers', () => {
    for (const opts of [{ department: '其他部' }, { family: '其他类' }]) assert.equal(analyze(fixture, opts).services.total, 0);
});
check('zero, missing and invalid amounts have separate denominators', () => {
    const g = analyze([record('zero', { cost: 0 }), record('money', { cost: '20' }), record('null', { cost: null }), record('bad', { cost: -1 })]).services.modes[0];
    assert.equal(g.registeredAmount, 20); assert.equal(g.averageAmount, 10); assert.equal(g.amountN, 2); assert.equal(g.zeroAmountN, 1);
    assert.equal(g.issueCount, 3);
    const empty = analyze([record('no', { cost: null })]).services.modes[0]; assert.equal(empty.registeredAmount, null); assert.equal(empty.averageAmount, null);
});
check('cycles exclude missing/reversed reports, delays exclude invalid/reversed deadlines', () => {
    const g = analyze([record('valid'), record('no-report', { reportAt: '' }), record('reverse', { reportAt: '2026-10-04' }),
        record('no-due', { expectedAt: '' }), record('reverse-due', { expectedAt: '2026-09-30' })]).services.modes[0];
    assert.equal(g.cycleN, 3); assert.equal(g.cycleDays, 2); assert.equal(g.dueN, 2); assert.equal(g.delayedCount, 2); assert.equal(g.delayedRate, 1);
});
check('same-day minute deadline does not invent completion time', () => {
    const g = analyze([record('same', { expectedAt: '2026-10-03T09:00' })]).services.modes[0];
    assert.equal(g.delayedCount, 0); assert.equal(g.dueN, 1);
});
check('names trim only; joint names stay a single group; prototype keys safe', () => {
    const r = analyze([record('a', { handler: ' 员工甲 ' }), record('b'), record('c', { handler: '员工甲、员工乙' }), record('d', { handler: '__proto__' })]).services;
    assert.equal(r.employees.find(g => g.label === '员工甲').count, 2); assert.equal(r.employees.length, 3);
});
check('same content duplicate excluded, conflicting ID excluded, GEN contributes as card', () => {
    const a = record('duplicate'), b = record('conflict');
    const r = analyze([a, { ...a }, b, { ...b, cost: 999 }]); assert.equal(r.services.total, 1);
    const gen = core.analyze({ 'GEN-A': { records: [record('gen')] } }, options); assert.equal(gen.services.total, 1); assert.equal(gen.services.employees[0].equipmentCount, 1);
});
check('input accessors are never invoked and no arbitrary data is copied', () => {
    const r = record('getter'); Object.defineProperty(r, 'handler', { get() { throw Error('getter forbidden'); } });
    r.privateToken = 'must-not-copy'; const result = core.analyze({ A: { records: [r] } }, options); assert(!JSON.stringify(result).includes('must-not-copy'));
    assert(result.services.employees[0].records[0].issues.includes('内部维修人未填'));
});
console.log(passed + ' service analysis scenarios passed / 0 failed');
