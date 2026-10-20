/**
 * 设备履历卡 - 界面逻辑(v2)
 * 角色:manage 管理/维修 | report 报修人(仅扫码单台) | view 普通账号(仅设备基本状况)
 */
var EQ = {};
var ROLE = 'none';
var currentCode = '';
var currentRecordId = '';
var editingArchive = false;
var taskFilter = ''; // '' | 'open'
var pendingWo = '';  // 群消息里带过来的工单号(?wo=),进页面后自动定位到该单

var TYPES = { fault: { txt: '故障维修' }, maintain: { txt: '定期保养' }, overhaul: { txt: '大修' }, modify: { txt: '改造' }, inspect: { txt: '点检' } };
var STATUS_TXT = { active: '在用', idle: '闲置', scrapped: '报废' };
var CAT_TXT = { prod: '生产设备', admin: '行政设施', facility: '系统设施', misc: '事务杂项' };
var HANDLE_TXT = { replace: '更换', repair: '维修', other: '其他' };
var QUICK_SYMPTOMS = ['伺服报警停机', '气缸漏气', '传感器无信号', '定位精度偏差', '异响', '过热', '通讯中断', '皮带跑偏', '按钮开关故障', '照明灯不亮', '漏油', '气管漏气'];

// 三级分类字典(来自现有《设备维修跟踪记录表》数据分析统计2)
var CATS = [
    ["生产设备设施维修维护", "设备电气故障", "电气线路故障"],
    ["生产设备设施维修维护", "设备电气故障", "电气元件故障"],
    ["生产设备设施维修维护", "设备电气故障", "电气控制系统故障"],
    ["生产设备设施维修维护", "设备电气故障", "温控加热系统故障"],
    ["生产设备设施维修维护", "设备电气故障", "电气部件故障"],
    ["行政设备设施维修维护", "照明线路设施维修维护", "照明灯具耗损"],
    ["行政设备设施维修维护", "照明线路设施维修维护", "照明线路故障(短路、开路、漏电)"],
    ["生产设备设施维修维护", "照明线路设施维修维护", "加装照明灯或插座线路"],
    ["生产设备设施维修维护", "设备升级优化改造", "电气相关升级优化改造"],
    ["生产设备设施维修维护", "设备电气故障", "其他电气故障"],
    ["生产设备设施维修维护", "设备机械故障", "运动部件磨损、疲劳"],
    ["生产设备设施维修维护", "设备机械故障", "结构部件磨损、损坏"],
    ["生产设备设施维修维护", "设备机械故障", "紧固连接部件松动、开断裂损坏"],
    ["生产设备设施维修维护", "设备机械故障", "润滑不良"],
    ["生产设备设施维修维护", "设备机械故障", "润滑系统故障"],
    ["生产设备设施维修维护", "设备机械故障", "设备脏污、锈蚀等"],
    ["生产设备设施维修维护", "设备机械故障", "其他机械故障"],
    ["生产设备设施维修维护", "设备液压故障", "液压油泄漏"],
    ["生产设备设施维修维护", "设备液压故障", "液压部件故障"],
    ["生产设备设施维修维护", "设备液压故障", "其他液压故障"],
    ["生产设备设施维修维护", "设备气动系统故障", "气动管路、接头损坏泄漏"],
    ["生产设备设施维修维护", "设备气动系统故障", "气动控制部件故障"],
    ["生产设备设施维修维护", "设备气动系统故障", "气动执行元件(气缸)故障"],
    ["生产设备设施维修维护", "设备气动系统故障", "其他气动控制故障"],
    ["生产设备设施维修维护", "设备机械故障", "机构卡料或运行异常"],
    ["生产设备设施维修维护", "其他故障", "设备操作不当"],
    ["生产设备设施维修维护", "操作调机调试异常", "设备运行调机调试"],
    ["生产设备设施维修维护", "设备给排水管路系统故障", "设备给排水管路故障"],
    ["生产设备设施维修维护", "设备给排水管路系统故障", "设备给排水部件故障损坏"],
    ["生产设备设施维修维护", "设备计划维修保养", "设备计划维修"],
    ["生产设备设施维修维护", "设备计划维修保养", "设备计划保养"],
    ["生产设备设施维修维护", "设备电气线路拆装", "设备电气拆装"],
    ["生产设备设施维修维护", "设备升级优化改造", "设备升级改造或加装零部件"],
    ["生产设备设施维修维护", "其他故障", "其他原因导致故障"],
    ["其他设备设施维修维护", "其他故障", "车间协助工作"],
    ["生产设备设施维修维护", "其他故障", "未检查出异常"],
    ["行政设备设施维修维护", "行政设备维修维护", "行政设施给排水管路故障"],
    ["行政设备设施维修维护", "行政设备维修维护", "龙头阀门类故障损坏"],
    ["行政设备设施维修维护", "行政设备维修维护", "行政设备设施故障损坏"],
    ["行政设备设施维修维护", "行政设备维修维护", "其他行政协助工作"],
    ["降温设备设施维修维护", "风扇风机设备维修维护", "风扇电机短路故障"],
    ["降温设备设施维修维护", "风扇风机设备维修维护", "风扇其他部件故障损坏"],
    ["降温设备设施维修维护", "空调设备维修维护", "空调设备维修维护"],
    ["特种设备设施维修维护", "空压机维修维护", "空压机维修维护"],
    ["特种设备设施维修维护", "配电房设备维修维护", "配电房设备维修维护"],
    ["特种设备设施维修维护", "行车维修维护", "行车维修维护"],
    ["特种设备设施维修维护", "电梯类设备维修维护", "电梯维修维护"],
    ["特种设备设施维修维护", "叉车类设备维修维护", "叉车类设备维修维护"]
];

// ---------- 基础工具 ----------
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function money(n) { return '¥' + (Number(n) || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 }); }
function num(n) { return Number(n) || 0; }
function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function addDays(dateStr, n) { var d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function daysBetween(a, b) { if (!a || !b) return 0; return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000); }
function showToast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(window._toastT);
    window._toastT = setTimeout(function () { t.classList.remove('show'); }, 2400);
}
function switchView(name) {
    var vs = document.querySelectorAll('.view');
    for (var i = 0; i < vs.length; i++) vs[i].classList.remove('show');
    var el = $('view-' + name);
    if (el) el.classList.add('show');
    window.scrollTo(0, 0);
}
function getQuery(k) { var m = location.search.match(new RegExp('[?&]' + k + '=([^&]*)')); return m ? decodeURIComponent(m[1]) : ''; }

