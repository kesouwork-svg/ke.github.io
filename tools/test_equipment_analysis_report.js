'use strict';
const assert = require('node:assert/strict');
const report = require('../docs/equipment/js/equipment-analysis-report');
const XLSX = require('../docs/equipment/js/xlsx.mini.min.js');
const charts = require('../docs/equipment/js/equipment-report-charts');

const {periods} = report;
function dates(type, value, day) {
    const p = periods(type, value, day);
    return [p.start, p.end, p.priorStart, p.priorEnd];
}
assert.deepEqual(dates('month','2024-03','2024-03-30'), ['2024-03-01','2024-03-30','2024-02-01','2024-02-29']);
assert.deepEqual(dates('month','2024-02','2024-03-30'), ['2024-02-01','2024-02-29','2024-01-01','2024-01-31']);
assert.deepEqual(dates('year','2024','2024-02-29'), ['2024-01-01','2024-02-29','2023-01-01','2023-02-28']);
assert.deepEqual(dates('year','2023','2024-02-29'), ['2023-01-01','2023-12-31','2022-01-01','2022-12-31']);
assert.throws(() => periods('month','2024-04','2024-03-31'));

function fault(id, reportAt, doneAt, extra) {
    return {id, no: 'WO-' + id, type:'fault', reportAt, doneAt, status:doneAt ? 'done' : 'open',
        cause1:'A',cause2:'B',cause3:'C',repairMode:'inner',cost:0,...extra};
}
const late = fault('late','2024-02-28','2024-03-02',{cost:'45.50', repairMode:'outer', supplier:'外协甲', expectedAt:'2024-03-01', delayReason:'配件延时'});
const equipment = {'A & B':{name:'机床',line:'生产',family:'机床',records:[
    fault('prev','2024-02-01','2024-02-27'),late,{...late},fault('again','2024-03-05','2024-03-05',{cost:null,symptom:'=1+1'}),
    fault('old-open','2023-11-01',''),fault('future-done','2024-03-08','2024-04-02',{cost:999}),
    fault('exclude','2024-03-05','2024-03-06',{type:'maintain'})]},
    X:{line:'外部',family:'机床',records:[late]}};
function workbook(type,value,department='生产') {
    const wb=report.build(XLSX,equipment,{type,value,department,family:'机床',asOf:'2024-04-10',loadedAt:'2024-04-10 14:00:00'});
    const bytes = charts.bytes(XLSX,wb), archive = XLSX.CFB.read(bytes,{type:'buffer'});
    assert.equal(new Set(archive.FullPaths).size, archive.FullPaths.length, 'package entries must have unique paths');
    for (const [i,name] of wb.SheetNames.entries()) {
        const spec = wb.Sheets[name]['!reportChart'];
        const entry = XLSX.CFB.find(archive,'/xl/charts/chart' + (i+1) + '.xml');
        assert.equal(!!entry,!!spec);
        if (spec) {
            const source = wb.Sheets[spec.source];
            assert.ok(source[spec.cat + spec.first]);
            assert.ok(source[spec.cat + (spec.first + spec.n - 1)]);
            assert.ok(Buffer.from(entry.content).toString().includes('strRef'));
        }
    }
    return XLSX.read(bytes,{type:'buffer',cellNF:true});
}
function rows(wb,name) { return XLSX.utils.sheet_to_json(wb.Sheets[name],{header:1,raw:true,defval:null}); }
function find(rows,label) { return rows.find(row=>row[0]===label); }
const month = workbook('month','2024-03');
assert.deepEqual(month.SheetNames,['报表摘要','期间趋势','重点设备与故障分析','内部维修与外协','工单明细','统计口径与待核']);
function trendRows(wb) { return rows(wb,'期间趋势').filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row[0])); }
const summary=rows(month,'报表摘要'), orders=rows(month,'工单明细').slice(1), trend=trendRows(month);
assert.equal(orders.length,3);
assert.deepEqual(orders.map(row=>[row[0],row[5],row[6],row[13]]),[['WO-late',0,1,45.5],['WO-again',1,1,null],['WO-future-done',1,0,null]]);
for (const [label,column] of [['新增故障（单）',2],['完成故障（单）',3],['登记费用（元）',4],['延期完成（单）',6],['疑似重复报修（单）',7]]) {
    assert.equal(find(summary,label)[1],trend.reduce((sum,row)=>sum+(row[column]||0),0));
}
assert.equal(month.Sheets['工单明细'].L3.t,'s');
assert.equal(month.Sheets['工单明细'].L3.f,undefined);
// This bundled reader leaves XML entities in relationship targets; Excel resolves them.
assert.equal(month.Sheets['工单明细'].A2.l.Target.replace(/&amp;/g,'&'),'https://kekits.com/equipment/index.html?code=A%20%26%20B&wo=WO-late');
assert.equal(find(rows(month,'内部维修与外协'),'外协供应商')[4],45.5);
assert.equal(find(rows(month,'统计口径与待核'),'WO-old-open')[1],'A & B');
const annual=workbook('year','2024'), annualSummary=rows(annual,'报表摘要');
assert.equal(find(annualSummary,'平均处理周期（天）')[1],(26+3+0+25)/4);
assert.equal(find(annualSummary,'登记费用（元）')[2],'无可比数据');
assert.equal(trendRows(annual).length,4);
const marchDelivery = rows(annual,'内部维修与外协').filter(row=>row[0]==='分月维修方式' && row[10]==='2024-03');
assert.equal(marchDelivery.reduce((sum,row)=>sum+row[2],0),2);
assert.equal(marchDelivery.reduce((sum,row)=>sum+(row[4]||0),0),45.5);
assert.equal(find(rows(workbook('month','2024-02'),'报表摘要'),'疑似重复报修（单）')[1],1);
assert.equal(rows(workbook('year','2024','其他'),'工单明细').length,1);
console.log('Report period boundaries, filters, eligibility, hyperlinks and XLSX reconciliation passed.');
