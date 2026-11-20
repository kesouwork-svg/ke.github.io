/* Monthly and annual XLSX reports use the same filtered, deduplicated faults as the analysis page. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./equipment-analysis-core.js'));
    else root.EquipReport = factory(root.EquipAnalysis);
}(typeof window === 'undefined' ? globalThis : window, function (core) {
    'use strict';
    var DAY = 86400000;
    var modes = { inner: '内部维修', outer: '外协维修', unknown: '维修方式待核实' };
    function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }
    function monthOffset(first, months) {
        var date = new Date(core.parseDate(first));
        return date.setUTCMonth(date.getUTCMonth() + months, 1);
    }
    function periods(type, value, asOf) {
        var annual = type === 'year';
        if (!(annual ? /^\d{4}$/.test(value) : type === 'month' && /^\d{4}-\d{2}$/.test(value))) throw Error('请选择有效的报表年月。');
        var start = value + (annual ? '-01-01' : '-01'), first = core.parseDate(start), limit = core.parseDate(asOf);
        if (first === null || limit === null || first > limit) throw Error('请选择数据读取日期以内的月份或年份。');
        var months = annual ? 12 : 1, last = monthOffset(start, months) - DAY;
        var end = iso(Math.min(limit, last)), previous = monthOffset(start, -months);
        var priorStart = iso(previous), priorEnd = iso(first - DAY);
        if (limit < last && priorStart.slice(0, 4) !== '0000') {
            var offset = annual ? Number(end.slice(5, 7)) - 1 : 0;
            priorEnd = iso(Math.min(monthOffset(priorStart, offset + 1) - DAY,
                monthOffset(priorStart, offset) + (Number(end.slice(8)) - 1) * DAY));
        }
        return { type: type, value: value, start: start, end: end, partial: limit < last,
            priorStart: priorStart.slice(0, 4) === '0000' ? null : priorStart, priorEnd: priorEnd };
    }
    function link(order) {
        var target = 'https://kekits.com/equipment/index.html?code=' + encodeURIComponent(order.code);
        if (order.workOrder) target += '&wo=' + encodeURIComponent(order.workOrder);
        return { t: 's', v: order.workOrder || '查看设备履历', l: { Target: target } };
    }
    function decimal(value, format) {
        return value == null ? null : { t: 'n', v: value, z: format || '#,##0.00' };
    }
    function build(XLSX, equipments, options) {
        var p = periods(options.type, options.value, options.asOf);
        var scope = (options.department || '全部部门') + ' · ' + (options.family || '全部设备类别');
        var title = '设备维修' + (p.type === 'year' ? '年报' : '月报');
        function analyze(start, end, detail) {
            return core.analyze(equipments, { start: start, end: end, asOf: options.asOf, asOfTime: options.asOfTime,
                department: options.department, family: options.family, serviceType: 'fault', includeReportOrders: detail });
        }
        var r = analyze(p.start, p.end, true), prev = p.priorStart && analyze(p.priorStart, p.priorEnd, false);
        var comparable = prev && (prev.summary.newCount + prev.summary.completedCount > 0);
        var wb = XLSX.utils.book_new(), s = r.summary, insights = r.faultInsights;
        function sheet(name, rows, widths, filter, header = 1) {
            var ws = XLSX.utils.aoa_to_sheet(rows);
            ws['!cols'] = widths.map(function (wch) { return { wch: wch }; });
            if (filter) ws['!autofilter'] = { ref: 'A' + header + ':' + ws['!ref'].split(':').pop() };
            ws['!reportBands'] = { [header]: 'heading' };
            XLSX.utils.book_append_sheet(wb, ws, name);
            return ws;
        }
        // Reserve space above each data table for an Excel chart and its takeaway.
        function chartSheet(name, rows, widths, filter, caption, chart) {
            var header = chart ? 19 : 4;
            var lead = [[name + ' · ' + p.value], [caption]];
            while (lead.length < header - 1) lead.push([]);
            var ws = sheet(name, lead.concat(rows), widths, filter, header);
            ws['!reportBands'][1] = 'title'; ws['!reportBands'][2] = 'note';
            ws['!merges'] = [1, 2].map(n => XLSX.utils.decode_range('A' + n + ':E' + n));
            ws['!rows'] = [{ hpt: 28 }, { hpt: 32 }];
            if (chart) ws['!reportChart'] = Object.assign({ top: 2, source: name }, chart);
            return header;
        }
        var summary = [[title + '  ' + p.value], ['统计范围', scope], ['统计期间', p.start + ' 至 ' + p.end + (p.partial ? '（截至当日）' : '')],
            ['对比期间', p.priorStart ? p.priorStart + ' 至 ' + p.priorEnd : '无可比期间'],
            ['数据读取时间（北京）', options.loadedAt], [], ['指标', '本期', '上期同期', '增减值', '本期统计说明']];
        function metric(label, current, prior, note, fractional) {
            var valid = comparable && prior != null;
            function display(n) { return n == null ? '无有效样本' : (fractional ? decimal(n) : n); }
            summary.push([label, display(current), valid ? display(prior) : '无可比数据',
                valid && current != null ? display(current - prior) : null, note]);
        }
        var ps = prev ? prev.summary : {}, pi = prev ? prev.faultInsights : {};
        metric('新增故障（单）', s.newCount, ps.newCount, '按报修日期');
        metric('完成故障（单）', s.completedCount, ps.completedCount, '按完成日期');
        metric('登记费用（元）', s.registeredAmount, ps.registeredAmount, '有效 ' + s.amountN + ' 单，零元 ' + s.zeroAmountN + ' 单，缺失或无效 ' + s.unknownAmountN + ' 单', true);
        metric('平均处理周期（天）', s.cycleDays, ps.cycleDays, '有效 ' + s.cycleN + ' 单，按自然日计算', true);
        metric('延期完成（单）', insights.delayedCount,
            ps.completedCount > pi.unknownDeadlineCount ? pi.delayedCount : null, '日期待核 ' + insights.unknownDeadlineCount + ' 单');
        metric('疑似重复报修（单）', insights.repeats.length, prev ? pi.repeats.length : null, '按再次报修日期');
        var hasTrend = s.newCount + s.completedCount > 0;
        var annual = p.type === 'year', trend = [['区间开始', '区间结束', '新增故障', '完成故障', '登记费用（元）', '有效金额单数', '延期完成', '疑似重复报修', '图表期间']];
        var buckets = annual ? r.trends.monthly : r.trends.daily, bucketRows = new Map();
        function bucket(day) { return annual ? day.slice(0, 7) : day; }
        buckets.forEach(function (b) {
            var label = annual ? Number(b.start.slice(5, 7)) + '月' : Number(b.start.slice(8)) + '日';
            var row = [b.start, b.end, b.newCount, b.completedCount, null, 0, 0, 0, label];
            trend.push(row); bucketRows.set(bucket(b.start), row);
        });
        var devices = new Map();
        r.reportOrders.forEach(function (o) {
            if (!o.generic) {
                if (!devices.has(o.code)) devices.set(o.code, { order: o, added: 0, completed: 0, repeats: 0 });
                var device = devices.get(o.code);
                device.added += Number(o.isNew); device.completed += Number(o.isCompleted);
            }
            if (!o.isCompleted) return;
            var row = bucketRows.get(bucket(o.doneAt));
            if (o.service.cost !== null) { row[4] = (row[4] || 0) + o.service.cost; row[5]++; }
            if (o.service.delayed) row[6]++;
        });
        insights.repeats.forEach(function (pair) {
            bucketRows.get(bucket(iso(pair.current.report)))[7]++;
            devices.get(pair.current.code).repeats++;
        });
        var ranked = Array.from(devices.values()).sort(function (a, b) {
            return b.added - a.added || b.repeats - a.repeats || b.completed - a.completed;
        });
        var mostRepeats = ranked.reduce(function (best, d) { return !best || d.repeats > best.repeats ? d : best; }, null);
        var suppliers = r.services.suppliers.slice().sort(function (a, b) {
            return (b.registeredAmount ?? -1) - (a.registeredAmount ?? -1);
        });
        var movement = comparable ? '，较上期同期' + (s.newCount >= ps.newCount ? '增加 ' : '减少 ') + Math.abs(s.newCount - ps.newCount) + ' 单' : '';
        summary[5] = ['本期新增 ' + s.newCount + ' 单' + movement + '，完成 ' + s.completedCount + ' 单，其中延期 ' + insights.delayedCount + ' 单。'];
        if (hasTrend) for (var i = 0; i < 16; i++) summary.push([]);
        var backlogHeading = summary.length + 2;
        summary.push([], ['读取时的待办', '工单数'], ['未完成', s.backlogCount], ['其中已逾期', s.overdueCount], ['逾期状态待核', s.unknownDueCount]);
        var focusHeading = summary.length + 2;
        summary.push([], ['本期关注', '设备或原因', '数量／金额']);
        if (ranked.length && ranked[0].added) summary.push(['新增故障最多的固定设备', ranked[0].order.name + ' · ' + ranked[0].order.code, ranked[0].added]);
        if (mostRepeats && mostRepeats.repeats) summary.push(['疑似重复报修最多的设备', mostRepeats.order.name + ' · ' + mostRepeats.order.code, mostRepeats.repeats]);
        if (insights.causes.length) summary.push(['工单最多的故障分类', insights.causes[0].label, insights.causes[0].records.length]);
        if (insights.delays.length) summary.push(['工单最多的延期原因', insights.delays[0].label, insights.delays[0].records.length]);
        if (suppliers.length && suppliers[0].registeredAmount !== null) summary.push(['登记费用最高的外协（元）', suppliers[0].label, decimal(suppliers[0].registeredAmount)]);
        if (!r.reportOrders.length) summary.push(['当前范围未见新增或完成工单']);
        var summarySheet = sheet('报表摘要', summary, [32, 50, 21, 16, 55]);
        summarySheet['!merges'] = ['A1:E1', 'A6:E6'].map(range => XLSX.utils.decode_range(range));
        summarySheet['!reportBands'] = {1:'title', 6:'note', 7:'heading', [backlogHeading]:'heading', [focusHeading]:'heading'};
        summarySheet['!rows'] = [{ hpt: 28 }];
        var peak = trend.slice(1).reduce(function (best, row) { return row[4] !== null && (!best || row[4] > best[4]) ? row : best; }, null);
        var hasCost = peak && peak[4] > 0;
        var costNote = hasCost ? '登记费用最高的是 ' + peak[8] + '，合计 ' + peak[4].toLocaleString('zh-CN', {maximumFractionDigits:2}) + ' 元。'
            : peak ? '本期有效登记金额均为零。' : '本期没有有效的登记金额。';
        trend.slice(1).forEach(function (row) { row[4] = decimal(row[4]); });
        var trendHeader = chartSheet('期间趋势', trend, [16, 16, 14, 14, 21, 17, 14, 18, 14], true,
            costNote + ' 金额按完成日归集，缺失金额留空。',
            hasCost && {kind:'column', title:'登记维修费用（元）', cat:'I', series:[['E','登记费用']], first:20, n:buckets.length});
        if (hasTrend) summarySheet['!reportChart'] = {kind:buckets.length > 1 ? 'line' : 'column', title:'新增与完成故障（单）',
            source:'期间趋势', cat:'I', series:[['C','新增故障'], ['D','完成故障']], first:trendHeader + 1, n:buckets.length, top:13};

        var focus = [['固定设备', '设备名称', '部门', '本期新增', '本期完成', '疑似重复报修']];
        ranked.forEach(function (d) { focus.push([d.order.code, d.order.name, d.order.department, d.added, d.completed, d.repeats]); });
        focus.push([], ['故障分类（本期完成）', '工单数', '登记费用（元）', '有效金额单数', '涉及完成月份数']);
        var causeHeader = focus.length;
        insights.causes.forEach(function (g) {
            focus.push([g.label, g.records.length, decimal(g.registeredAmount), g.amountN, new Set(g.records.map(function (o) { return o.doneAt.slice(0, 7); })).size]);
        });
        focus.push([], ['延期原因', '延期完成单数']);
        var delayHeader = focus.length;
        insights.delays.forEach(function (g) { focus.push([g.label, g.records.length]); });
        focus.push([], ['重复报修设备', '故障分类', '上次工单', '上次完成日', '再次报修工单', '再次报修日', '间隔（天）']);
        var repeatHeader = focus.length;
        insights.repeats.forEach(function (pair) {
            focus.push([pair.current.code, pair.current.classification, link(pair.previous), iso(pair.previous.completed),
                link(pair.current), iso(pair.current.report), pair.days]);
        });
        var top = insights.causes.slice(0,5), topCount = top.reduce((sum, g) => sum + g.records.length, 0);
        var focusHeader = chartSheet('重点设备与故障分析', focus, [46, 42, 24, 20, 26, 20, 14], false,
            top.length ? '按单量排列的前 ' + top.length + ' 类共 ' + topCount + ' 单，占本期完成故障的 ' + (100 * topCount / s.completedCount).toFixed(1) + '%。' : '本期没有已完成故障可供分类。',
            top.length && {kind:'bar', title:'完成故障分类 · 前 ' + top.length + ' 项（单）', cat:'A', series:[['B','工单数']], first:19 + causeHeader, n:top.length});
        [causeHeader,delayHeader,repeatHeader].forEach(n => { wb.Sheets['重点设备与故障分析']['!reportBands'][focusHeader + n - 1] = 'heading'; });

        var delivery = [['分组', '维修方式／名称', '完成单数', '占所在期间完成', '登记费用（元）', '有效金额单数', '平均处理周期（天）', '周期有效单数', '延期完成', '延期可判断单数', '统计期间']];
        function deliveryRow(kind, name, g, period) {
            delivery.push([kind, name, g.count, decimal(g.share, '0.0%'), decimal(g.registeredAmount), g.amountN, decimal(g.cycleDays), g.cycleN, g.delayedCount, g.dueN, period || p.value]);
        }
        r.services.modes.forEach(function (g) { deliveryRow('维修方式', modes[g.label], g); });
        r.services.employees.forEach(function (g) { deliveryRow('内部人员', g.label, g); });
        suppliers.forEach(function (g) { deliveryRow('外协供应商', g.label, g); });
        if (annual) {
            r.trends.monthly.forEach(function (b) {
                r.services.modes.forEach(function (mode) {
                    var within = mode.records.filter(function (o) { return o.doneAt >= b.start && o.doneAt <= b.end; });
                    deliveryRow('分月维修方式', modes[mode.label], core.serviceGroup(mode.label, within, b.completedCount), b.label);
                });
            });
        } else if (comparable) {
            prev.services.modes.forEach(function (g) { deliveryRow('上月同期维修方式', modes[g.label], g, p.priorStart + ' 至 ' + p.priorEnd); });
        }
        var modeNote = r.services.modes.map(g => modes[g.label] + ' ' + g.count + ' 单').join('，');
        chartSheet('内部维修与外协', delivery, [22, 30, 14, 20, 22, 18, 23, 18, 14, 20, 28], true,
            s.completedCount ? modeNote + '。占比按本期完成工单数计算。' : '本期没有已完成工单可供比较维修方式。',
            s.completedCount && {kind:'ring', title:'本期维修方式占比', cat:'B', series:[['C','完成单数']], first:20, n:3});

        var orders = [['原工单', '设备编号', '设备名称', '部门', '设备类别', '本期新增', '本期完成', '报修日期', '完成日期', '预计完成时间',
            '当前状态', '报修现象', '故障分类', '本期登记费用（元）', '处理周期（天）', '完成延期', '延期原因', '维修方式', '维修人', '外协供应商']];
        r.reportOrders.forEach(function (o) {
            var v = o.service;
            orders.push([link(o), o.code, o.name, o.department, o.family, Number(o.isNew), Number(o.isCompleted), o.reportAt, o.doneAt, o.expectedAt,
                o.done ? '已完成' : '进行中', o.symptom, o.classification, v ? decimal(v.cost) : null, v && v.cycleDays,
                v ? (v.delayed === null ? '待核' : v.delayed ? '延期' : '按期') : '', v && v.delayed ? o.reason || '原因未填' : '',
                v ? modes[v.mode] : '', v && v.handler, v && v.supplier]);
        });
        sheet('工单明细', orders, [24,18,25,16,20,14,14,16,16,23,13,55,42,24,19,15,22,22,20,24], true);
        var notes = [['统计项目', '说明或数量'],
            ['数据范围', scope + '；仅故障维修。本次设备列表读取完成于 ' + options.loadedAt + '（北京时间）。'],
            ['期间归属', '报修日归新增，完成日归完成和登记费用。同一工单在期间明细中只列一次。'],
            ['对比依据', '使用同一批可见记录。未结束期间比上期同期；对比期间未见新增或完成时显示无可比数据。历史月份完整性待核。'],
            ['登记费用', '仅汇总已完成故障的有效外协／采购登记金额。零元保留，缺失或无效留空。'],
            ['处理周期', '报修至完成的自然日差；平均值以有效工单为分母，单位为天。'],
            ['重复报修', '固定设备相同三级分类，上次完成后 1 至 30 天再次报修。按再次报修日计数，可跨期追溯。'],
            ['延期完成', '按预计和实际完成自然日判断。日期缺失或矛盾导致无法判定时单列。'],
            ['维修方式', '采用工单登记值，历史内部维修曾为默认值，矛盾或缺项列为待核实。'],
            ['积压口径', '未完成和逾期反映本次读取时的状态。历史月末、年末积压尚无快照。'],
            ['本期零元工单', s.zeroAmountN], ['本期金额缺失或无效', s.unknownAmountN], ['本期延期状态待核', insights.unknownDeadlineCount],
            ['当前筛选范围同 ID 去重数', r.quality.duplicateCount], ['当前筛选范围同 ID 冲突组数', r.quality.conflictCount],
            [], ['读取时未完成工单', '设备编号', '报修日期', '预计完成时间', '逾期状态']];
        r.backlog.forEach(function (o) { notes.push([link(o), o.code, o.reportAt, o.expectedAt,
            o.overdue === 'unknown' ? '待核' : o.overdue === 'overdue' ? '逾期' : '未逾期']); });
        var qualitySheet = sheet('统计口径与待核', notes, [32, 102, 18, 22, 16]);
        qualitySheet['!reportBands'][notes.length - r.backlog.length] = 'heading';
        return wb;
    }
    return { periods: periods, build: build };
}));