// ---------- 角色能力 ----------
function caps() {
    return {
        seeList: ROLE === 'admin' || ROLE === 'repairer',
        manageDevices: ROLE === 'admin',      // 建档/改档/删除/二维码/导出/群设置
        handleOrders: ROLE === 'admin' || ROLE === 'repairer', // 完成登记/编辑记录
        canReport: ROLE === 'admin' || ROLE === 'repairer' || ROLE === 'reporter',
        setExpected: ROLE === 'admin',        // 预计完成仅设备管理员可填
        seeMoney: ROLE === 'admin' || ROLE === 'repairer'
    };
}

// ---------- 记录状态 ----------
function isDone(r) { return (r.status || (r.doneAt ? 'done' : 'open')) === 'done'; }
function isDelayed(r) { return isDone(r) && r.expectedAt && r.doneAt && r.doneAt > r.expectedAt; }
function delayDays(r) { return isDelayed(r) ? daysBetween(r.expectedAt, r.doneAt) : 0; }

// 已完成但仍缺设备管理员该填的东西(故障分类 / 延期原因)→ 待补全
function needFinish(r) {
    if (!isDone(r)) return false;
    if (!r.cause3) return true;
    if (isDelayed(r) && !r.delayReason) return true;
    return false;
}

// 进度回应:每条形如「10-20 15:05 许仕喜 已安排外协明天来检修」
function renderUpdates(r) {
    var us = (r && r.updates) || [];
    if (!us.length) return '';
    var h = '';
    for (var i = 0; i < us.length; i++) {
        var u = us[i] || {};
        h += '<div class="tl-update">'
            + '<span class="tl-update-at">' + esc(String(u.at || '').slice(5)) + '</span>'
            + (u.by ? '<span class="tl-update-by">' + esc(u.by) + '</span>' : '')
            + '<span class="tl-update-text">' + esc(u.text || '') + '</span>'
            + '</div>';
    }
    return h;
}

function computeStats(recs) {
    recs = recs || [];
    var total = recs.length, open = 0, done = 0, delayed = 0, daysSum = 0, daysCnt = 0, cost = 0, byType = {};
    for (var i = 0; i < recs.length; i++) {
        var r = recs[i];
        if (isDone(r)) {
            done++;
            if (isDelayed(r)) delayed++;
            if (r.reportAt && r.doneAt) { daysSum += daysBetween(r.reportAt, r.doneAt); daysCnt++; }
        } else open++;
        cost += num(r.cost);
        var t = r.type || 'fault';
        byType[t] = (byType[t] || 0) + 1;
    }
    return {
        total: total, open: open, done: done, delayed: delayed,
        timelyRate: done > 0 ? (done - delayed) / done : null,
        avgDays: daysCnt > 0 ? daysSum / daysCnt : null,
        cost: cost, byType: byType
    };
}

// ---------- 启动 ----------
function eqInit() {
    // 预览/演示:?demo=1 时注入演示身份(file:// 下跨文件 sessionStorage 可能不共享)
    // 叠加 &demoRole=repairer|reporter|view 可预览不同权限下的界面
    if (getQuery('demo') === '1') {
        var dr = getQuery('demoRole') || 'admin';
        var demoMap = {
            admin: { tools: ['roi', 'equipment-admin'], name: '演示·设备管理员' },
            repairer: { tools: ['roi', 'equipment'], name: '演示·维修人' },
            reporter: { tools: ['roi', 'equipment-report'], name: '演示·报修人' },
            view: { tools: ['roi'], name: '演示·只读账号' }
        };
        if (!demoMap[dr]) dr = 'admin';
        var demoUser = {
            token: 'demo', account: 'demo-' + dr,
            name: demoMap[dr].name, level: 1, tools: demoMap[dr].tools
        };
        EquipApi.demoSession(demoUser);   // 内存兜底,优先于 sessionStorage
        try { sessionStorage.setItem('roi_session', JSON.stringify(demoUser)); } catch (e) { }
    }
    var s = EquipApi.session();
    if (!s) {
        var next = 'equipment/index.html' + (getQuery('code') ? ('?code=' + getQuery('code')) : '');
        location.href = '../login.html?next=' + encodeURIComponent(next);
        return;
    }
    try { localStorage.setItem('last_tool', 'equipment'); } catch (e) { }
    // 云端模式先刷新一次会话,管理员刚改的权限可立即生效
    if (EqConfig.cloud && s.token && s.token !== 'demo') {
        EquipApi.refresh().then(function (r) {
            // 账号被停用/删除或 token 过期:清掉本地登录态,回登录页
            if (r && r.ok === false && (r.msg || '').indexOf('未登录') > -1) {
                try { sessionStorage.removeItem('roi_session'); } catch (e) { }
                try { localStorage.removeItem('roi_session'); } catch (e) { }
                location.href = '../login.html?next=' + encodeURIComponent('equipment/index.html');
                return;
            }
            eqBoot();
        }, eqBoot);
    } else {
        eqBoot();
    }
}
function eqBoot() {
    ROLE = EquipApi.role();
    pendingWo = getQuery('wo');
    var u = EquipApi.user();
    $('eq-user').textContent = (u && u.name) || '';
    $('eq-role').textContent = ROLE === 'admin' ? '设备管理员' : ROLE === 'repairer' ? '维修人' : ROLE === 'reporter' ? '报修人' : '只读';
    $('eq-role').className = 'role-chip role-' + ROLE;

    if (caps().seeList) {
        document.body.classList.add(ROLE === 'admin' ? 'is-admin' : 'is-repairer');
        EquipApi.listAll().then(function (r) {
            if (!r.ok) { showDenied(r.msg || '无权限'); return; }
            EQ = r.equipments || {};
            renderList();
            renderTodoBadge();
            var code = getQuery('code');
            if (code && EQ[code]) openDetail(code, true);
            else showListDefault();
            // 预览用:?demoView=report|record|labels|complete:<id>
            var dv = getQuery('demoView');
            if (dv && code && EQ[code]) {
                if (dv === 'report') openReportForm(code);
                else if (dv === 'record') openRecordForm();
                else if (dv === 'labels') showLabels([code]);
                else if (dv.indexOf('complete:') === 0) openCompleteForm(dv.substring(9));
            }
        });
    } else {
        document.body.classList.add('is-' + ROLE);
        var code = getQuery('code');
        if (!code) { switchView('scan'); return; }
        EquipApi.getDevice(code).then(function (r) {
            if (!r.ok) { showDenied(r.msg || '设备不存在'); return; }
            currentCode = code;
            renderLimitedDetail(r.equipment, r.role);
        });
    }
}
function showDenied(msg) {
    $('denied-msg').textContent = msg || '无访问权限';
    switchView('denied');
}
function showListDefault() {
    $('detail-content').innerHTML = '<div class="empty">从左侧选择设备,或点「新增设备」建档</div>';
    switchView('list');
}

