/* 设备维修分析V1：仅 me / equipment_list 读取。计算/筛选不请求网络，不持久化业务数据。 */
(function () {
    'use strict';
    var state = { sequence: 0, equipments: null, result: null, asOf: '', loadedAt: '', period: 'month', loading: false };
    function el(id) { return document.getElementById(id); }
    function text(v) { return typeof v === 'string' || typeof v === 'number' ? String(v) : ''; }
    function esc(v) { return text(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    function count(v) { return typeof v === 'number' && isFinite(v) ? v.toLocaleString('zh-CN') : '—'; }
    function currency(v) { return typeof v === 'number' && isFinite(v) ? '¥' + v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—'; }
    function localDay() {
        var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
        var values = {}; parts.forEach(function (p) { values[p.type] = p.value; });
        return values.year + '-' + values.month + '-' + values.day;
    }
    function stamp() { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()); }
    function dateText(ms) { return new Date(ms).toISOString().slice(0, 10); }
    function monthStart(day, offset) { var p = day.split('-'); return dateText(Date.UTC(Number(p[0]), Number(p[1]) - 1 + offset, 1)); }
    function canRead() { var r = EquipApi.role(); return r === 'admin' || r === 'repairer'; }
    function setStatus(title, message, retry) {
        el('analysis-status').hidden = false; el('status-title').textContent = title; el('status-message').textContent = message;
        el('analysis-status').classList.toggle('error', !!retry); el('retry-data').hidden = !retry;
    }
    function clearData() {
        state.equipments = null; state.result = null; state.asOf = ''; state.loadedAt = '';
        el('analysis-content').hidden = true; el('account-label').textContent = '';
        ['summary-cards', 'backlog-rows', 'priority-rows', 'generic-rows', 'trend-chart', 'trend-rows', 'quality-facts', 'quality-issues'].forEach(function (id) { el(id).textContent = ''; });
        el('source-time').textContent = ''; el('range-caption').textContent = '';
    }
    function redirect(page) { location.replace('../' + page + '?next=' + encodeURIComponent('equipment/analysis.html')); }
    function checkSession() {
        var s = EquipApi.session();
        if (!s || !s.token || s.guest) { redirect('login.html'); return false; }
        if (s.must_change_pwd) { redirect('changepwd.html'); return false; }
        return true;
    }
    function selectOptions(id, values, first) {
        var select = el(id), previous = select.value;
        select.textContent = ''; var option = document.createElement('option'); option.value = ''; option.textContent = first; select.appendChild(option);
        values.sort().forEach(function (v) { var op = document.createElement('option'); op.value = v; op.textContent = v; select.appendChild(op); });
        if (values.indexOf(previous) !== -1) select.value = previous;
    }
    function buildOptions() {
        var departments = [], families = [];
        Object.keys(state.equipments).forEach(function (code) {
            var e = state.equipments[code]; if (!e || typeof e !== 'object') return;
            if (typeof e.line === 'string' && e.line && departments.indexOf(e.line) === -1) departments.push(e.line);
            if (typeof e.family === 'string' && e.family && families.indexOf(e.family) === -1) families.push(e.family);
        });
        selectOptions('department', departments, '全部部门'); selectOptions('family', families, '全部类别');
    }
    function selectPeriod(name, apply) {
        state.period = name;
        var asOf = state.asOf || localDay(), start = monthStart(asOf, 0), end = asOf;
        if (name === 'previous') { start = monthStart(asOf, -1); end = dateText(EquipAnalysis.parseDate(monthStart(asOf, 0)) - 86400000); }
        else if (name === 'quarter') start = monthStart(asOf, -2);
        else if (name === 'year') start = asOf.slice(0, 4) + '-01-01';
        if (name !== 'custom') { el('date-start').value = start; el('date-end').value = end; }
        document.querySelectorAll('[data-period]').forEach(function (button) { button.setAttribute('aria-pressed', String(button.getAttribute('data-period') === name)); });
        if (apply) render();
    }
    function bounded(promise) {
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () { reject(Error('读取超时，请检查网络后重试。')); }, 20000);
            Promise.resolve(promise).then(function (value) { clearTimeout(timer); resolve(value); }, function (error) { clearTimeout(timer); reject(error); });
        });
    }
    function refreshSession(seq) {
        var original = EquipApi.session(), token = original && original.token;
        // 复用现有 me RPC，但合并前核对请求序号和身份，避免迟到 me 恢复另一账号/已退出会话。
        return bounded(eqRpc('me', { p_token: token })).then(function (r) {
            if (seq !== state.sequence) return null;
            var current = EquipApi.session();
            if (!current || current.token !== token) throw Error('登录状态已变化，请重新读取。');
            if (!r || !r.ok) return r;
            var u = r.data && r.data.user;
            if (!u || typeof u.account !== 'string' || !Array.isArray(u.tools)) throw Error('权限返回格式异常，请重新登录。');
            SessionStore.merge({ token: token, account: u.account, name: u.name, level: u.level, tools: u.tools, dept: u.dept || '', must_change_pwd: !!u.must_change_pwd });
            return { ok: true };
        });
    }
    function load() {
        var seq = ++state.sequence; state.loading = true; clearData();
        el('refresh-data').disabled = true; el('retry-data').disabled = true;
        setStatus('正在核对权限', '只读取现有账号权限，不使用旧缓存代替最新权限。', false);
        if (!checkSession()) { state.loading = false; return; }
        // 本页不使用 ?demo 注入身份，也不调用会写入演示设备的 seedLocal。
        if (!EqConfig.cloud) { state.loading = false; setStatus('未启用云端读取', '本页不初始化或改写本地设备数据。请使用独立的合成数据预览文件。', false); return; }
        var requestToken = EquipApi.session().token;
        Promise.resolve().then(function () { return refreshSession(seq); }).then(function (r) {
            if (seq !== state.sequence) return null;
            if (!r || r.ok !== true) throw Error((r && r.msg) || '会话核对失败，请重试。');
            if (!checkSession()) return null;
            if (!canRead()) { setStatus('当前账号无分析权限', '设备管理员、维修人可分析其现有全量设备范围；报修人和普通账号不新增访问权限。', false); return null; }
            var user = EquipApi.user() || {};
            el('account-label').textContent = text(user.name || user.account) + ' · ' + (EquipApi.role() === 'admin' ? '设备管理员' : '维修人');
            setStatus('正在读取设备记录', '通过既有设备列表接口读取；不会保存、导入、催办或发送群消息。', false);
            return bounded(eqRpc('equipment_list', { p_token: requestToken })).then(function (response) {
                if (!response || !response.ok) return response;
                var data = response.data;
                if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.prototype.hasOwnProperty.call(data, 'role') || !Object.prototype.hasOwnProperty.call(data, 'equipments')) throw Error('设备返回缺少角色或设备范围，未将异常响应当作空数据。');
                return { ok: true, role: data.role, equipments: data.equipments };
            });
        }).then(function (r) {
            if (seq !== state.sequence || r === null) return;
            if (!EquipApi.session() || EquipApi.session().token !== requestToken) throw Error('登录状态已变化，请重新读取。');
            if (!r || !r.ok) throw Error((r && r.msg) || '设备读取失败，请重试。');
            if (!checkSession()) return;
            if (!canRead() || (r.role !== 'admin' && r.role !== 'repairer')) { clearData(); setStatus('当前账号无分析权限', '权限已变化，未展示设备分析数据。', false); return; }
            if (!r.equipments || typeof r.equipments !== 'object' || Array.isArray(r.equipments)) throw Error('设备返回格式异常，未使用空数据冒充统计结果。');
            state.equipments = r.equipments; state.asOf = localDay(); state.loadedAt = stamp();
            el('date-start').max = state.asOf; el('date-end').max = state.asOf;
            buildOptions(); selectPeriod(state.period, false);
            el('analysis-status').hidden = true; el('analysis-content').hidden = false;
            render();
        }).catch(function (error) {
            if (seq !== state.sequence) return;
            clearData(); setStatus('暂时无法读取分析数据', text(error && error.message) || '网络或权限核对失败，请重试。', true);
        }).finally(function () {
            if (seq !== state.sequence) return;
            state.loading = false; el('refresh-data').disabled = false; el('retry-data').disabled = false;
        });
    }
    function workLink(code, no, label) {
        var url = './index.html?code=' + encodeURIComponent(text(code));
        if (text(no)) url += '&wo=' + encodeURIComponent(text(no));
        return '<a href="' + esc(url) + '">' + esc(label) + '</a>';
    }
    function deviceCell(row) { return '<span class="device-name">' + esc(row.name || row.code) + '</span><span class="sub">' + esc(row.code) + ' · ' + esc(row.department || '部门未填') + '</span>'; }
    function emptyRow(columns, message) { return '<tr><td colspan="' + columns + '" class="empty-row">' + esc(message) + '</td></tr>'; }
    function dayValue(n) { return typeof n === 'number' && isFinite(n) ? count(n) + ' 天' : '日期待核'; }
    function card(id, label, value, hint, warn) { return '<article class="stat-card' + (warn ? ' warn' : '') + '" data-metric="' + id + '"><span class="label">' + label + '</span><strong class="value">' + esc(value) + '</strong><span class="hint">' + esc(hint) + '</span></article>'; }
    function renderSummary(r) {
        var s = r.summary;
        el('summary-cards').innerHTML = card('new', '本期新增故障', count(s.newCount), '按报修日 · 含通用报修')
            + card('done', '本期完成故障', count(s.completedCount), '按完成日 · 可含以前月份报修')
            + card('backlog', '当前未完成', count(s.backlogCount), '所有月份结转 · 不随期间截断')
            + card('overdue', '当前逾期', count(s.overdueCount), s.unknownDueCount ? '另 ' + s.unknownDueCount + ' 条预计日期待核' : '预计日期早于统计日', s.overdueCount > 0)
            + card('cycle', '平均处理周期', s.cycleDays == null ? '—' : s.cycleDays.toFixed(1), '自然日 · 有效样本 ' + s.cycleN + ' 条')
            + card('amount', '本期登记金额', currency(s.registeredAmount), '按完成日 · 不是完整成本');
    }
    function renderTables(r) {
        el('backlog-count').textContent = r.backlog.length + ' 条';
        el('backlog-note').textContent = '截至 ' + r.period.asOf + ' · 已知逾期 ' + r.summary.overdueCount + ' 条' + (r.summary.unknownDueCount ? '，另 ' + r.summary.unknownDueCount + ' 条逾期状态待核' : '') + '。未完成按当前读取状态，不回算所选期末。';
        el('backlog-rows').innerHTML = r.backlog.map(function (row) {
            var due = row.overdue === 'overdue' ? '<span class="badge danger">' + dayValue(row.overdueDays) + '</span>' : row.overdue === 'unknown' ? '<span class="badge unknown">预计待核</span>' : '<span class="badge">未超预计</span>';
            return '<tr><td>' + deviceCell(row) + '</td><td>' + esc(row.workOrder || '未编工单号') + '</td><td class="symptom">' + esc(row.symptom || '现象未填') + '</td><td>' + esc(row.reportAt || '日期待核') + '</td><td>' + esc(row.expectedAt || '预计待核') + '</td><td>' + esc(dayValue(row.waitingDays)) + '<span class="sub">' + esc(row.aging) + '</span></td><td>' + due + '</td><td>' + workLink(row.code, row.workOrder, row.workOrder ? '查看原单' : '查看设备') + '</td></tr>';
        }).join('') || emptyRow(8, '当前筛选范围内未见未完成故障。');
        el('priority-count').textContent = r.priority.length + ' 台';
        el('three-range').textContent = '近3月窗口：' + r.period.threeStart + ' — ' + r.period.end;
        el('priority-rows').innerHTML = r.priority.map(function (row) { return '<tr><td>' + deviceCell(row) + '</td><td>' + esc(row.family || '类别未填') + '</td><td class="num">' + count(row.newCount) + '</td><td class="num">' + count(row.threeMonthNewCount) + '</td><td>' + count(row.backlogCount) + '</td><td>' + count(row.overdueCount) + '</td><td>' + (row.backlogCount ? esc(dayValue(row.maxWaitDays)) : '—') + '</td><td>' + workLink(row.code, '', '查看履历') + '</td></tr>'; }).join('') || emptyRow(8, '本期或近3月未见固定设备故障，也无当前积压。');
        var share = r.scope.faultCount ? (r.scope.genericFaultCount * 100 / r.scope.faultCount).toFixed(1) : '0.0';
        el('generic-caption').textContent = '当前筛选范围 · 全量故障中 GEN 占 ' + share + '%';
        el('generic-rows').innerHTML = r.generic.map(function (row) { return '<tr><td>' + esc(row.department || '部门未填') + '<span class="sub">' + esc(row.code) + '</span></td><td>' + count(row.newCount) + '</td><td>' + count(row.threeMonthNewCount) + '</td><td>' + count(row.completedCount) + '</td><td>' + count(row.backlogCount) + '</td><td>' + count(row.overdueCount) + '</td></tr>'; }).join('') || emptyRow(6, '当前筛选范围内未见通用报修故障。');
    }
    function trendRows() {
        if (!state.result) return [];
        var grain = el('trend-grain').value;
        if (grain === 'auto') {
            var days = (EquipAnalysis.parseDate(state.result.period.end) - EquipAnalysis.parseDate(state.result.period.start)) / 86400000 + 1;
            grain = days <= 35 ? 'daily' : days <= 100 ? 'weekly' : 'monthly';
        }
        // 避免极长自定义区间在屏幕上挤入数千个日点；数值仍按完整所选范围汇总。
        if (grain === 'daily' && state.result.trends.daily.length > 366) grain = 'monthly';
        return state.result.trends[grain] || [];
    }
    function renderTrend() {
        var rows = trendRows(), width = 1000, height = 245, left = 42, right = 16, top = 12, bottom = 36;
        var plotW = width - left - right, plotH = height - top - bottom;
        var peak = Math.max(1, Math.ceil(Math.max.apply(null, rows.map(function (r) { return Math.max(r.newCount, r.completedCount); }).concat([0])) / 4) * 4);
        function x(i) { return left + (rows.length <= 1 ? plotW / 2 : i * plotW / (rows.length - 1)); }
        function y(n) { return top + plotH - n * plotH / peak; }
        var grid = '', labels = '';
        for (var i = 0; i <= 4; i++) { var value = peak * i / 4; grid += '<line class="chart-grid" x1="' + left + '" x2="' + (width - right) + '" y1="' + y(value) + '" y2="' + y(value) + '"/><text class="chart-label" x="' + (left - 9) + '" y="' + (y(value) + 4) + '" text-anchor="end">' + value + '</text>'; }
        var every = Math.max(1, Math.ceil(rows.length / 7));
        rows.forEach(function (row, index) { if (index % every === 0 || index === rows.length - 1) labels += '<text class="chart-label" x="' + x(index) + '" y="' + (height - 9) + '" text-anchor="middle">' + esc(row.start.slice(5)) + '</text>'; });
        function series(key, color) {
            var points = rows.map(function (row, index) { return x(index) + ',' + y(row[key]); }).join(' ');
            return '<polyline fill="none" stroke="' + color + '" stroke-width="2.5" points="' + points + '"/>' + (rows.length <= 100 ? rows.map(function (row, index) { return '<circle fill="' + color + '" cx="' + x(index) + '" cy="' + y(row[key]) + '" r="3"><title>' + esc(row.start + ' — ' + row.end + '：' + (key === 'newCount' ? '新增' : '完成') + ' ' + row[key]) + '</title></circle>'; }).join('') : '');
        }
        el('trend-chart').innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="所选期间故障新增与完成趋势；详细数据见下方数值表">' + grid + labels + series('newCount', '#23679b') + series('completedCount', '#087e84') + '</svg>';
        el('trend-rows').innerHTML = rows.map(function (row) { return '<tr><td>' + esc(row.start === row.end ? row.start : row.start + ' — ' + row.end) + '</td><td>' + count(row.newCount) + '</td><td>' + count(row.completedCount) + '</td></tr>'; }).join('') || emptyRow(3, '所选范围无可展示的趋势区间。');
    }
    function renderQuality(r) {
        var q = r.quality, s = r.summary;
        function fact(title, description) { return '<div class="quality-fact"><strong>' + esc(title) + '</strong>' + esc(description) + '</div>'; }
        el('quality-facts').innerHTML = fact('已完成分类待补 ' + q.completedClassMissing + ' 条', '仅检查当前筛选范围全量 ' + q.completedClassDenominator + ' 条已完成故障；未完成空分类正常。')
            + fact('本期金额0：' + s.zeroAmountN + ' 条', '本期完成单中缺失/非法金额 ' + s.unknownAmountN + ' 条；0不能认定无支出。')
            + fact('可见故障 ' + r.scope.faultCount + ' 条', '当前筛选 ' + r.scope.equipmentCount + ' 个设备/通用卡；非故障类型排除 ' + r.scope.ignoredTypeCount + ' 条。');
        var notes = ['读取完成：' + state.loadedAt + '（北京时间）。这是本次设备列表读取结束时点，不是全库一致性快照；月份完整性未确认。', '当前筛选范围内预计日期缺失 ' + q.missingDueCount + ' 条、日期异常 ' + q.invalidDateCount + ' 处；具体影响以有效日期样本为准。'];
        if (q.unknownTypeCount) notes.push('未知或空类型 ' + q.unknownTypeCount + ' 条未计入故障，需要核对原记录类型。');
        if (q.missingIdCount || q.duplicateCount || q.conflictCount) notes.push('缺源ID ' + q.missingIdCount + ' 条（按原行保留）；同ID同内容去除额外行 ' + q.duplicateCount + ' 条；冲突ID组 ' + q.conflictCount + ' 组已排除计量，不能把排除当作无故障。');
        if (q.statusConflictCount || q.malformedEquipmentCount) notes.push('状态/完成日期矛盾 ' + q.statusConflictCount + ' 条，异常设备结构 ' + q.malformedEquipmentCount + ' 处；请先核对，不自动修正。');
        var issues = (q.issues || []).slice(0, 10).map(function (issue) { return typeof issue === 'string' ? issue : (text(issue.code) ? text(issue.code) + ' · ' : '') + text(issue.text); });
        if ((q.issues || []).length > 10) issues.push('另有 ' + (q.issues.length - 10) + ' 条待核提示，此处仅列前10条。');
        el('quality-issues').innerHTML = notes.concat(issues).map(function (note) { return '<li>' + esc(note) + '</li>'; }).join('');
    }
    function render() {
        if (!state.equipments) return;
        var start = el('date-start').value, end = el('date-end').value;
        try {
            var startMs = EquipAnalysis.parseDate(start), endMs = EquipAnalysis.parseDate(end);
            if (startMs == null || endMs == null) throw Error('请输入有效的开始和结束日期。');
            if (endMs - startMs > 36600 * 86400000) throw Error('自定义区间过长，请选择100年以内的范围。');
            var result = EquipAnalysis.analyze(state.equipments, { asOf: state.asOf, start: start, end: end, department: el('department').value, family: el('family').value });
            state.result = result; el('filter-error').hidden = true;
            el('source-time').textContent = '读取完成 ' + state.loadedAt + ' · 北京时间';
            el('range-caption').textContent = '已应用：' + start + ' — ' + end + ' · ' + (el('department').value || '全部部门') + ' · ' + (el('family').value || '全部类别') + '；当前积压截至 ' + state.asOf;
            renderSummary(result); renderTables(result); renderTrend(); renderQuality(result);
        } catch (error) { el('filter-error').textContent = (error && error.message) || '统计失败，请检查范围。'; el('filter-error').hidden = false; }
    }
    function init() {
        el('refresh-data').addEventListener('click', load); el('retry-data').addEventListener('click', load);
        el('analysis-filters').addEventListener('submit', function (event) { event.preventDefault(); render(); });
        el('reset-filters').addEventListener('click', function () { el('department').value = ''; el('family').value = ''; el('trend-grain').value = 'auto'; selectPeriod('month', true); });
        document.querySelectorAll('[data-period]').forEach(function (button) { button.addEventListener('click', function () { selectPeriod(button.getAttribute('data-period'), true); }); });
        ['date-start', 'date-end'].forEach(function (id) { el(id).addEventListener('change', function () { selectPeriod('custom', false); }); });
        el('trend-grain').addEventListener('change', renderTrend);
        window.addEventListener('storage', function (event) { if (event.key === 'roi_session' || event.key === null) load(); });
        window.addEventListener('pageshow', function (event) { if (event.persisted) load(); });
        load();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
