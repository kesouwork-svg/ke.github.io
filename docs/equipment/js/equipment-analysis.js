/* 设备维修分析V1：仅 me / equipment_list 读取。计算/筛选不请求网络，不持久化业务数据。 */
(function () {
    'use strict';
    var state = { sequence: 0, equipments: null, result: null, asOf: '', asOfTime: null, loadedAt: '', period: 'month', loading: false, priorityMode: 'devices', priorityOpen: Object.create(null), insight: 'causes' };
    function el(id) { return document.getElementById(id); }
    function text(v) { return typeof v === 'string' || typeof v === 'number' ? String(v) : ''; }
    function esc(v) { return text(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    function count(v) { return typeof v === 'number' && isFinite(v) ? v.toLocaleString('zh-CN') : '—'; }
    function currency(v) { return typeof v === 'number' && isFinite(v) ? '¥' + v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—'; }
    function todayISO(ms) { return EquipTime.day(ms === undefined ? Date.now() : ms); }
    function stamp(ms) { return EquipTime.stamp(ms).replace('T', ' ') + ':' + ('0' + new Date(ms).getUTCSeconds()).slice(-2); }
    function dateText(ms) { return new Date(ms).toISOString().slice(0, 10); }
    function monthStart(day, offset) { var date = new Date(EquipAnalysis.parseDate(day)); date.setUTCMonth(date.getUTCMonth() + offset, 1); return dateText(date.getTime()); }
    function canRead() { var r = EquipApi.role(); return r === 'admin' || r === 'repairer'; }
    function setStatus(title, message, retry) {
        el('analysis-status').hidden = false; el('status-title').textContent = title; el('status-message').textContent = message;
        el('analysis-status').classList.toggle('error', !!retry); el('retry-data').hidden = !retry;
    }
    function clearData() {
        state.exportToken = null; state.applied = null;
        el('report-toggle').hidden = true; el('report-form').hidden = true;
        el('report-toggle').setAttribute('aria-expanded', 'false'); el('report-download').disabled = false;
        el('report-status').textContent = ''; el('report-scope').textContent = '';
        state.equipments = null; state.result = null; state.asOf = ''; state.asOfTime = null; state.loadedAt = ''; state.priorityOpen = Object.create(null);
        el('analysis-content').hidden = true; el('account-label').textContent = '';
        ['summary-cards', 'backlog-rows', 'priority-rows', 'priority-categories', 'generic-rows', 'trend-chart', 'trend-rows', 'quality-facts', 'quality-issues', 'service-modes', 'service-employees', 'service-suppliers', 'service-caption', 'service-unverified', 'service-unverified-caption'].forEach(function (id) { el(id).textContent = ''; });
        el('insight-results').textContent = ''; el('insight-caption').textContent = '';
        el('source-time').textContent = ''; el('range-caption').textContent = ''; el('priority-count').textContent = ''; el('three-range').textContent = '';
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
        var asOf = state.asOf || todayISO(), start = monthStart(asOf, 0), end = asOf;
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
            state.equipments = r.equipments; state.asOfTime = Date.now(); state.asOf = todayISO(state.asOfTime); state.loadedAt = stamp(state.asOfTime);
            if (r.role === 'admin' && EquipApi.role() === 'admin') state.exportToken = requestToken;
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
    function workOrderCell(row) {
        if (row.workOrder) return workLink(row.code, row.workOrder, row.workOrder);
        return '<span class="sub">未编工单号</span>' + workLink(row.code, '', '查看设备');
    }
    function deviceCell(row) { return '<span class="device-name">' + esc(row.name || row.code) + '</span><span class="sub">' + esc(row.code) + ' · ' + esc(row.department || '部门未填') + '</span>'; }
    function emptyRow(columns, message) { return '<tr><td colspan="' + columns + '" class="empty-row">' + esc(message) + '</td></tr>'; }
    function dayValue(n) { return typeof n === 'number' && isFinite(n) ? count(n) + ' 天' : '日期待核'; }
    function overdueLabel(row) {
        var due = EquipTime.parse(row.expectedAt);
        if (!due || due.kind === 'date') return dayValue(row.overdueDays);
        var minutes = Math.ceil(row.overdueDays * 1440);
        return minutes < 60 ? count(minutes) + ' 分钟' : count(Math.round(minutes / 60 * 10) / 10) + ' 小时';
    }
    function card(id, label, value, hint, warn) { return '<article class="stat-card' + (warn ? ' warn' : '') + '" data-metric="' + id + '"><span class="label">' + label + '</span><strong class="value">' + esc(value) + '</strong><span class="hint">' + esc(hint) + '</span></article>'; }
    function renderSummary(r) {
        var s = r.summary;
        el('summary-cards').innerHTML = card('new', '本期新增故障', count(s.newCount), '按报修日 · 含通用报修')
            + card('done', '本期完成故障', count(s.completedCount), '按完成日 · 可含以前月份报修')
            + card('backlog', '当前未完成', count(s.backlogCount), '所有月份结转 · 不随期间截断')
            + card('overdue', '当前逾期', count(s.overdueCount), s.unknownDueCount ? '另 ' + s.unknownDueCount + ' 条预计时间待核' : '超过预计截止时刻 · 北京时间', s.overdueCount > 0)
            + card('cycle', '平均处理周期', s.cycleDays == null ? '—' : s.cycleDays.toFixed(1), '自然日 · 有效样本 ' + s.cycleN + ' 条')
            + card('amount', '本期登记金额', currency(s.registeredAmount), '按完成日 · 不是完整成本');
    }
    function renderTables(r) {
        el('backlog-count').textContent = r.backlog.length + ' 条';
        el('backlog-note').textContent = '截至 ' + r.period.asOf + ' · 已知逾期 ' + r.summary.overdueCount + ' 条' + (r.summary.unknownDueCount ? '，另 ' + r.summary.unknownDueCount + ' 条逾期状态待核' : '') + '。未完成按本次读取时刻和当前状态，不回算所选期末；旧预计日期截止当日23:59:59.999。';
        el('backlog-rows').innerHTML = r.backlog.map(function (row) {
            var due = row.overdue === 'overdue' ? '<span class="badge danger">' + esc(overdueLabel(row)) + '</span>' : row.overdue === 'unknown' ? '<span class="badge unknown">预计待核</span>' : '<span class="badge">未超预计</span>';
            return '<tr><td>' + deviceCell(row) + '</td><td class="order-cell">' + workOrderCell(row) + '</td><td class="symptom">' + esc(row.symptom || '现象未填') + '</td><td>' + esc(row.reportAt || '日期待核') + '</td><td>' + esc(EquipTime.format(row.expectedAt) || '预计待核') + '</td><td>' + esc(dayValue(row.waitingDays)) + '<span class="sub">' + esc(row.aging) + '</span></td><td>' + due + '</td></tr>';
        }).join('') || emptyRow(7, '当前筛选范围内未见未完成故障。');
        renderPriority(r);
        var share = r.scope.faultCount ? (r.scope.genericFaultCount * 100 / r.scope.faultCount).toFixed(1) : '0.0';
        el('generic-caption').textContent = '当前筛选范围 · 全量故障中 GEN 占 ' + share + '%';
        el('generic-rows').innerHTML = r.generic.map(function (row) { return '<tr><td>' + esc(row.department || '部门未填') + '<span class="sub">' + esc(row.code) + '</span></td><td>' + count(row.newCount) + '</td><td>' + count(row.threeMonthNewCount) + '</td><td>' + count(row.completedCount) + '</td><td>' + count(row.backlogCount) + '</td><td>' + count(row.overdueCount) + '</td></tr>'; }).join('') || emptyRow(6, '当前筛选范围内未见通用报修故障。');
    }
    function priorityRows(rows) {
        return rows.map(function (row) { return '<tr><td>' + deviceCell(row) + '</td><td>' + esc(row.family || '类别未填') + '</td><td class="num">' + count(row.newCount) + '</td><td class="num">' + count(row.threeMonthNewCount) + '</td><td>' + count(row.backlogCount) + '</td><td>' + count(row.overdueCount) + '</td><td>' + (row.backlogCount ? esc(dayValue(row.maxWaitDays)) : '—') + '</td><td>' + workLink(row.code, '', '查看履历') + '</td></tr>'; }).join('') || emptyRow(8, '本期或近3月未见固定设备故障，也无当前积压。');
    }
    function percent(value) { return value === null ? '—' : (value * 100).toFixed(1) + '%'; }
    function insightTable(label, headers, rows) {
        return '<div class="table-scroll" role="region" tabindex="0" aria-label="' + esc(label) + '"><table><thead><tr>'
            + headers.map(function (header) { return '<th scope="col">' + header + '</th>'; }).join('')
            + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
    }
    function renderFaultInsights(result) {
        var mode = state.insight, data = result.faultInsights, completed = result.summary.completedCount;
        var body = el('insight-results'), caption = el('insight-caption');
        document.querySelectorAll('[data-insight]').forEach(function (button) {
            button.setAttribute('aria-pressed', String(button.dataset.insight === mode));
        });
        if (mode === 'repeats') {
            caption.textContent = '本期有 ' + count(data.repeats.length) + ' 单疑似重复报修。按再次报修日统计，同一固定设备、相同三级分类，上次完成后 1 至 30 天内再次报修，每次只匹配最近一单。完成时间只精确到日期，同日工单无法判定先后。通用卡和分类不全的工单不参与匹配。';
            body.innerHTML = data.repeats.length ? insightTable('重复报修工单对照',
                ['设备 / 部门', '故障分类', '上次工单 / 完成日', '本次工单 / 报修日', '间隔'],
                data.repeats.map(function (pair) {
                    return '<tr><td>' + deviceCell(pair.current) + '</td><td>' + esc(pair.current.classification)
                        + '</td><td>' + workOrderCell(pair.previous) + '<span class="sub">' + dateText(pair.previous.completed)
                        + '</span></td><td>' + workOrderCell(pair.current) + '<span class="sub">' + dateText(pair.current.report)
                        + '</span></td><td>' + dayValue(pair.days) + '</td></tr>';
                })) : '<p class="empty-row">当前范围内未找到符合条件的重复报修。</p>';
            return;
        }
        var delay = mode === 'delays', total = delay ? data.delayedCount : completed;
        caption.textContent = delay
            ? '本期完成 ' + count(completed) + ' 单，其中延期 ' + count(total) + ' 单，另有 ' + count(data.unknownDeadlineCount) + ' 单因日期缺失或异常无法判断。按预计完成日与实际完成日比较，占比按延期工单数计算。'
            : '本期完成故障 ' + count(total) + ' 单。按登记的三级故障分类统计次数和外协／采购支出，分类缺项单列。展开可核对工单及费用。';
        var groupRows = data[mode].map(function (group, index) {
            var note = count(group.records.length) + ' 单 · 占 ' + percent(group.records.length / total);
            if (!delay) note += ' · 登记费用 ' + currency(group.registeredAmount) + '（有效 ' + count(group.amountN) + ' 单）';
            return '<details class="service-group" data-reason-index="' + index + '"><summary><span class="service-name">'
                + esc(group.label) + '<small>' + esc(note) + '</small></span></summary><div class="service-records"></div></details>';
        });
        body.innerHTML = groupRows.slice(0, 5).join('') || '<p class="empty-row">' + (delay ? '当前范围内未见可确认的延期完成工单。' : '当前范围内没有已完成的故障工单。') + '</p>';
        if (groupRows.length > 5) {
            body.insertAdjacentHTML('beforeend', '<details class="trend-details"><summary>其余 ' + count(groupRows.length - 5)
                + ' 项原因</summary>' + groupRows.slice(5).join('') + '</details>');
        }
    }
    function toggleReason(event) {
        var detail = event.target;
        if (!detail.open || !detail.hasAttribute('data-reason-index') || !el('insight-results').contains(detail) || !state.result) return;
        var body = detail.querySelector('.service-records');
        if (body.firstChild) return;
        var delay = state.insight === 'delays';
        var group = state.result.faultInsights[state.insight][Number(detail.dataset.reasonIndex)];
        body.innerHTML = insightTable(group.label + '工单', ['设备 / 部门', '原工单', '完成日', delay ? '预计完成时间' : '登记费用'],
            group.records.map(function (order) {
                return '<tr><td>' + deviceCell(order) + '</td><td>' + workOrderCell(order) + '</td><td>' + esc(order.doneAt)
                    + '</td><td>' + (delay ? esc(order.expectedAt.replace('T', ' ')) : currency(order.cost)) + '</td></tr>';
            }));
    }
    function serviceMetrics(group) {
        function metric(label, value, note) { return '<div><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong><small>' + esc(note) + '</small></div>'; }
        return '<div class="service-metrics">'
            + metric('完成单数', count(group.count), '占本区 ' + percent(group.share) + ' · 涉及 ' + group.equipmentCount + ' 台／卡')
            + metric('登记费用', currency(group.registeredAmount), '有效金额 ' + group.amountN + ' 单 · 零元 ' + group.zeroAmountN + ' 单')
            + metric('单均登记费用', currency(group.averageAmount), '有效金额样本 ' + group.amountN + ' 单')
            + metric('平均处理周期', group.cycleDays === null ? '—' : group.cycleDays.toFixed(1) + ' 天', '自然日样本 ' + group.cycleN + ' 单')
            + metric('延期单数／比例', count(group.delayedCount) + ' / ' + percent(group.delayedRate), '可判定 ' + group.dueN + ' 单 · 待核 ' + (group.count - group.dueN) + ' 单') + '</div>';
    }
    function renderServices(result) {
        var data = result.services, labels = { inner: '内部维修（按登记）', outer: '外协维修', unknown: '维修方式待核实' };
        var types = { fault: '故障维修', maintain: '保养', overhaul: '大修', modify: '改造', inspect: '点检' };
        var unknown = data.modes.filter(function (group) { return group.label === 'unknown'; })[0];
        var scope = result.period.start + ' — ' + result.period.end + ' · ' + types[data.type];
        el('service-caption').textContent = scope + ' · 按完成日归集 · 本区共 ' + data.total + ' 单（其中维修方式待核实 ' + unknown.count + ' 单） · 沿用部门及设备类别筛选';
        el('service-unverified-caption').textContent = scope + ' · 维修方式待核实 ' + unknown.count + ' 单 · 沿用上方维修执行分析的类型、日期、部门及设备类别筛选。方式缺失、无效或与外协名称矛盾的记录单列，不计入内部人员或外协供应商分组。';
        [['service-modes', 'modes'], ['service-employees', 'employees'], ['service-suppliers', 'suppliers'], ['service-unverified', 'modes']].forEach(function (pair) {
            el(pair[0]).innerHTML = data[pair[1]].map(function (group, index) {
                if (pair[1] === 'modes' && ((pair[0] === 'service-unverified') !== (group.label === 'unknown'))) return '';
                return '<details class="service-group" data-service-kind="' + pair[1] + '" data-service-index="' + index + '"><summary>'
                    + '<span class="service-name">' + esc(pair[1] === 'modes' ? labels[group.label] : group.label)
                    + '<small>' + group.issueCount + ' 单有待核信息 · 展开工单</small></span>' + serviceMetrics(group)
                    + '</summary><div class="service-records"></div></details>';
            }).join('') || '<p class="empty-row">当前筛选范围内未见此类已完成记录。</p>';
        });
    }
    function toggleService(event) {
        var detail = event.target;
        if (!detail.open || !state.result || !detail.getAttribute || !detail.getAttribute('data-service-kind')) return;
        var groups = state.result.services[detail.getAttribute('data-service-kind')];
        var group = groups && groups[Number(detail.getAttribute('data-service-index'))];
        if (!group) return;
        detail.querySelector('.service-records').innerHTML = '<div class="table-scroll" tabindex="0" role="region" aria-label="维修处理工单明细，可横向滚动"><table class="work-order-table"><thead><tr>'
            + '<th>设备／部门</th><th>原工单／现象</th><th>登记维修人</th><th>外协</th><th>完成日</th><th>登记费用</th><th>处理周期</th><th>延期</th><th>待核信息</th></tr></thead><tbody>'
            + group.records.map(function (row) {
                return '<tr><td>' + deviceCell(row) + '</td><td class="order-cell">' + workOrderCell(row) + '<span class="sub">' + esc(row.symptom || '现象未填') + '</span></td><td>'
                    + esc(row.handler || '未填') + '</td><td>' + esc(row.supplier || '—') + '</td><td>' + esc(row.doneAt) + '</td><td>' + currency(row.cost)
                    + '</td><td>' + esc(dayValue(row.cycleDays)) + '</td><td>' + (row.delayed === null ? '待核' : row.delayed ? '延期' : '未延期')
                    + '</td><td class="symptom">' + esc(row.issues.join('；') || '—') + '</td></tr>';
            }).join('') + (group.records.length ? '' : emptyRow(9, '本期无此类已完成记录。')) + '</tbody></table></div>';
    }
    function categoryDevices(group) {
        return '<div class="table-scroll" tabindex="0" role="region" aria-label="类别内重点设备，可横向滚动"><table><thead><tr><th>设备 / 部门</th><th>原设备类别</th><th>本期新增</th><th>近3月新增</th><th>当前未完成</th><th>当前逾期</th><th>最长等待</th><th>设备履历</th></tr></thead><tbody>' + priorityRows(group.devices) + '</tbody></table></div>';
    }
    function categoryMetric(label, value, warn) {
        return '<span class="priority-group-metric' + (warn && value ? ' has-backlog' : '') + '"><span>' + label + '</span><strong>' + count(value) + '</strong></span>';
    }
    function renderPriority(r) {
        var grouped = state.priorityMode === 'categories', groups = r.priorityGroups || [];
        el('priority-devices').hidden = grouped; el('priority-categories').hidden = !grouped;
        el('priority-by-device').setAttribute('aria-pressed', String(!grouped)); el('priority-by-category').setAttribute('aria-pressed', String(grouped));
        el('priority-count').textContent = r.priority.length + ' 台' + (grouped ? ' · ' + groups.length + ' 类' : '');
        el('three-range').textContent = '近3月窗口：' + r.period.threeStart + ' — ' + r.period.end;
        el('priority-rows').innerHTML = grouped ? '' : priorityRows(r.priority);
        if (!grouped) { el('priority-categories').textContent = ''; return; }
        var nextOpen = Object.create(null);
        var content = groups.map(function (group, index) {
            var opened = !!state.priorityOpen[group.name]; if (opened) nextOpen[group.name] = true;
            return '<details class="priority-group" data-group-index="' + index + '"' + (opened ? ' open' : '') + '><summary><span class="priority-group-title"><span class="priority-group-name">' + esc(group.name || '（空类别名称）') + '</span><span class="sub">设备 ' + count(group.equipmentCount) + ' 台 · 重点 ' + count(group.activeEquipmentCount) + ' 台</span></span><span class="priority-group-metrics">'
                + categoryMetric('近3月新增', group.threeMonthNewCount, false) + categoryMetric('本期新增', group.newCount, false) + categoryMetric('当前未完成', group.backlogCount, true) + categoryMetric('当前逾期', group.overdueCount, true)
                + '</span></summary><div class="priority-group-body"' + (opened ? ' data-ready="true"' : '') + '>' + (opened ? categoryDevices(group) : '') + '</div></details>';
        }).join('');
        state.priorityOpen = nextOpen;
        el('priority-categories').innerHTML = '<p class="section-note priority-category-note">分组名称与设备列表一致；类别按近3月新增 → 当前未完成 → 本期新增排序。设备台数含当前筛选范围内没有近期故障的固定设备，重点台数为下方可展开设备；台数多不等于故障更严重。仅列有重点设备的类别，GEN 仍单列。</p>' + (content || '<p class="empty-row">当前范围没有可展示的重点设备类别；未将 GEN 当作设备类别。</p>');
    }
    function toggleCategory(event) {
        var detail = event.target;
        if (!detail || !detail.classList || !detail.classList.contains('priority-group') || !el('priority-categories').contains(detail) || !state.result || state.priorityMode !== 'categories') return;
        var index = detail.getAttribute('data-group-index');
        if (!/^(0|[1-9][0-9]*)$/.test(index)) return;
        var group = (state.result.priorityGroups || [])[Number(index)]; if (!group) return;
        if (!detail.open) { delete state.priorityOpen[group.name]; return; }
        state.priorityOpen[group.name] = true;
        var body = detail.querySelector('.priority-group-body');
        if (!body.hasAttribute('data-ready')) { body.innerHTML = categoryDevices(group); body.setAttribute('data-ready', 'true'); }
    }
    function setPriorityMode(mode) {
        if (mode !== 'devices' && mode !== 'categories') return;
        state.priorityMode = mode; if (state.result && !state.loading) renderPriority(state.result);
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
        var notes = ['读取完成：' + state.loadedAt + '（北京时间）。这是本次设备列表读取结束时点，不是全库一致性快照；月份完整性未确认。', '完成登记只有日期；完成统计、处理周期及完成延期只能按自然日判断，不能作小时级完工或及时性结论。', '当前筛选范围内预计日期缺失 ' + q.missingDueCount + ' 条、日期异常 ' + q.invalidDateCount + ' 处；具体影响以有效日期样本为准。'];
        if (q.unknownTypeCount) notes.push('未知或空类型 ' + q.unknownTypeCount + ' 条未计入故障，需要核对原记录类型。');
        if (q.missingIdCount || q.duplicateCount || q.conflictCount) notes.push('缺源ID ' + q.missingIdCount + ' 条（按原行保留）；同ID同内容去除额外行 ' + q.duplicateCount + ' 条；冲突ID组 ' + q.conflictCount + ' 组已排除计量，不能把排除当作无故障。');
        if (q.statusConflictCount || q.malformedEquipmentCount) notes.push('状态/完成日期矛盾 ' + q.statusConflictCount + ' 条，异常设备结构 ' + q.malformedEquipmentCount + ' 处；请先核对，不自动修正。');
        var issues = (q.issues || []).slice(0, 10).map(function (issue) { return typeof issue === 'string' ? issue : (text(issue.code) ? text(issue.code) + ' · ' : '') + text(issue.text); });
        if ((q.issues || []).length > 10) issues.push('另有 ' + (q.issues.length - 10) + ' 条待核提示，此处仅列前10条。');
        el('quality-issues').innerHTML = notes.concat(issues).map(function (note) { return '<li>' + esc(note) + '</li>'; }).join('');
    }
    function canExport() {
        var session = EquipApi.session();
        return !!(session && state.exportToken && session.token === state.exportToken && !session.must_change_pwd && !session.guest && EquipApi.role() === 'admin');
    }
    function reportOptions() {
        var type = el('report-type').value;
        return { type: type, value: el(type === 'year' ? 'report-year' : 'report-month').value,
            department: state.applied.department, family: state.applied.family, loadedAt: state.loadedAt, asOf: state.asOf, asOfTime: state.asOfTime };
    }
    function showReportScope() {
        var annual = el('report-type').value === 'year';
        el('report-month-field').hidden = annual; el('report-month').disabled = annual;
        el('report-year-field').hidden = !annual; el('report-year').disabled = !annual;
        var opt = reportOptions();
        try {
            var p = EquipReport.periods(opt.type, opt.value, opt.asOf);
            el('report-scope').textContent = (annual ? '年报' : '月报') + ' · ' + p.start + ' 至 ' + p.end + ' · '
                + (opt.department || '全部部门') + ' · ' + (opt.family || '全部设备类别') + ' · 故障维修';
        } catch (error) { el('report-scope').textContent = error.message; }
    }
    function toggleReportForm() {
        if (!canExport() || !state.applied) return;
        var form = el('report-form');
        form.hidden = !form.hidden;
        el('report-toggle').setAttribute('aria-expanded', String(!form.hidden));
        if (form.hidden) return;
        var end = state.result.period.end;
        el('report-type').value = state.period === 'year' ? 'year' : 'month';
        el('report-month').value = end.slice(0, 7); el('report-month').max = state.asOf.slice(0, 7);
        el('report-year').value = end.slice(0, 4); el('report-year').max = state.asOf.slice(0, 4);
        el('report-status').textContent = ''; showReportScope(); el('report-type').focus();
    }
    function loadReportWriter() {
        if (window.XLSX) return Promise.resolve();
        return new Promise(function (resolve, reject) {
            var script = document.createElement('script');
            script.src = el('report-download').dataset.src;
            script.onload = function () { script.remove(); window.XLSX ? resolve() : reject(Error('Excel 组件初始化失败，请重试。')); };
            script.onerror = function () { script.remove(); reject(Error('Excel 组件加载失败，请重试。')); };
            document.head.appendChild(script);
        });
    }
    async function downloadReport(event) {
        event.preventDefault();
        var button = el('report-download'), seq = state.sequence;
        if (button.disabled || !canExport() || !state.applied || state.loading) return;
        button.disabled = true;
        try {
            var opt = reportOptions();
            EquipReport.periods(opt.type, opt.value, opt.asOf);
            el('report-status').textContent = '正在生成报表…';
            var verified = await refreshSession(seq);
            if (seq !== state.sequence) return;
            if (!verified || !verified.ok || !canExport()) { load(); return; }
            await loadReportWriter();
            if (seq !== state.sequence || !canExport()) return;
            var wb = EquipReport.build(window.XLSX, state.equipments, opt);
            var filename = ['设备维修' + (opt.type === 'year' ? '年报' : '月报'), opt.value, opt.department || '全部部门', opt.family || '全部类别']
                .join('_').replace(/[\\/:*?"<>|]/g, '_') + '.xlsx';
            var bytes = EquipReportCharts.bytes(window.XLSX, wb);
            var url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
            var anchor = document.createElement('a');
            anchor.href = url; anchor.download = filename;
            document.body.appendChild(anchor); anchor.click(); anchor.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
            el('report-status').textContent = '已生成 ' + filename;
        } catch (error) { if (seq === state.sequence) el('report-status').textContent = error.message || '导出失败，请重试。'; }
        finally { if (seq === state.sequence) button.disabled = false; }
    }
    function render() {
        if (!state.equipments) return;
        var start = el('date-start').value, end = el('date-end').value;
        try {
            var startMs = EquipAnalysis.parseDate(start), endMs = EquipAnalysis.parseDate(end);
            if (startMs == null || endMs == null) throw Error('请输入有效的开始和结束日期。');
            if (endMs - startMs > 36600 * 86400000) throw Error('自定义区间过长，请选择100年以内的范围。');
            var result = EquipAnalysis.analyze(state.equipments, { asOf: state.asOf, asOfTime: state.asOfTime, start: start, end: end, department: el('department').value, family: el('family').value, serviceType: el('service-type').value });
            state.result = result; el('filter-error').hidden = true;
            state.applied = { department: el('department').value, family: el('family').value };
            el('report-toggle').hidden = !canExport();
            if (!el('report-form').hidden) { el('report-status').textContent = ''; showReportScope(); }
            el('source-time').textContent = '读取完成 ' + state.loadedAt + ' · 北京时间';
            el('range-caption').textContent = '已应用：' + start + ' — ' + end + ' · ' + (el('department').value || '全部部门') + ' · ' + (el('family').value || '全部类别') + '；当前积压截至 ' + state.asOf;
            renderSummary(result); renderTables(result); renderTrend(); renderQuality(result); renderServices(result); renderFaultInsights(result);
        } catch (error) { el('filter-error').textContent = (error && error.message) || '统计失败，请检查范围。'; el('filter-error').hidden = false; }
    }
    function init() {
        el('report-toggle').addEventListener('click', toggleReportForm);
        el('report-form').addEventListener('submit', downloadReport);
        el('report-form').addEventListener('input', function () { el('report-status').textContent = ''; showReportScope(); });
        el('refresh-data').addEventListener('click', load); el('retry-data').addEventListener('click', load);
        el('analysis-filters').addEventListener('submit', function (event) { event.preventDefault(); render(); });
        el('reset-filters').addEventListener('click', function () { el('department').value = ''; el('family').value = ''; el('trend-grain').value = 'auto'; el('service-type').value = 'fault'; selectPeriod('month', true); });
        document.querySelectorAll('[data-period]').forEach(function (button) { button.addEventListener('click', function () { selectPeriod(button.getAttribute('data-period'), true); }); });
        ['date-start', 'date-end'].forEach(function (id) { el(id).addEventListener('change', function () { selectPeriod('custom', false); }); });
        el('trend-grain').addEventListener('change', renderTrend);
        document.querySelectorAll('[data-priority-mode]').forEach(function (button) { button.addEventListener('click', function () { setPriorityMode(button.getAttribute('data-priority-mode')); }); });
        el('priority-categories').addEventListener('toggle', toggleCategory, true);
        document.querySelectorAll('[data-insight]').forEach(function (button) {
            button.addEventListener('click', function () {
                state.insight = button.dataset.insight;
                if (state.result) renderFaultInsights(state.result);
            });
        });
        el('insight-results').addEventListener('toggle', toggleReason, true);
        el('service-type').addEventListener('change', render);
        ['service-modes', 'service-employees', 'service-suppliers', 'service-unverified'].forEach(function (id) { el(id).addEventListener('toggle', toggleService, true); });
        window.addEventListener('storage', function (event) { if (event.key === 'roi_session' || event.key === null) load(); });
        window.addEventListener('pageshow', function (event) { if (event.persisted) load(); });
        load();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