// 群消息带了 &wo=WO...:滚动到该工单并短暂高亮
function focusWo() {
    if (!pendingWo) return;
    var wo = pendingWo;
    pendingWo = '';
    var el = document.querySelector ? document.querySelector('[data-no="' + wo + '"]') : null;
    if (!el) return;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) { }
    el.classList.add('tl-hit');
    setTimeout(function () { el.classList.remove('tl-hit'); }, 2600);
}

// ---------- 列表(manage) ----------
function renderList() {
    var q = ($('f-q').value || '').trim().toLowerCase();
    var line = $('f-line').value;
    var cat = $('f-cat').value;
    var lines = {};
    for (var c in EQ) if (EQ[c].line) lines[EQ[c].line] = 1;
    var opts = '<option value="">全部部门</option>';
    for (var l in lines) opts += '<option value="' + esc(l) + '"' + (l === line ? ' selected' : '') + '>' + esc(l) + '</option>';
    $('f-line').innerHTML = opts;

    var codes = Object.keys(EQ).filter(function (c) {
        var e = EQ[c];
        if (line && e.line !== line) return false;
        if (cat && (e.category || 'prod') !== cat) return false;
        if (taskFilter === 'open' && !(e.records || []).some(function (r) { return !isDone(r); })) return false;
        if (taskFilter === 'pending' && !(e.records || []).some(needFinish)) return false;
        if (!q) return true;
        return (c + ' ' + (e.name || '') + ' ' + (e.number || '') + ' ' + (e.line || '')).toLowerCase().indexOf(q) > -1;
    });
    codes.sort(function (a, b) { return a < b ? -1 : 1; });
    $('eq-count').textContent = '共 ' + codes.length + ' 台';
    if (!codes.length) {
        $('eq-list').innerHTML = '<div class="empty">' + (Object.keys(EQ).length ? '没有匹配的设备' : '还没有设备,点「新增设备」开始建档') + '</div>';
        return;
    }
    var html = '';
    for (var i = 0; i < codes.length; i++) {
        var c = codes[i], e = EQ[c];
        var st = computeStats(e.records);
        html += '<div class="eq-card' + (c === currentCode ? ' active' : '') + '" onclick="openDetail(\'' + esc(c) + '\')">'
            + '<div class="eq-card-main">'
            + '<div class="eq-card-name">' + esc(e.name || '(未命名)')
            + '<span class="st st-' + esc(e.status || 'active') + '">' + esc(STATUS_TXT[e.status] || '在用') + '</span>'
            + (st.open ? '<span class="st st-open">进行中 ' + st.open + '</span>' : '')
            + '</div>'
            + '<div class="eq-card-sub">' + esc(e.number || c) + ' · ' + esc(e.line || '未分部门') + ' · ' + st.total + ' 条记录</div>'
            + '</div>'
            + '<div class="eq-card-stat"><div class="eq-card-cost">' + money(st.cost) + '</div><div class="eq-card-cost-label">累计费用</div></div>'
            + '</div>';
    }
    $('eq-list').innerHTML = html;
}
function setTaskFilter(f) {
    taskFilter = (taskFilter === f ? '' : f);
    $('btn-todo').classList.toggle('active', taskFilter === 'open');
    var bf = $('btn-finish');
    if (bf) bf.classList.toggle('active', taskFilter === 'pending');
    renderList();
}
function renderTodoBadge() {
    var n = 0, m = 0;
    for (var c in EQ) (EQ[c].records || []).forEach(function (r) {
        if (!isDone(r)) n++;
        else if (needFinish(r)) m++;
    });
    $('todo-count').textContent = n;
    $('btn-todo').style.display = n > 0 ? '' : 'none';
    var bf = $('btn-finish');
    if (bf) {
        $('finish-count').textContent = m;
        bf.style.display = m > 0 ? '' : 'none';
    }
}

// ---------- 详情 ----------
function openDetail(code) {
    currentCode = code;
    EquipApi.getDevice(code).then(function (r) {
        if (!r.ok) { showToast(r.msg || '加载失败'); return; }
        if (r.role === 'admin' || r.role === 'repairer') {
            EQ[code] = r.equipment;
            renderManageDetail(r.equipment);
        } else {
            renderLimitedDetail(r.equipment, r.role);
        }
    });
}
function renderManageDetail(e) {
    var C = caps();
    var recs = (e.records || []).slice().sort(function (a, b) {
        var da = isDone(a) ? (a.doneAt || '') : (a.reportAt || '');
        var db = isDone(b) ? (b.doneAt || '') : (b.reportAt || '');
        return da < db ? 1 : -1;
    });
    var st = computeStats(recs);
    var head = '<div class="detail-head">'
        + '<div class="detail-title">' + esc(e.name || '(未命名)')
        + '<span class="st st-' + esc(e.status || 'active') + '">' + esc(STATUS_TXT[e.status] || '在用') + '</span>'
        + '<span class="cat-chip">' + esc(CAT_TXT[e.category || 'prod']) + '</span></div>'
        + '<div class="detail-meta">'
        + (e.number ? ('编号 ' + esc(e.number) + ' · ') : '') + esc(e.line || '未分部门')
        + (e.model ? (' · 型号 ' + esc(e.model)) : '')
        + (e.owner ? (' · 设备责任人 ' + esc(e.owner)) : '')
        + (e.installDate ? (' · 投用 ' + esc(e.installDate)) : '')
        + '</div>'
        + '<div class="detail-actions">'
        + (C.canReport ? '<button class="btn btn-primary btn-sm" onclick="openReportForm(\'' + esc(e.code) + '\')">＋ 报修</button>' : '')
        + (C.handleOrders ? '<button class="btn btn-sm" onclick="openRecordForm()">登记完成/保养</button>' : '')
        + (C.manageDevices ? '<button class="btn btn-sm" onclick="openArchiveForm(\'' + esc(e.code) + '\')">编辑档案</button>' : '')
        + (C.manageDevices ? '<button class="btn btn-sm" onclick="showLabels([\'' + esc(e.code) + '\'])">二维码</button>' : '')
        + (C.manageDevices ? '<button class="btn btn-sm" onclick="openAudit()">编辑记录</button>' : '')
        + (C.manageDevices ? '<button class="btn btn-danger btn-sm" onclick="deleteEquipment(\'' + esc(e.code) + '\')">删除</button>' : '')
        + '</div></div>';

    var stats = '<div class="stat-grid">'
        + (C.seeMoney ? '<div class="stat-box"><div class="stat-label">累计费用</div><div class="stat-value">' + money(st.cost) + '</div></div>' : '')
        + '<div class="stat-box"><div class="stat-label">进行中</div><div class="stat-value' + (st.open ? ' warn' : '') + '">' + st.open + ' 单</div></div>'
        + '<div class="stat-box"><div class="stat-label">完成 / 总数</div><div class="stat-value">' + st.done + ' / ' + st.total + '</div></div>'
        + '<div class="stat-box"><div class="stat-label">及时率</div><div class="stat-value">' + (st.timelyRate === null ? '—' : (st.timelyRate * 100).toFixed(1) + '%') + '</div></div>'
        + '<div class="stat-box"><div class="stat-label">平均维修天数</div><div class="stat-value">' + (st.avgDays === null ? '—' : st.avgDays.toFixed(1) + ' 天') + '</div></div>'
        + '<div class="stat-box"><div class="stat-label">延期单数</div><div class="stat-value">' + st.delayed + '</div></div>'
        + '</div>';

    var tl = '';
    if (!recs.length) tl = '<div class="empty">还没有记录</div>';
    else {
        tl = '<div class="timeline">';
        for (var i = 0; i < recs.length; i++) {
            var r = recs[i], done = isDone(r), delayed = isDelayed(r);
            tl += '<div class="tl-item"' + (r.no ? ' data-no="' + esc(r.no) + '"' : '') + '>'
                + '<div class="tl-dot ' + (done ? (r.type || 'fault') : 'open') + '"></div>'
                + '<div class="tl-body">'
                + '<div class="tl-flow">'
                + (r.no ? '<span class="tl-no" title="工单号,群消息里的这个编号与本单对应">' + esc(r.no) + '</span>' : '')
                + (r.reportAt
                    ? '<div class="tl-flow-item"><span class="tl-flow-label">报修</span><span class="tl-flow-date">' + esc(r.reportAt) + '</span>'
                        + (r.reportBy ? '<span class="tl-flow-by">' + esc(r.reportBy) + '</span>' : '') + '</div>'
                    : '<div class="tl-flow-item"><span class="tl-flow-label">登记</span><span class="tl-flow-date">' + esc(r.doneAt || '') + '</span></div>')
                + (done
                    ? '<span class="tl-arrow">→</span><div class="tl-flow-item done"><span class="tl-flow-label">完成</span><span class="tl-flow-date">' + esc(r.doneAt || '') + '</span>'
                        + (r.handler ? '<span class="tl-flow-by">' + esc(r.handler) + '</span>' : '') + '</div>'
                    : '<span class="tl-arrow">→</span><div class="tl-flow-item open"><span class="tl-flow-label">完成</span><span class="tl-flow-date muted">未完成</span>'
                        + (r.expectedAt ? '<span class="tl-flow-by">预计 ' + esc(r.expectedAt) + '</span>' : '') + '</div>')
                + '<span class="tl-type">' + esc((TYPES[r.type] || TYPES.fault).txt) + '</span>'
                + (done ? '' : '<span class="tl-type tl-open">进行中</span>')
                + (!done && r.updates && r.updates.length ? '<span class="tl-type tl-replied">已回应</span>' : '')
                + (delayed ? '<span class="tl-type tl-delay">延期 ' + delayDays(r) + ' 天</span>' : '')
                + (done && C.manageDevices && needFinish(r) ? '<span class="tl-type tl-todo">待补全</span>' : '')
                + '</div>'
                + '<div class="tl-symptom">' + esc(r.symptom || '(无描述)') + '</div>'
                + renderUpdates(r)
                + (r.cause3 ? '<div class="tl-sub">分类:' + esc(r.cause1) + ' / ' + esc(r.cause2) + ' / ' + esc(r.cause3) + '</div>' : '')
                + (r.action ? '<div class="tl-sub">处理:' + esc(r.action) + '</div>' : '')
                + ((r.parts && r.parts.length) ? '<div class="tl-sub">备件:' + r.parts.map(function (p) { return esc(p.name) + (p.qty ? '×' + p.qty : ''); }).join('、') + '</div>' : '')
                + (r.supplier ? '<div class="tl-sub">外协:' + esc(r.supplier) + '</div>' : '')
                + (num(r.cost) ? '<div class="tl-money">费用 ' + money(r.cost) + '</div>' : '')
                + (delayed && r.delayReason ? '<div class="tl-sub">延期原因:' + esc(r.delayReason) + '</div>' : '')
                + '<div class="tl-top" style="margin-top:6px">'
                + (!done && C.handleOrders ? '<span class="tl-act" onclick="openReplyForm(\'' + esc(r.id) + '\')">回应 / 安排</span>' : '')
                + (!done && C.handleOrders ? '<span class="tl-act" onclick="openCompleteForm(\'' + esc(r.id) + '\')">完成登记</span>' : '')
                + (C.handleOrders ? '<span class="tl-act" onclick="openRecordForm(\'' + esc(r.id) + '\')">编辑</span>' : '')
                + (!done && C.setExpected ? '<span class="tl-act" onclick="setExpected(\'' + esc(r.id) + '\')">设置预计完成</span>' : '')
                + (C.manageDevices ? '<span class="tl-act danger" onclick="deleteRecord(\'' + esc(r.id) + '\')">删除</span>' : '')
                + '</div>'
                + '</div></div>';
        }
        tl += '</div>';
    }

    $('detail-content').innerHTML = head + stats + '<div class="sec-title"><span>工单 / 履历</span><span>' + st.total + ' 条</span></div>' + tl;
    switchView('list');
    if (window.innerWidth < 900) $('detail-panel').scrollIntoView({ behavior: 'auto' });
    focusWo();
}

// 报修人 / 普通账号:受限视图
function renderLimitedDetail(e, role) {
    currentCode = e.code;
    var head = '<div class="detail-head">'
        + '<div class="detail-title">' + esc(e.name || '') + '<span class="st st-' + esc(e.status || 'active') + '">' + esc(STATUS_TXT[e.status] || '在用') + '</span></div>'
        + '<div class="detail-meta">' + (e.number ? ('编号 ' + esc(e.number) + ' · ') : '') + esc(e.line || '') + '</div>'
        + (role === 'reporter' || role === 'report'
            ? '<div class="detail-actions"><button class="btn btn-primary" onclick="openReportForm(\'' + esc(e.code) + '\')">＋ 报修</button></div>'
            : '')
        + '</div>';
    var body = '';
    if (role === 'reporter' || role === 'report') {
        var recs = (e.records || []).slice(0, 20);
        body = '<div class="sec-title">该设备报修情况</div>';
        if (!recs.length) body += '<div class="empty">暂无报修记录</div>';
        else {
            body += '<div class="timeline">';
            for (var i = 0; i < recs.length; i++) {
                var r = recs[i], done = (r.status === 'done');
                body += '<div class="tl-item"' + (r.no ? ' data-no="' + esc(r.no) + '"' : '') + '><div class="tl-dot ' + (done ? '' : 'open') + '"></div><div class="tl-body">'
                    + '<div class="tl-flow">'
                    + (r.no ? '<span class="tl-no">' + esc(r.no) + '</span>' : '')
                    + '<div class="tl-flow-item"><span class="tl-flow-label">报修</span><span class="tl-flow-date">' + esc(r.reportAt || '') + '</span></div>'
                    + '<span class="tl-arrow">→</span>'
                    + '<div class="tl-flow-item ' + (done ? 'done' : 'open') + '"><span class="tl-flow-label">完成</span>'
                    + (done ? '<span class="tl-flow-date">' + esc(r.doneAt || '') + '</span>'
                        : '<span class="tl-flow-date muted">未完成</span>' + (r.expectedAt ? '<span class="tl-flow-by">预计 ' + esc(r.expectedAt) + '</span>' : ''))
                    + '</div>'
                    + (done ? '' : '<span class="tl-type tl-open">待处理</span>')
                    + (!done && r.updates && r.updates.length ? '<span class="tl-type tl-replied">已回应</span>' : '')
                    + '</div>'
                    + '<div class="tl-symptom">' + esc(r.symptom || '') + '</div>'
                    + renderUpdates(r)
                    + '</div></div>';
            }
            body += '</div>';
        }
    } else {
        body = '<div class="notice">你可以查看该设备的基本状况。如需报修或查看维修记录,请联系设备维修人员。</div>';
    }
    $('detail-content').innerHTML = head + body;
    switchView('list');
    if (window.innerWidth < 900) $('detail-panel').scrollIntoView({ behavior: 'auto' });
    focusWo();
}

// ---------- 报修 ----------
function openReportForm(code) {
    currentCode = code || currentCode;
    if (!currentCode) { showToast('请先选择设备'); return; }
    if (!caps().canReport) { showToast('无报修权限'); return; }
    var u = EquipApi.user() || {};
    var nm = (EQ[currentCode] && EQ[currentCode].name) || currentCode;
    $('report-title').textContent = '报修 · ' + nm;
    $('rp-symptom').value = '';
    $('rp-reportBy').value = u.name || '';
    renderReportChips();
    switchView('report');
}
function renderReportChips() {
    var pool = buildSymptomPool();
    var h = '';
    for (var i = 0; i < pool.length; i++) {
        var t = pool[i].t.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        h += '<span class="chip" onclick="addReportSymptom(\'' + t + '\')">' + esc(pool[i].t) + '</span>';
    }
    $('rp-chips').innerHTML = h;
}
function addReportSymptom(t) {
    var el = $('rp-symptom');
    el.value = el.value ? (el.value.replace(/[,,、\s]*$/, '') + ',' + t) : t;
}
function submitReport() {
    var symptom = ($('rp-symptom').value || '').trim();
    if (!symptom) { showToast('请填写故障现象'); return; }
    // 预计完成日期一律由设备管理员后续设置,报修时不采集
    EquipApi.report(currentCode, { symptom: symptom, expectedAt: '', reportBy: ($('rp-reportBy').value || '').trim() }).then(function (r) {
        if (!r.ok) { showToast(r.msg || '提交失败'); return; }
        showToast(r.no ? ('报修已提交 · ' + r.no) : '报修已提交');
        if (caps().seeList) reloadAll(function () { openDetail(currentCode); });
        else openDetail(currentCode);
    });
}

// ---------- 回应报修(暂时修不完,先给报修人一个说法) ----------
var REPLY_CHIPS = ['已安排外协明天来检修', '等待备件到货', '待停机窗口安排', '已联系供应商报价', '需采购审批中', '已现场确认,稍后处理'];

function openReplyForm(recordId) {
    if (!caps().handleOrders) { showToast('仅设备管理员/维修人可回应'); return; }
    var e = EQ[currentCode] || {}, rec = null;
    (e.records || []).forEach(function (r) { if (r.id === recordId) rec = r; });
    if (!rec) return;
    if (isDone(rec)) { showToast('该工单已完成'); return; }
    currentRecordId = recordId;
    $('reply-title').textContent = '回应报修' + (rec.no ? (' · ' + rec.no) : '') + ' · ' + (e.name || '');
    $('rp-text').value = '';
    // 预计完成只有设备管理员能填
    $('rp-expected').value = caps().setExpected ? (rec.expectedAt || '') : '';
    $('rp-expected').disabled = !caps().setExpected;
    renderReplyChips();
    switchView('reply');
}
function renderReplyChips() {
    var h = '';
    for (var i = 0; i < REPLY_CHIPS.length; i++) {
        var t = REPLY_CHIPS[i].replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        h += '<span class="chip" onclick="fillReplyText(\'' + t + '\')">' + esc(REPLY_CHIPS[i]) + '</span>';
    }
    $('rp-text-chips').innerHTML = h;
}
function fillReplyText(t) {
    var el = $('rp-text');
    el.value = el.value ? (el.value.replace(/[,,、\s]*$/, '') + ',' + t) : t;
}
function submitReply() {
    var text = ($('rp-text').value || '').trim();
    if (!text) { showToast('请填写回应内容'); return; }
    var exp = caps().setExpected ? ($('rp-expected').value || '') : '';
    EquipApi.reply(currentCode, currentRecordId, text, exp).then(function (r) {
        if (!r.ok) { showToast(r.msg || '提交失败'); return; }
        showToast('已回应,群里已收到进度');
        reloadAll(function () { openDetail(currentCode); });
    });
}

// 设置预计完成日期(仅设备管理员)
function setExpected(recordId) {
    if (!caps().setExpected) { showToast('仅设备管理员可设置'); return; }
    var e = EQ[currentCode], rec = null;
    (e.records || []).forEach(function (r) { if (r.id === recordId) rec = r; });
    if (!rec) return;
    var cur = rec.expectedAt || '';
    var v = prompt('设置该工单的预计完成日期(YYYY-MM-DD,留空=清除):', cur || addDays(today(), 1));
    if (v === null) return;
    v = (v || '').trim();
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { showToast('日期格式应为 YYYY-MM-DD'); return; }
    rec.expectedAt = v;
    EquipApi.save(currentCode, e, '设置预计完成:' + (v || '清除') + ' ' + (rec.symptom || '').slice(0, 20)).then(function (r) {
        if (!r.ok) { showToast(r.msg || '保存失败'); return; }
        showToast(v ? ('已设置预计完成 ' + v) : '已清除预计完成');
        reloadAll(function () { openDetail(currentCode); });
    });
}

// ---------- 完成登记 / 直接登记 ----------
function openCompleteForm(recordId) {
    if (!caps().handleOrders) return;
    var e = EQ[currentCode], rec = null;
    (e.records || []).forEach(function (r) { if (r.id === recordId) rec = r; });
    if (!rec) return;
    currentRecordId = recordId;
    fillRecordForm(rec, true);
}
function openRecordForm(recordId) {
    if (!caps().handleOrders) return;
    currentRecordId = recordId || '';
    if (recordId) {
        var e = EQ[currentCode], rec = null;
        (e.records || []).forEach(function (r) { if (r.id === recordId) rec = r; });
        if (!rec) return;
        fillRecordForm(rec, false);
    } else {
        var blank = { type: 'maintain', status: 'done', doneAt: today(), reportAt: '', expectedAt: '', repairMode: 'inner', parts: [] };
        fillRecordForm(blank, false);
        $('record-title').textContent = '登记完成 / 保养 · ' + ((EQ[currentCode] || {}).name || '');
    }
}
function fillRecordForm(rec, isComplete) {
    var e = EQ[currentCode] || {};
    var fromReport = isComplete || ((rec.status || '') === 'open');
    $('record-title').textContent = (fromReport ? '完成登记 · ' : '登记记录 · ') + (e.name || '') + (rec.no ? (' · ' + rec.no) : '');
    $('rf-type').value = rec.type || 'fault';
    $('rf-type').disabled = fromReport;
    $('rf-reporting').style.display = fromReport ? '' : 'none';
    if (fromReport) {
        $('rf-reportInfo').textContent = (rec.no ? (rec.no + ' · ') : '') + '报修 ' + (rec.reportAt || '') + ' · ' + (rec.reportBy || '')
            + (rec.expectedAt ? (' · 预计完成 ' + rec.expectedAt) : '');
    }
    $('rf-doneAt').value = rec.doneAt || today();
    $('rf-handler').value = rec.handler || (EquipApi.user() || {}).name || '';
    $('rf-cause').value = rec.cause || '';
    $('rf-action').value = rec.action || '';
    $('rf-handle').value = rec.handleType || (fromReport ? 'repair' : '');
    $('rf-mode').value = rec.repairMode || 'inner';
    $('rf-supplier').value = rec.supplier || '';
    $('rf-supplierWrap').style.display = (rec.repairMode === 'outer') ? '' : 'none';
    $('rf-cost').value = rec.cost || '';
    $('rf-delayReason').value = rec.delayReason || '';
    $('rf-remark').value = rec.remark || '';
    window._parts = (rec.parts || []).map(function (p) { return { name: p.name || '', qty: p.qty || 1 }; });
    renderParts();
    buildCatSelects(rec.cause1, rec.cause2, rec.cause3);
    updateDelayHint(rec.expectedAt || '');
    switchView('record');
}
function buildCatSelects(l1, l2, l3) {
    var s1 = {};
    CATS.forEach(function (c) { s1[c[0]] = 1; });
    $('rf-c1').innerHTML = '<option value="">(未分类)</option>' + Object.keys(s1).map(function (v) { return '<option' + (v === l1 ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('');
    refreshCat2(l1, l2);
    refreshCat3(l1, l2, l3);
}
function refreshCat2(l1, sel) {
    if (l1 === undefined) l1 = $('rf-c1').value;
    var s = {};
    CATS.forEach(function (c) { if (!l1 || c[0] === l1) s[c[1]] = 1; });
    $('rf-c2').innerHTML = '<option value="">(未分类)</option>' + Object.keys(s).map(function (v) { return '<option' + (v === sel ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('');
}
function refreshCat3(l1, l2, sel) {
    if (l2 === undefined) l2 = $('rf-c2').value;
    var s = [];
    CATS.forEach(function (c) { if ((!l1 || c[0] === l1) && (!l2 || c[1] === l2)) s.push(c[2]); });
    $('rf-c3').innerHTML = '<option value="">(未分类)</option>' + s.map(function (v) { return '<option' + (v === sel ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('');
}
function updateDelayHint(expected) {
    var d = $('rf-doneAt').value;
    var late = expected && d && d > expected;
    $('rf-delayWrap').style.display = late ? '' : 'none';
    $('rf-delayHint').textContent = late ? ('已超预计完成 ' + expected + ',延期 ' + daysBetween(expected, d) + ' 天,请填原因') : '';
}
function renderParts() {
    var ps = window._parts || [];
    var h = '';
    for (var i = 0; i < ps.length; i++) {
        h += '<div class="part-row"><div class="part-line">'
            + '<input type="text" placeholder="备件名称" list="part-pool" value="' + esc(ps[i].name) + '" oninput="_parts[' + i + '].name=this.value">'
            + '<input type="number" inputmode="decimal" min="0" step="1" placeholder="数量" value="' + esc(ps[i].qty) + '" oninput="_parts[' + i + '].qty=this.value">'
            + '<button type="button" class="part-del" onclick="_parts.splice(' + i + ',1);renderParts()">✕</button>'
            + '</div></div>';
    }
    h += '<button class="btn btn-block" type="button" onclick="addPart()">＋ 添加备件</button>';
    $('parts-wrap').innerHTML = h;
    renderPartPool();
}
function addPart() { window._parts = window._parts || []; window._parts.push({ name: '', qty: 1 }); renderParts(); }
function renderPartPool() {
    var names = {};
    for (var c in EQ) (EQ[c].records || []).forEach(function (r) { (r.parts || []).forEach(function (p) { if (p.name) names[p.name] = 1; }); });
    $('part-pool').innerHTML = Object.keys(names).map(function (n) { return '<option value="' + esc(n) + '">'; }).join('');
}
function saveRecord() {
    if (!caps().handleOrders) return;
    var e = EQ[currentCode];
    if (!e) return;
    var rs = e.records || [];
    var rec = null;
    for (var i = 0; i < rs.length; i++) if (rs[i].id === currentRecordId) rec = rs[i];
    var isNew = !rec;
    if (isNew) rec = {
        id: 'r' + Date.now(), no: '', status: 'done', reportAt: '', reportBy: '', expectedAt: '',
        photos: [], updates: [],
        cause1: '', cause2: '', cause3: '', cause: '', handleType: '', repairMode: 'inner',
        supplier: '', cost: 0, delayReason: '', remark: '', parts: [],
        createdAt: new Date().toLocaleString('zh-CN'), createdBy: (EquipApi.user() || {}).name || ''
    };
    rec.type = $('rf-type').value;
    rec.status = 'done';
    rec.doneAt = $('rf-doneAt').value || today();
    rec.handler = ($('rf-handler').value || '').trim();
    rec.action = ($('rf-action').value || '').trim();
    rec.remark = ($('rf-remark').value || '').trim();
    rec.parts = (window._parts || []).filter(function (p) { return (p.name || '').trim(); }).map(function (p) { return { name: p.name.trim(), qty: num(p.qty) || 1 }; });
    // 分类/原因、维修类别、外协与费用、延期原因:只有设备管理员能写
    if (caps().manageDevices) {
        rec.cause1 = $('rf-c1').value; rec.cause2 = $('rf-c2').value; rec.cause3 = $('rf-c3').value;
        rec.cause = ($('rf-cause').value || '').trim();
        rec.handleType = $('rf-handle').value;
        rec.repairMode = $('rf-mode').value;
        rec.supplier = ($('rf-supplier').value || '').trim();
        rec.cost = num($('rf-cost').value);
        rec.delayReason = ($('rf-delayReason').value || '').trim();
    }
    rec.updatedAt = new Date().toLocaleString('zh-CN');
    rec.updatedBy = (EquipApi.user() || {}).name || '';
    if (!rec.action) { showToast('请填写处理措施'); return; }
    if (caps().manageDevices && isDelayed(rec) && !rec.delayReason) { showToast('已延期,请填写延期原因'); return; }
    if (isNew) rs.push(rec);
    e.records = rs;
    var summary = (isNew ? '登记记录:' : '完成/修改记录:') + rec.doneAt + ' ' + (rec.symptom || '').slice(0, 30);
    EquipApi.save(currentCode, e, summary).then(function (r) {
        if (!r.ok) { showToast(r.msg || '保存失败'); return; }
        showToast('已保存');
        reloadAll(function () { openDetail(currentCode); });
    });
}
function deleteRecord(recordId) {
    if (!caps().manageDevices) { showToast('仅设备管理员可删除记录'); return; }
    if (!confirm('删除这条记录?操作会留痕。')) return;
    var e = EQ[currentCode];
    var target = null;
    e.records = (e.records || []).filter(function (r) { if (r.id === recordId) { target = r; return false; } return true; });
    EquipApi.save(currentCode, e, '删除记录:' + ((target && (target.symptom || '')) || '').slice(0, 30)).then(function (r) {
        if (!r.ok) { showToast(r.msg || '删除失败'); return; }
        showToast('已删除');
        reloadAll(function () { openDetail(currentCode); });
    });
}

// ---------- 档案 ----------
function openArchiveForm(code) {
    if (!caps().manageDevices) return;
    editingArchive = !!code;
    var e = code ? EQ[code] : { status: 'active', category: 'prod', installDate: today() };
    $('archive-title').textContent = code ? ('编辑档案 · ' + code) : '新增设备';
    $('a-code').value = code || '';
    $('a-code').readOnly = !!code;
    $('a-name').value = e.name || '';
    $('a-number').value = e.number || '';
    $('a-line').value = e.line || '';
    $('a-cat').value = e.category || 'prod';
    $('a-owner').value = e.owner || '';
    $('a-model').value = e.model || '';
    $('a-vendor').value = e.vendor || '';
    $('a-install').value = e.installDate || '';
    $('a-status').value = e.status || 'active';
    $('a-remark').value = e.remark || '';
    switchView('archive');
}
function saveArchive() {
    var code = ($('a-code').value || '').trim();
    var name = ($('a-name').value || '').trim();
    if (!code) { showToast('请填写设备编号'); return; }
    if (!name) { showToast('请填写设备名称'); return; }
    if (!editingArchive && EQ[code]) { showToast('编号已存在'); return; }
    var data = editingArchive ? EQ[code] : { code: code, records: [], photos: [] };
    data.code = code; data.name = name;
    data.number = ($('a-number').value || '').trim();
    data.line = ($('a-line').value || '').trim();
    data.category = $('a-cat').value;
    data.owner = ($('a-owner').value || '').trim();
    data.model = ($('a-model').value || '').trim();
    data.vendor = ($('a-vendor').value || '').trim();
    data.installDate = $('a-install').value || '';
    data.status = $('a-status').value;
    data.remark = ($('a-remark').value || '').trim();
    EquipApi.save(code, data, (editingArchive ? '修改设备档案:' : '新增设备:') + name).then(function (r) {
        if (!r.ok) { showToast(r.msg || '保存失败'); return; }
        showToast('已保存');
        reloadAll(function () { openDetail(code); });
    });
}
function deleteEquipment(code) {
    if (!caps().manageDevices) return;
    if (!confirm('确定删除设备【' + ((EQ[code] || {}).name || code) + '】?该设备全部记录会一起删除,操作会留痕。')) return;
    EquipApi.remove(code).then(function (r) {
        if (!r.ok) { showToast(r.msg || '删除失败'); return; }
        delete EQ[code]; currentCode = '';
        renderList(); renderTodoBadge(); showListDefault(); showToast('已删除');
    });
}

// ---------- 留痕 ----------
function openAudit() {
    EquipApi.auditList(currentCode).then(function (r) {
        var logs = (r && r.logs) || [], h = '';
        if (!logs.length) h = '<div class="empty">暂无编辑记录</div>';
        else {
            h = '<div class="timeline">';
            for (var i = 0; i < logs.length; i++) {
                var g = logs[i];
                h += '<div class="tl-item"><div class="tl-dot ' + (g.action === 'delete' ? 'fault' : 'maintain') + '"></div><div class="tl-body">'
                    + '<div class="tl-top"><span class="tl-date">' + esc(g.at) + '</span><span class="tl-type">' + esc(g.action === 'delete' ? '删除' : g.action === 'report' ? '报修' : '保存') + '</span><span class="tl-date">' + esc(g.name || g.account) + '</span></div>'
                    + '<div class="tl-sub">' + esc(g.summary || '') + '</div></div></div>';
            }
            h += '</div>';
        }
        $('audit-content').innerHTML = '<div class="sec-title">设备 ' + esc(currentCode) + ' 的编辑记录</div>' + h
            + '<div class="bottom-bar"><button class="btn btn-block" onclick="openDetail(\'' + esc(currentCode) + '\')">返回设备</button></div>';
        switchView('audit');
    });
}

// ---------- 二维码 ----------
function makeQrSvg(text) {
    try {
        var qr = qrcode(0, 'M'); qr.addData(text); qr.make();
        return qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
    } catch (e) { return '<div style="font-size:10px;color:#999">生成失败</div>'; }
}
function eqUrl(code) {
    var base = location.origin + location.pathname.replace(/index\.html$/, '');
    return base + '?code=' + encodeURIComponent(code);
}
function showLabels(codes) {
    codes = codes || Object.keys(EQ);
    if (!codes.length) { showToast('还没有设备'); return; }
    var h = '';
    for (var i = 0; i < codes.length; i++) {
        var c = codes[i], e = EQ[c] || {};
        h += '<div class="label-card"><div class="label-qr">' + makeQrSvg(eqUrl(c)) + '</div>'
            + '<div class="label-info"><div class="label-name">' + esc(e.name || c) + '</div>'
            + '<div class="label-code">' + esc(e.number || c) + (e.line ? (' · ' + esc(e.line)) : '') + '</div></div></div>';
    }
    $('labels-wrap').innerHTML = h;
    switchView('labels');
}
function printLabels() { window.print(); }

// ---------- 导出 xlsx ----------
function exportXlsx() {
    if (!caps().manageDevices) return;
    if (typeof XLSX === 'undefined') { showToast('导出库未加载'); return; }
    var head = ['工单号', '设备名称', '设备编号', '所属部门', '设备类别', '报修人', '报修日期', '预计修复日期', '实际完成时间', '维修跟踪情况通报', '故障原因分析', '维修措施', '故障部件名称', '维修/更换', '内部维修/外协维修', '维修责任人', '外协维修供应商', '状态', '费用', '故障分类1', '故障分类2', '故障分类3', '是否延期', '延时时间(天)', '延时原因', '维修工时(天)'];
    var widths = [14, 16, 12, 10, 10, 9, 12, 13, 13, 42, 24, 28, 16, 10, 14, 10, 14, 8, 10, 20, 22, 24, 8, 12, 14, 12];
    var rows = [head];
    var n = 0;
    Object.keys(EQ).sort().forEach(function (c) {
        var e = EQ[c];
        (e.records || []).slice().sort(function (a, b) { return (a.reportAt || '') < (b.reportAt || '') ? 1 : -1; }).forEach(function (r) {
            var done = isDone(r);
            rows.push([
                r.no || '',
                e.name || '', e.number || '', e.line || '', CAT_TXT[e.category || 'prod'] || '',
                r.reportBy || '', r.reportAt || '', r.expectedAt || '', done ? (r.doneAt || '') : '',
                r.symptom || '', r.cause || '', r.action || '',
                (r.parts || []).map(function (p) { return p.name + (p.qty > 1 ? ('×' + p.qty) : ''); }).join('、'),
                HANDLE_TXT[r.handleType] || '', r.repairMode === 'outer' ? '外协维修' : '内部维修',
                r.handler || '', r.supplier || '', done ? '完成' : '进行中', num(r.cost),
                r.cause1 || '', r.cause2 || '', r.cause3 || '',
                isDelayed(r) ? '延期' : '', delayDays(r), r.delayReason || '',
                (r.reportAt && done) ? daysBetween(r.reportAt, r.doneAt) : ''
            ]);
            n++;
        });
    });
    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = widths.map(function (w) { return { wch: w }; });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '维修记录');
    XLSX.writeFile(wb, '设备维修跟踪记录_' + today() + '.xlsx');
    showToast('已导出 ' + n + ' 条记录');
}

// ---------- 重新加载 ----------
function reloadAll(cb) {
    EquipApi.listAll().then(function (r) {
        if (r.ok) { EQ = r.equipments || {}; renderList(); renderTodoBadge(); }
        if (cb) cb();
    });
}

// ---------- 手动刷新 ----------
// 说明:新报修提醒统一走企业微信群机器人(服务端直发,页面关着也能收到),
// 页面内不再做定时轮询,避免每次刷新拉全量履历浪费流量。
function refreshList() {
    if (!caps().seeList) { location.reload(); return; }
    EquipApi.listAll().then(function (r) {
        if (!r.ok) { showToast(r.msg || '刷新失败'); return; }
        EQ = r.equipments || {};
        renderList(); renderTodoBadge();
        if (currentCode && EQ[currentCode]) openDetail(currentCode);
        showToast('已刷新');
    });
}
function openNotifySettings() {
    if (!caps().manageDevices) { showToast('仅设备管理员可设置群通知'); return; }
    var u = EquipApi.user() || {};
    if (u.account !== 'admin' && u.level !== 1) { showToast('仅管理员可设置群通知'); return; }
    EquipApi.getConfig().then(function (r) {
        if (!r.ok) { showToast(r.msg || '读取失败'); return; }
        var cur = (r.data && r.data.wx_webhook) || '';
        var v = prompt('企业微信群机器人 Webhook 地址(留空=关闭群通知): 例 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx', cur);
        if (v === null) return;
        EquipApi.setConfig('wx_webhook', (v || '').trim()).then(function (x) {
            if (x.ok) {
                showToast(v ? '已保存群通知地址' : '已关闭群通知');
                if (!EqConfig.cloud) showToast('本地模式仅保存配置;云端上线后才会真正推送');
            } else showToast(x.msg || '保存失败');
        });
    });
}

// ---------- 切换工具下拉 ----------
function toggleToolMenu(e){ if(e)e.stopPropagation(); var l=$('tool-menu-list'); if(l)l.classList.toggle('show'); }
document.addEventListener('click',function(){ var l=$('tool-menu-list'); if(l)l.classList.remove('show'); });

// ---------- 折叠 ----------
function toggleFold(el) { el.parentNode.classList.toggle('open'); }

// ---------- 初始化 ----------
window.addEventListener('DOMContentLoaded', function () {
    eqInit();
    var fq = $('f-q'); if (fq) fq.addEventListener('input', renderList);
    var fl = $('f-line'); if (fl) fl.addEventListener('change', renderList);
    var fc = $('f-cat'); if (fc) fc.addEventListener('change', renderList);
    $('rf-doneAt').addEventListener('change', function () {
        var e = EQ[currentCode], rec = null;
        if (e) (e.records || []).forEach(function (r) { if (r.id === currentRecordId) rec = r; });
        updateDelayHint((rec && rec.expectedAt) || '');
    });
    $('rf-c1').addEventListener('change', function () { refreshCat2($('rf-c1').value, ''); refreshCat3($('rf-c1').value, $('rf-c2').value, ''); });
    $('rf-c2').addEventListener('change', function () { refreshCat3($('rf-c1').value, $('rf-c2').value, ''); });
    $('rf-mode').addEventListener('change', function () {
        $('rf-supplierWrap').style.display = this.value === 'outer' ? '' : 'none';
    });
    var folds = document.querySelectorAll('.fold-head');
    for (var i = 0; i < folds.length; i++) folds[i].addEventListener('click', function () { toggleFold(this); });
});

// 现象池:按历史频次自动排序(含同义归并)
function buildSymptomPool() {
    var counts = {};
    for (var c in EQ) {
        (EQ[c].records || []).forEach(function (r) {
            var s = String(r.symptom || '');
            if (!s) return;
            s.split(/[,,、;;\n\r]+/).forEach(function (p) {
                p = p.trim();
                if (p.length < 3 || p.length > 16) return;
                counts[p] = (counts[p] || 0) + 1;
            });
        });
    }
    QUICK_SYMPTOMS.forEach(function (d) { counts[d] = (counts[d] || 0) + 1; });
    var orig = {}; for (var o in counts) orig[o] = counts[o];
    var keys = Object.keys(orig);
    for (var a = 0; a < keys.length; a++) {
        for (var b = 0; b < keys.length; b++) {
            if (a === b) continue;
            if (keys[b].length > keys[a].length && keys[b].indexOf(keys[a]) > -1) counts[keys[a]] += orig[keys[b]];
        }
    }
    var arr = [];
    for (var k in counts) arr.push({ t: k, n: counts[k] });
    arr.sort(function (x, y) { return y.n - x.n || (x.t < y.t ? -1 : 1); });
    return arr.slice(0, 10);
}
