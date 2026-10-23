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
var MY_DEPT = '';    // 报修人:所属车间
var MY_GENERIC = ''; // 报修人:本车间通用报修卡编号
// 时间轴查看口径:
//  通用报修卡(GEN-*) 记录多 → 默认按月(tlYearOnly=false)
//  有编号的设备 → 默认看本年度全部(tlYearOnly=true)
// 两种模式都结转未完成的单
var tlYear = new Date().getFullYear(), tlMonth = new Date().getMonth() + 1;
var tlYearOnly = false, tlLimit = 30;
var rpLimit = 20;   // 报修人视图的"显示更多"步长
// 列表分组展开状态(按设备类别)
var groupOpen = {};
// 设备类别候选(与导入脚本/Excel 分类表一致)
// 这里只是「兜底候选」:实际候选项还会自动并入档案里已出现的 family 值(见 familyOptions)
var FAMILIES = ['冲床/精冲', '车床', '磨削/抛光', '钻攻/钻孔', '注塑机', '注塑辅机', '清洗设备',
    '叉车/搬运', '给排水/通风', '包装设备', '空压机', '加工中心/雕刻机', '线切割/电火花/激光',
    '铆接/打钉', '搓牙/打头/开齿', '送料设备', '热处理/烘干', '自动化专机', '铣床',
    '钣金设备', '泵类', '特种设备', '其他设备', '行政/杂项'];
// 类别候选 = 固定兜底 + 档案里实际出现过的类别(自定义类别自动进候选，避免打错字)
function familyOptions() {
    var seen = {}, out = [];
    for (var i = 0; i < FAMILIES.length; i++) {
        var v = String(FAMILIES[i]).trim();
        if (v && !seen[v]) { seen[v] = 1; out.push(v); }
    }
    var extra = [];
    for (var c in EQ) {
        var f = String((EQ[c] && EQ[c].family) || '').trim();
        if (f && !seen[f]) { seen[f] = 1; extra.push(f); }
    }
    extra.sort();
    return out.concat(extra);
}

// 报修人列表的分组展开状态
var mineGroupOpen = {};

// ---------- 设备类别顺序(置顶 + 拖拽排序;分部门) ----------
// GORDERS = { '':[全部部门那套], '冲压组':[冲压组那套], ... }
// 每一项是 [{n:'冲床/精冲', pin:true}, ...],数组顺序即显示顺序,pin=true 排最前
var GORDERS = {};
var gorderDept = '';      // 「类别排序」页当前在编辑哪个部门
var gorderDraft = null;   // 正在编辑的副本,点保存才写回云端
var gorderDragFrom = -1;

function gorderOf(dept) {
    var a = GORDERS[dept || ''];
    return (a && a.length) ? a : [];
}
function loadGroupOrder() {
    return EquipApi.groupOrderGet().then(function (r) {
        GORDERS = (r && r.ok && r.data) ? r.data : {};
    })['catch'](function () { GORDERS = {}; });
}
// 某个部门实际生效的顺序:本部门那套在前,再补「全部部门」里有、本部门没排的
// 这样部门只排自己关心的几类,其余仍跟着全局走,不会全部打乱
function gorderEffective(dept) {
    var own = gorderOf(dept), all = gorderOf(''), out = [], used = {};
    for (var i = 0; i < own.length; i++) {
        var n = String((own[i] || {}).n || '').trim();
        if (!n || used[n]) continue;
        used[n] = 1;
        out.push({ n: n, pin: !!(own[i] || {}).pin });
    }
    if (dept) {
        for (var j = 0; j < all.length; j++) {
            var m = String((all[j] || {}).n || '').trim();
            if (!m || used[m]) continue;
            used[m] = 1;
            out.push({ n: m, pin: !!(all[j] || {}).pin });
        }
    }
    return out;
}
function gorderMap(dept) {
    var a = gorderEffective(dept), m = {};
    for (var i = 0; i < a.length; i++) m[a[i].n] = i;
    return m;
}
function gorderPin(dept, k) {
    var a = gorderEffective(dept);
    for (var i = 0; i < a.length; i++) if (a[i].n === k) return !!a[i].pin;
    return false;
}
// 组间排序:① 置顶优先 ② 该部门的已保存顺序 ③ 没排过的按 fallback(管理端条数降序 / 报修人端名称升序)
function sortGroupsByOrder(gOrder, fallback, dept) {
    var m = gorderMap(dept);
    gOrder.sort(function (a, b) {
        var pa = gorderPin(dept, a) ? 0 : 1, pb = gorderPin(dept, b) ? 0 : 1;
        if (pa !== pb) return pa - pb;
        var ia = (m[a] == null ? 1e9 : m[a]), ib = (m[b] == null ? 1e9 : m[b]);
        if (ia !== ib) return ia - ib;
        return fallback(a, b);
    });
}

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
    ["特种设备设施维修维护", "叉车类设备维修维护", "叉车类设备维修维护"],
    // 计划维修保养 / 升级优化改造：原先只挂在「生产设备设施维修维护」下，导致行政、降温、特种、
    // 其他一级的设备做保养或改造时三级永远只能选「(未分类)」，必然卡在「待补全」。此处按一级补全。
    ["行政设备设施维修维护", "设备计划维修保养", "设备计划维修"],
    ["行政设备设施维修维护", "设备计划维修保养", "设备计划保养"],
    ["行政设备设施维修维护", "设备升级优化改造", "设备升级改造或加装零部件"],
    ["行政设备设施维修维护", "设备升级优化改造", "电气相关升级优化改造"],
    ["降温设备设施维修维护", "设备计划维修保养", "设备计划维修"],
    ["降温设备设施维修维护", "设备计划维修保养", "设备计划保养"],
    ["降温设备设施维修维护", "设备升级优化改造", "设备升级改造或加装零部件"],
    ["降温设备设施维修维护", "设备升级优化改造", "电气相关升级优化改造"],
    ["特种设备设施维修维护", "设备计划维修保养", "设备计划维修"],
    ["特种设备设施维修维护", "设备计划维修保养", "设备计划保养"],
    ["特种设备设施维修维护", "设备升级优化改造", "设备升级改造或加装零部件"],
    ["特种设备设施维修维护", "设备升级优化改造", "电气相关升级优化改造"],
    ["其他设备设施维修维护", "设备计划维修保养", "设备计划维修"],
    ["其他设备设施维修维护", "设备计划维修保养", "设备计划保养"],
    ["其他设备设施维修维护", "设备升级优化改造", "设备升级改造或加装零部件"],
    ["其他设备设施维修维护", "设备升级优化改造", "电气相关升级优化改造"]
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
            admin: { tools: ['roi', 'equipment-admin'], name: '演示·设备管理员', dept: '' },
            repairer: { tools: ['roi', 'equipment'], name: '演示·维修人', dept: '' },
            reporter: { tools: ['roi', 'equipment-report'], name: '演示·报修人', dept: '水磨组' },
            view: { tools: ['roi'], name: '演示·只读账号', dept: '' }
        };
        if (!demoMap[dr]) dr = 'admin';
        var demoUser = {
            token: 'demo', account: 'demo-' + dr,
            name: demoMap[dr].name, level: 1, tools: demoMap[dr].tools,
            dept: demoMap[dr].dept || ''
        };
        EquipApi.demoSession(demoUser);   // 内存兜底,优先于 sessionStorage
        try { SessionStore.write(JSON.stringify(demoUser)); } catch (e) { }
    }
    var s = EquipApi.session();
    if (!s) {
        var next = 'equipment/index.html' + (getQuery('code') ? ('?code=' + getQuery('code')) : '');
        location.href = '../login.html?next=' + encodeURIComponent(next);
        return;
    }
    // 首登/被重置密码后必须先改密
    if (s.must_change_pwd && !s.guest) {
        location.href = '../changepwd.html?next=' + encodeURIComponent('equipment/index.html');
        return;
    }
    try { localStorage.setItem('last_tool', 'equipment'); } catch (e) { }
    // 云端模式先刷新一次会话,管理员刚改的权限可立即生效
    if (EqConfig.cloud && s.token && s.token !== 'demo') {
        EquipApi.refresh().then(function (r) {
            // 账号被停用/删除或 token 过期:清掉本地登录态,回登录页
            if (r && r.ok === false && (r.msg || '').indexOf('未登录') > -1) {
                try { SessionStore.clear(); } catch (e) { }
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
    $('eq-role').textContent = ROLE === 'admin' ? '设备管理员' : ROLE === 'repairer' ? '维修人' : ROLE === 'reporter' ? ('报修人' + (u && u.dept ? (' · ' + u.dept) : '')) : '只读';
    $('eq-role').className = 'role-chip role-' + ROLE;

    if (caps().seeList) {
        document.body.classList.add(ROLE === 'admin' ? 'is-admin' : 'is-repairer');
        Promise.all([EquipApi.listAll(), loadGroupOrder()]).then(function (res) {
            var r = res[0];
            if (!r.ok) { showDenied(r.msg || '无权限'); return; }
            EQ = r.equipments || {};
            renderList();
            renderTodoBadge();
            var code = getQuery('code');
            if (code && EQ[code]) openDetail(code, true);
            else showListDefault();
            // 群里「今日待办」的链接带 ?todo=1:进来直接只看进行中的单
            if (getQuery('todo') === '1' && taskFilter !== 'open') setTaskFilter('open');
            // 预览用:?demoView=report|record|labels|complete:<id>
            var dv = getQuery('demoView');
            if (dv && code && EQ[code]) {
                if (dv === 'report') openReportForm(code);
                else if (dv === 'record') openRecordForm();
                else if (dv === 'labels') showLabels([code]);
                else if (dv.indexOf('complete:') === 0) openCompleteForm(dv.substring(9));
            }
        });
    } else if (ROLE === 'reporter') {
        // 报修人:登录后直接进「我的车间」,不要求扫码
        document.body.classList.add('is-reporter');
        loadMine(getQuery('code'));
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

// ---------- 报修人:我的车间 ----------
function loadMine(openCode, noAuto) {
    Promise.all([EquipApi.myList(), loadGroupOrder()]).then(function (res) {
        var r = res[0];
        if (!r.ok) { showDenied(r.msg || '无权限'); return; }
        MY_DEPT = r.dept || '';
        MY_GENERIC = r.generic || '';
        EQ = r.equipments || {};   // 供 openReportForm / 位置快选 / 现象池使用
        renderMine();
        var code = openCode || (noAuto ? '' : getQuery('code'));
        if (code && EQ[code]) {
            // 预览用:?demoView=report 直接落到报修表单
            if (getQuery('demoView') === 'report') openReportForm(code);
            else openDetail(code);
            return;
        }
        if (code) {
            // 扫码扫到的是别的车间的设备:允许只读查看,但不给报修按钮(服务端也会拒绝)
            EquipApi.getDevice(code).then(function (g) {
                if (!g.ok) { switchView('mine'); return; }
                currentCode = code;
                renderLimitedDetail(g.equipment, 'view');
            });
            return;
        }
        switchView('mine');
    });
}
// 从设备详情回到「我的车间」(报修人)
function showMine() {
    if (ROLE === 'reporter') {
        try { history.replaceState(null, '', location.pathname); } catch (e) { }
        loadMine('', true);
        return;
    }
    showListDefault();
}
function renderMine() {
    var t = $('mine-dept');
    if (t) t.textContent = MY_DEPT ? ('我的车间 · ' + MY_DEPT) : '我的车间';
    var codes = Object.keys(EQ).filter(function (c) { return c !== MY_GENERIC; });

    var html = '';
    // 通用报修卡:没有固定二维码的风扇/叉车/杂项都从这里报
    if (MY_GENERIC && EQ[MY_GENERIC]) {
        var g = EQ[MY_GENERIC];
        var gopen = (g.records || []).filter(function (r) { return !isDone(r); }).length;
        html += '<div class="eq-card mine-generic" onclick="openDetail(\'' + esc(MY_GENERIC) + '\')">'
            + '<div class="eq-card-main">'
            + '<div class="eq-card-name">📢 ' + esc(g.name || '通用报修')
            + (gopen ? '<span class="st st-open">进行中 ' + gopen + '</span>' : '') + '</div>'
            + '<div class="eq-card-sub">风扇、叉车、照明、行政杂项等没有二维码的,报这里</div>'
            + '</div></div>';
    }

    // 与管理员端一致:按【设备类别】合并，展开后每台显示自己的名称/规格
    var groups = {}, gOrder = [];
    for (var gi = 0; gi < codes.length; gi++) {
        var gc = codes[gi], gk = groupKeyOf(EQ[gc]);
        if (!groups[gk]) { groups[gk] = []; gOrder.push(gk); }
        groups[gk].push(gc);
    }
    sortGroupsByOrder(gOrder, function (a, b) { return a < b ? -1 : (a > b ? 1 : 0); }, MY_DEPT);
    for (var g2 = 0; g2 < gOrder.length; g2++) {
        var key = gOrder[g2], list = groups[key].slice().sort(function (a, b) { return a < b ? -1 : 1; });
        var totalRecs = 0, openRecs = 0;
        for (var t2 = 0; t2 < list.length; t2++) {
            var rs2 = EQ[list[t2]].records || [];
            totalRecs += rs2.length;
            for (var u2 = 0; u2 < rs2.length; u2++) if (!isDone(rs2[u2])) openRecs++;
        }
        var opened = !!mineGroupOpen[key];
        html += '<div class="eq-group' + (opened ? ' open' : '') + '" data-fam="' + esc(key) + '" onclick="toggleMineGroup(this)">'
            + '<span class="eq-group-arrow">' + (opened ? '▾' : '▸') + '</span>'
            + '<span class="eq-group-name">' + (gorderPin(MY_DEPT, key) ? '<span class="eq-pin">📌</span>' : '') + esc(key) + '</span>'
            + '<span class="eq-group-meta">' + list.length + ' 台 · ' + totalRecs + ' 条'
            + (openRecs ? ' · <b class="eq-group-open">进行中 ' + openRecs + '</b>' : '') + '</span>'
            + '</div>';
        if (!opened) { html += groupSpecLine(list); continue; }
        for (var k2 = 0; k2 < list.length; k2++) {
            var c = list[k2], e = EQ[c];
            var open = (e.records || []).filter(function (r) { return !isDone(r); }).length;
            html += '<div class="eq-card eq-card-sub-item" onclick="openDetail(\'' + esc(c) + '\')">'
                + '<div class="eq-card-main">'
                + '<div class="eq-card-name">' + esc(e.name || '(未命名)')
                + (open ? '<span class="st st-open">进行中 ' + open + '</span>' : '') + '</div>'
                + '<div class="eq-card-sub">' + esc(e.number || c) + (e.line ? (' · ' + esc(e.line)) : '') + ' · ' + (e.records || []).length + ' 条记录</div>'
                + '</div></div>';
        }
    }
    if (!html) html = '<div class="empty">本车间还没有登记设备,请联系设备管理员建档</div>';
    $('mine-list').innerHTML = html;
    var cnt = $('mine-count');
    if (cnt) cnt.textContent = '共 ' + (codes.length + (MY_GENERIC && EQ[MY_GENERIC] ? 1 : 0)) + ' 项';
}
// 报修人列表的分组展开状态
function toggleMineGroup(el) {
    if (!el) return;
    var k = el.getAttribute('data-fam') || '';
    mineGroupOpen[k] = !mineGroupOpen[k];
    renderMine();
}

// ---------- 报修人:本车间全部报修(跨设备汇总) ----------
// 同车间不同报修人都能看到本车间的所有报修情况
var allQ = '', allLimit = 50;
function showMineAll() {
    allQ = ''; allLimit = 50;
    var q = $('all-q');
    if (q) q.value = '';
    renderMineAll();
    switchView('mine-all');
}
function setAllQ(v) {
    allQ = v || '';
    allLimit = 50;
    renderMineAll();
    var q = $('all-q');
    if (q && document.activeElement !== q) {
        q.focus();
        try { q.setSelectionRange(q.value.length, q.value.length); } catch (e) { }
    }
}
function renderMineAll() {
    var t = $('all-title');
    if (t) t.textContent = '本车间全部报修' + (MY_DEPT ? (' · ' + MY_DEPT) : '');
    // 拉平本车间所有设备的记录
    var rows = [];
    for (var c in EQ) {
        var e = EQ[c];
        (e.records || []).forEach(function (r) {
            rows.push({ r: r, dev: e.name || c, code: c, num: e.number || c });
        });
    }
    var kw = allQ.toLowerCase();
    if (kw) {
        rows = rows.filter(function (x) {
            return ((x.dev || '') + ' ' + (x.r.symptom || '') + ' ' + (x.r.no || '') + ' ' + (x.num || ''))
                .toLowerCase().indexOf(kw) > -1;
        });
    }
    rows.sort(function (a, b) {
        var da = String(isDone(a.r) ? (a.r.doneAt || '') : (a.r.reportAt || ''));
        var db = String(isDone(b.r) ? (b.r.doneAt || '') : (b.r.reportAt || ''));
        return da < db ? 1 : -1;
    });
    var openCnt = 0;
    for (var i = 0; i < rows.length; i++) if (!isDone(rows[i].r)) openCnt++;
    var cnt = $('all-cnt');
    if (cnt) cnt.textContent = '共 ' + rows.length + ' 条' + (openCnt ? (' · 进行中 ' + openCnt) : '');
    if (!rows.length) {
        $('all-list').innerHTML = '<div class="empty">' + (allQ ? '没有匹配的报修' : '本车间还没有报修记录') + '</div>';
        return;
    }
    var html = '<div class="timeline">';
    var shown = rows.slice(0, allLimit);
    for (var j = 0; j < shown.length; j++) {
        var x = shown[j], r = x.r, done = isDone(r);
        html += '<div class="tl-item"' + (r.no ? ' data-no="' + esc(r.no) + '"' : '') + '>'
            + '<div class="tl-dot ' + (done ? '' : 'open') + '"></div>'
            + '<div class="tl-body">'
            + '<div class="tl-flow">'
            + (r.no ? '<span class="tl-no">' + esc(r.no) + '</span>' : '')
            + '<div class="tl-flow-item"><span class="tl-flow-label">报修</span><span class="tl-flow-date">' + esc(r.reportAt || '') + '</span></div>'
            + '<span class="tl-arrow">→</span>'
            + '<div class="tl-flow-item ' + (done ? 'done' : 'open') + '"><span class="tl-flow-label">完成</span>'
            + (done ? '<span class="tl-flow-date">' + esc(r.doneAt || '') + '</span>'
                : '<span class="tl-flow-date muted">未完成</span>' + (r.expectedAt ? '<span class="tl-flow-by">预计 ' + esc(r.expectedAt) + '</span>' : ''))
            + '</div>'
            + (done ? '' : '<span class="tl-type tl-open">进行中</span>')
            + '<span class="tl-type tl-dev" onclick="openDetail(\'' + esc(x.code) + '\')" title="点击查看该设备">' + esc(x.dev) + '</span>'
            + (!done && r.updates && r.updates.length ? '<span class="tl-type tl-replied">已回应</span>' : '')
            + '</div>'
            + '<div class="tl-symptom">' + esc(r.symptom || '') + '</div>'
            + (r.place ? '<div class="tl-sub">位置:' + esc(r.place) + '</div>' : '')
            + renderUpdates(r)
            + '</div></div>';
    }
    html += '</div>';
    if (rows.length > allLimit) {
        html += '<div class="tl-more"><button class="btn btn-sm" onclick="allMore()">显示更多（还有 '
            + (rows.length - allLimit) + ' 条）</button></div>';
    }
    $('all-list').innerHTML = html;
}
function allMore() { allLimit += 50; renderMineAll(); }
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
        return (c + ' ' + (e.name || '') + ' ' + (e.number || '') + ' ' + (e.line || '') + ' ' + (e.family || '') + ' ' + (e.model || '')).toLowerCase().indexOf(q) > -1;
    });
    codes.sort(function (a, b) { return a < b ? -1 : 1; });
    $('eq-count').textContent = '共 ' + codes.length + ' 台';
    if (!codes.length) {
        $('eq-list').innerHTML = '<div class="empty">' + (Object.keys(EQ).length ? '没有匹配的设备' : '还没有设备,点「新增设备」开始建档') + '</div>';
        return;
    }
    // 按【设备类别】分组:同类不同规格并成一行(16T冲床/40T冲床/125T精冲...),
    // 折叠态在组下显示规格摘要，展开后每台按编号列出
    var groups = {}, gOrder = [];
    for (var gi = 0; gi < codes.length; gi++) {
        var gc = codes[gi], gf = groupKeyOf(EQ[gc]);
        if (!groups[gf]) { groups[gf] = []; gOrder.push(gf); }
        groups[gf].push(gc);
    }
    var searchOn = !!(q && q.length);
    // 组间排序:类别置顶 + 该部门的自定义顺序优先,没排过的仍按记录数从多到少
    // 筛选到某个部门就用那个部门自己的那套;选「全部部门」用共用的那套
    var scope = line || '';
    sortGroupsByOrder(gOrder, function (a, b) {
        var ra = 0, rb = 0;
        for (var i = 0; i < groups[a].length; i++) ra += (EQ[groups[a][i]].records || []).length;
        for (var j = 0; j < groups[b].length; j++) rb += (EQ[groups[b][j]].records || []).length;
        return rb - ra;
    }, scope);
    var html = '';
    for (var g = 0; g < gOrder.length; g++) {
        var fam = gOrder[g], list = groups[fam].slice().sort(function (a, b) { return a < b ? -1 : 1; });
        var totalRecs = 0, openRecs = 0;
        for (var t = 0; t < list.length; t++) {
            var rs = EQ[list[t]].records || [];
            totalRecs += rs.length;
            for (var u = 0; u < rs.length; u++) if (!isDone(rs[u])) openRecs++;
        }
        // 统一都带下拉:即使当前只有 1 台，将来加同型号机台也不用改结构
        var opened = !!groupOpen[fam] || searchOn;
        html += '<div class="eq-group' + (opened ? ' open' : '') + '" data-fam="' + esc(fam) + '" onclick="toggleGroup(this)">'
            + '<span class="eq-group-arrow">' + (opened ? '▾' : '▸') + '</span>'
            + '<span class="eq-group-name">' + (gorderPin(scope, fam) ? '<span class="eq-pin">📌</span>' : '') + esc(fam) + '</span>'
            + '<span class="eq-group-meta">' + list.length + ' 台 · ' + totalRecs + ' 条'
            + (openRecs ? ' · <b class="eq-group-open">进行中 ' + openRecs + '</b>' : '') + '</span>'
            + '</div>';
        if (!opened) { html += groupSpecLine(list); continue; }
        for (var k = 0; k < list.length; k++) {
            html += deviceCardHtml(list[k], ' eq-card-sub-item');
        }
    }
    $('eq-list').innerHTML = html;
    // 详情面板与筛选结果同步:当前打开的设备已不在筛选结果里就清空，
    // 否则会出现"筛了冲压组，右侧还显示成装组的卡"这种错位
    if (currentCode) {
        var stillVisible = false;
        for (var vi = 0; vi < codes.length; vi++) if (codes[vi] === currentCode) { stillVisible = true; break; }
        if (!stillVisible) {
            currentCode = '';
            $('detail-content').innerHTML = '<div class="empty">从左侧选择设备，或点「新增设备」建档</div>';
        }
    }
}
// 单台设备卡片
function deviceCardHtml(c, extraClass) {
    var e = EQ[c], st = computeStats(e.records);
    return '<div class="eq-card' + (extraClass || '') + (c === currentCode ? ' active' : '') + '" onclick="openDetail(\'' + esc(c) + '\')">'
        + '<div class="eq-card-main">'
        + '<div class="eq-card-name">' + esc(e.name || '(未命名)')
        + '<span class="st st-' + esc(e.status || 'active') + '">' + esc(STATUS_TXT[e.status] || '在用') + '</span>'
        + (st.open ? '<span class="st st-open">进行中 ' + st.open + '</span>' : '')
        + '</div>'
        + '<div class="eq-card-sub">' + esc(e.number || c) + (e.model ? (' · ' + esc(e.model)) : '') + ' · ' + esc(e.line || '未分部门') + ' · ' + st.total + ' 条记录</div>'
        + '</div>'
        + '<div class="eq-card-stat"><div class="eq-card-cost">' + money(st.cost) + '</div><div class="eq-card-cost-label">累计费用</div></div>'
        + '</div>';
}
// 设备分组键:按【设备类别 family】合并 —— 同类不同规格放在一组，
// 展开后每台仍显示自己的真实名称(16T冲床 / 40T冲床 ...)，规格不丢。
// family 为空时回退到名称，再回退到一级类别。
// 通用报修卡(GEN-)没有 family，会按名称各成一组，与改造前行为一致。
function groupKeyOf(e) {
    if (e && e.family) return String(e.family).trim();
    if (e && e.name) return e.name;
    return CAT_TXT[(e && e.category) || 'prod'] || '未分类';
}
// 折叠态在组标题下补一行「组内有哪些规格」:16T冲床 / 40T冲床 / 125T精冲 …
// 只列出出现过的名称(去重)，超过 4 种就省略，避免长名撑破侧栏
function groupSpecLine(list) {
    var seen = {}, names = [];
    for (var i = 0; i < list.length; i++) {
        var n = String((EQ[list[i]] && EQ[list[i]].name) || '').trim();
        if (n && !seen[n]) { seen[n] = 1; names.push(n); }
    }
    if (names.length < 2) return '';
    names.sort();
    var shown = names.slice(0, 4).join(' / ');
    if (names.length > 4) shown += ' 等 ' + names.length + ' 种';
    return '<div class="eq-group-specs">' + esc(shown) + '</div>';
}

function toggleGroup(el) {
    if (!el) return;
    var key = el.getAttribute('data-fam') || '';
    groupOpen[key] = !groupOpen[key];
    renderList();
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
// 返回:有当前设备就回详情,否则回列表
// (新增设备 / 打印全部标签时 currentCode 为空,直接调 openDetail 会卡在空页面)
function backOrList() {
    if (currentCode && EQ[currentCode]) { openDetail(currentCode); return; }
    showListDefault();
}
function openDetail(code, useCache) {
    currentCode = code;
    // 换设备时重置查看口径:通用报修卡按月，编号设备按本年度全部
    var _now = new Date();
    tlYear = _now.getFullYear(); tlMonth = _now.getMonth() + 1;
    tlYearOnly = String(code || '').indexOf('GEN-') !== 0;
    tlLimit = 30; rpLimit = 20;
    // 刚保存过:EQ 里就是最新数据，直接用缓存渲染，省掉一次往返
    if (useCache && EQ[code] && (ROLE === 'admin' || ROLE === 'repairer')) {
        renderManageDetail(EQ[code]);
        return;
    }
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
function renderManageDetail(e, opts) {
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
        + (C.manageDevices ? '<button class="btn btn-sm" onclick="openTransfer()">转移到其他车间</button>' : '')
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
        // 两种口径:
        //  · 通用报修卡(GEN-*)记录多 → 默认按月，下拉可看本年往月 + 往年归档
        //  · 有编号的设备记录少 → 默认看本年度全部；下拉可切往年
        // 两种模式都保证未完成的单始终显示(跨月/跨年结转)，不因切换而消失。
        var nowY = new Date().getFullYear(), nowM = new Date().getMonth() + 1;
        var isGeneric = String(e.code || '').indexOf('GEN-') === 0;
        // 兜底:若调用方没设置过口径(例如直接渲染)，按设备类型给默认值
        var yearOnly = (typeof tlYearOnly === 'boolean') ? tlYearOnly : !isGeneric;
        if (isGeneric && yearOnly && tlMonth === 0) yearOnly = false;
        var allOpen = recs.filter(function (x) { return !isDone(x); });
        var recDate = function (x) {
            return String(isDone(x) ? (x.doneAt || x.reportAt || '') : (x.reportAt || ''));
        };
        var inScope = recs.filter(function (x) {
            var d = recDate(x);
            if (!d) return false;
            if (yearOnly) {
                // 整年视图:该年 + tlMonth=0 表示该年及更早
                var y = parseInt(d.slice(0, 4), 10);
                return tlMonth === 0 ? (y <= tlYear) : (y === tlYear);
            }
            if (tlMonth === 0) return parseInt(d.slice(0, 4), 10) <= tlYear;
            return d.slice(0, 7) === (tlYear + '-' + String(tlMonth).padStart(2, '0'));
        });
        // 本期已包含的未完成单不重复计数
        var seen = {};
        for (var si = 0; si < inScope.length; si++) seen[inScope[si].id] = 1;
        var carried = allOpen.filter(function (x) { return !seen[x.id]; });
        var view = inScope.concat(carried).sort(function (a, b) {
            var da = isDone(a) ? (a.doneAt || '') : (a.reportAt || '');
            var db = isDone(b) ? (b.doneAt || '') : (b.reportAt || '');
            return da < db ? 1 : -1;
        });

        // 下拉:整年模式给年份；按月模式给本年各月 + 往年归档
        var opts = '';
        var oldYears = {};
        for (var oi = 0; oi < recs.length; oi++) {
            var od = recDate(recs[oi]);
            if (od.slice(0, 4) && parseInt(od.slice(0, 4), 10) < nowY) oldYears[od.slice(0, 4)] = 1;
        }
        var oldYearList = Object.keys(oldYears).sort();
        if (yearOnly) {
            opts += '<option value="y' + nowY + '"' + (tlYear === nowY ? ' selected' : '') + '>' + nowY + ' 年（全部）</option>';
            for (var yi = oldYearList.length - 1; yi >= 0; yi--) {
                var oy = oldYearList[yi];
                opts += '<option value="y' + oy + '"' + (tlYear === parseInt(oy, 10) && tlMonth !== 0 ? ' selected' : '') + '>' + oy + ' 年</option>';
            }
        } else {
            for (var m = 1; m <= nowM; m++) {
                opts += '<option value="' + nowY + '-' + m + '"' + ((tlYear === nowY && tlMonth === m) ? ' selected' : '')
                    + '>' + nowY + ' 年 ' + m + ' 月</option>';
            }
            for (var yj = oldYearList.length - 1; yj >= 0; yj--) {
                var oy2 = oldYearList[yj];
                opts += '<option value="' + oy2 + '-0"' + ((tlYear === parseInt(oy2, 10) && tlMonth === 0) ? ' selected' : '')
                    + '>' + oy2 + ' 年及更早（归档）</option>';
            }
        }
        var cntTxt = yearOnly
            ? ('本年 ' + inScope.length + ' 条')
            : ('本月 ' + inScope.length + ' 条');
        var bar = '<div class="tl-filter">'
            + '<select id="tl-month" onchange="setTlMonth(this.value)">' + opts + '</select>'
            + '<span class="tl-filter-cnt">' + cntTxt
            + (carried.length ? ' · <b class="tl-carry">往期未完成 ' + carried.length + '</b>' : '')
            + '</span>'
            + '</div>';

        if (!view.length) {
            tl = bar + '<div class="empty">该月没有记录</div>';
        } else {
            var shown = view.slice(0, tlLimit);
            tl = bar + '<div class="timeline">';
            for (var i = 0; i < shown.length; i++) {
                var r = shown[i], done = isDone(r), delayed = isDelayed(r);
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
                    + (r.place ? '<div class="tl-sub">位置:' + esc(r.place) + '</div>' : '')
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
            if (view.length > tlLimit) {
                tl += '<div class="tl-more"><button class="btn btn-sm" onclick="tlMore()">显示更多（还有 '
                    + (view.length - tlLimit) + ' 条）</button></div>';
            }
        }
    }

    $('detail-content').innerHTML = head + stats + '<div class="sec-title"><span>工单 / 履历</span><span>' + st.total + ' 条</span></div>' + tl;
    switchView('list');
    if (!(opts && opts.noScroll) && window.innerWidth < 900) $('detail-panel').scrollIntoView({ behavior: 'auto' });
    focusWo();
}

// ---------- 时间轴:按月查看 ----------
function tlRerender() {
    var e = EQ[currentCode];
    if (!e) return;
    renderManageDetail(e, { noScroll: true });
}
function setTlMonth(v) {
    var s = String(v || '');
    if (s.charAt(0) === 'y') {                 // 整年视图: y2026
        tlYear = parseInt(s.slice(1), 10) || tlYear;
        tlMonth = 0;                            // 0 = 该年全部
    } else {
        var p = s.split('-');
        tlYear = parseInt(p[0], 10) || tlYear;
        tlMonth = parseInt(p[1], 10) || 0;      // 0 = 该年及更早(归档)
    }
    tlLimit = 30;
    tlRerender();
}
function tlMore() { tlLimit += 50; tlRerender(); }
// 报修人视图:展开更多
function rpMore() {
    rpLimit += 20;
    var e = EQ[currentCode];
    if (e) renderLimitedDetail(e, ROLE === 'reporter' ? 'reporter' : 'view');
}

// 报修人 / 普通账号:受限视图
function renderLimitedDetail(e, role) {
    currentCode = e.code;
    var head = '<div class="detail-head">'
        + ((role === 'reporter' || role === 'report')
            ? '<div class="mine-back" onclick="showMine()">← 我的车间</div>' : '')
        + '<div class="detail-title">' + esc(e.name || '') + '<span class="st st-' + esc(e.status || 'active') + '">' + esc(STATUS_TXT[e.status] || '在用') + '</span></div>'
        + '<div class="detail-meta">' + (e.number ? ('编号 ' + esc(e.number) + ' · ') : '') + esc(e.line || '') + '</div>'
        + (role === 'reporter' || role === 'report'
            ? '<div class="detail-actions"><button class="btn btn-primary" onclick="openReportForm(\'' + esc(e.code) + '\')">＋ 报修</button></div>'
            : '')
        + '</div>';
    var body = '';
    if (role === 'reporter' || role === 'report') {
        var allRecs = (e.records || []);
        var recs = allRecs.slice(0, rpLimit);
        body = '<div class="sec-title"><span>该设备报修情况</span><span>共 ' + allRecs.length + ' 条</span></div>';
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
                    + (r.place ? '<div class="tl-sub">位置:' + esc(r.place) + '</div>' : '')
                    + renderUpdates(r)
                    + '</div></div>';
            }
            body += '</div>';
            if (allRecs.length > rpLimit) {
                body += '<div class="tl-more"><button class="btn btn-sm" onclick="rpMore()">显示更多（还有 '
                    + (allRecs.length - rpLimit) + ' 条）</button></div>';
            }
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
    $('rp-place').value = '';
    $('rp-reportBy').value = u.name || '';
    renderReportChips();
    renderPlacePool();
    switchView('report');
}
// 设备位置快选:取历史里填过的位置,按出现次数排序
function renderPlacePool() {
    var cnt = {};
    for (var c in EQ) {
        (EQ[c].records || []).forEach(function (r) {
            var p = String(r.place || '').trim();
            if (p) cnt[p] = (cnt[p] || 0) + 1;
        });
    }
    var arr = Object.keys(cnt).sort(function (a, b) { return (cnt[b] - cnt[a]) || (a < b ? -1 : 1); }).slice(0, 30);
    $('place-pool').innerHTML = arr.map(function (p) { return '<option value="' + esc(p) + '">'; }).join('');
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
    EquipApi.report(currentCode, {
        symptom: symptom,
        place: ($('rp-place').value || '').trim(),
        expectedAt: '',
        reportBy: ($('rp-reportBy').value || '').trim()
    }).then(function (r) {
        if (!r.ok) { showToast(r.msg || '提交失败'); return; }
        showToast(r.no ? ('报修已提交 · ' + r.no) : '报修已提交');
        if (caps().seeList) refreshDevice(currentCode);
        else if (ROLE === 'reporter') loadMine(currentCode);
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
        refreshDevice(currentCode);
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
        // 失败:上面已经就地改了本地对象,回拉这一台把内存恢复成服务端的样子
        if (!r.ok) { showToast(r.msg || '保存失败'); refreshDevice(currentCode); return; }
        showToast(v ? ('已设置预计完成 ' + v) : '已清除预计完成');
        refreshLocal(currentCode);
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
    $('rf-doneAt').value = rec.doneAt || today();
    renderRecordContext(rec, fromReport);
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

// ---------- 完成登记页顶部「报修与进度」卡片 ----------
// 管理员做分类时要能直接看到报修原文与进度回应，不必退出表单翻时间轴。
// 保养/点检等直接登记没有报修前置信息，改为提示 + 本设备近期记录作参照。
function renderRecordContext(rec, fromReport) {
    window._rcCtx = { rec: rec || {}, fromReport: !!fromReport };
    drawRecordContext();
}
function onRecordDoneAtChange() {
    var c = window._rcCtx || {};
    updateDelayHint((c.rec || {}).expectedAt || '');
    drawRecordContext();
}
function drawRecordContext() {
    var box = $('rf-ctx');
    if (!box) return;
    var c = window._rcCtx || {};
    var rec = c.rec || {};
    var e = EQ[currentCode] || {};
    var h = '';
    var hasReport = !!(rec.reportAt || rec.symptom || rec.reportBy);
    // 完成日期以表单当前值为准(可能刚被改过)
    var doneAt = ($('rf-doneAt').value || rec.doneAt || '');
    var closing = c.fromReport || !isDone(rec) || !rec.doneAt;
    if (hasReport) {
        var meta = [];
        if (rec.no) meta.push('<span class="rc-no">' + esc(rec.no) + '</span>');
        if (rec.reportAt) meta.push('报修 ' + esc(rec.reportAt));
        if (rec.reportBy) meta.push(esc(rec.reportBy));
        h += '<div class="rc-head">' + meta.join('<span class="rc-dot">·</span>') + '</div>';
        var facts = [];
        if (closing) {
            // 还开着:算拖了多久
            if (rec.reportAt) {
                var wait = daysBetween(rec.reportAt, today());
                if (wait > 0) facts.push('已报修 <b>' + wait + '</b> 天');
            }
            if (rec.expectedAt) {
                var over = daysBetween(rec.expectedAt, today());
                facts.push(over > 0
                    ? '<b class="rc-warn">已超预计 ' + over + ' 天</b>'
                    : ('预计完成 ' + esc(rec.expectedAt)));
            }
        } else {
            // 已完成:算用了多久
            if (rec.reportAt && doneAt) {
                var use = daysBetween(rec.reportAt, doneAt);
                if (use >= 0) facts.push('用时 <b>' + use + '</b> 天');
            }
            if (rec.expectedAt && doneAt) {
                var dly = daysBetween(rec.expectedAt, doneAt);
                if (dly > 0) facts.push('<b class="rc-warn">超期 ' + dly + ' 天</b>');
            }
        }
        if (facts.length) h += '<div class="rc-facts">' + facts.join('<span class="rc-dot">·</span>') + '</div>';
        h += '<div class="rc-label">故障现象</div>';
        h += '<div class="rc-symptom">' + (rec.symptom ? esc(rec.symptom) : '<span class="rc-muted">(报修人未填写)</span>') + '</div>';
        if (rec.place) h += '<div class="rc-sub">位置：' + esc(rec.place) + '</div>';
        var us = rec.updates || [];
        if (us.length) {
            h += '<div class="rc-label">进度</div><div class="rc-ups">';
            us.forEach(function (u) {
                u = u || {};
                h += '<div class="rc-up">'
                    + '<span class="rc-up-at">' + esc(String(u.at || '').slice(5)) + '</span>'
                    + (u.by ? '<span class="rc-up-by">' + esc(u.by) + '</span>' : '')
                    + '<span class="rc-up-tx">' + esc(u.text || '') + '</span></div>';
            });
            h += '</div>';
        }
    } else {
        // 保养 / 点检 / 大修 / 改造 直接登记:没有报修前置信息
        var curType = c.fromReport ? (rec.type || 'maintain') : (($('rf-type') || {}).value || rec.type || 'maintain');
        var t = TYPES[curType] ? TYPES[curType].txt : '登记';
        h += '<div class="rc-head">' + esc(t) + ' · 直接登记<span class="rc-tag">无报修前置信息</span></div>';
        var near = (e.records || []).filter(function (r) {
            return r.id !== rec.id && isDone(r) && (r.cause3 || r.cause1);
        }).sort(function (a, b) { return (a.doneAt || '') < (b.doneAt || '') ? 1 : -1; }).slice(0, 3);
        if (near.length) {
            h += '<div class="rc-label">本设备近期记录(作分类参照)</div><div class="rc-nears">';
            near.forEach(function (r) {
                var cat = (r.cause1 ? r.cause1 + (r.cause2 ? ' / ' + r.cause2 : '') : '') + (r.cause3 ? ' / ' + r.cause3 : '');
                h += '<div class="rc-near">'
                    + '<span class="rc-near-date">' + esc(r.doneAt || r.reportAt || '') + '</span>'
                    + '<span class="rc-near-type">' + esc(TYPES[r.type] ? TYPES[r.type].txt : '') + '</span>'
                    + '<span class="rc-near-cat">' + esc(cat || '(未分类)') + '</span>'
                    + (r.symptom || r.action ? '<div class="rc-near-sym">' + esc(String(r.symptom || r.action).slice(0, 40)) + '</div>' : '')
                    + '</div>';
            });
            h += '</div>';
        } else {
            h += '<div class="rc-muted">本设备还没有历史记录，可直接填写。</div>';
        }
    }
    box.innerHTML = h;
    box.style.display = '';
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
        if (!r.ok) { showToast(r.msg || '保存失败'); refreshDevice(currentCode); return; }
        showToast('已保存');
        refreshLocal(currentCode);
    });
}
function deleteRecord(recordId) {
    if (!caps().manageDevices) { showToast('仅设备管理员可删除记录'); return; }
    if (!confirm('删除这条记录?操作会留痕,记录会先进「回收站」,30 天内可恢复。')) return;
    var e = EQ[currentCode];
    var target = null;
    e.records = (e.records || []).filter(function (r) { if (r.id === recordId) { target = r; return false; } return true; });
    EquipApi.save(currentCode, e, '删除记录:' + ((target && (target.symptom || '')) || '').slice(0, 30)).then(function (r) {
        // 失败:本地已经把这行 filter 掉了,回拉这一台恢复
        if (!r.ok) { showToast(r.msg || '删除失败'); refreshDevice(currentCode); return; }
        showToast('已删除');
        refreshLocal(currentCode);
    });
}

// ---------- 档案 ----------
function openArchiveForm(code) {
    if (!caps().manageDevices) return;
    editingArchive = !!code;
    var e = code ? EQ[code] : { status: 'active', category: 'prod', installDate: today() };
    // 类别候选
    var dl = $('family-list');
    if (dl) dl.innerHTML = familyOptions().map(function (f) { return '<option value="' + esc(f) + '">'; }).join('');
    $('archive-title').textContent = code ? ('编辑档案 · ' + code) : '新增设备';
    $('a-code').value = code || '';
    $('a-code').readOnly = !!code;
    $('a-name').value = e.name || '';
    $('a-number').value = e.number || '';
    $('a-line').value = e.line || '';
    $('a-family').value = e.family || '';
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
    // 深拷贝:保存失败时不能把本地 EQ 里的档案改脏(它和 EQ[code] 是同一个对象)
    var data = editingArchive
        ? JSON.parse(JSON.stringify(EQ[code] || {}))
        : { code: code, records: [], photos: [] };    data.code = code; data.name = name;
    data.number = ($('a-number').value || '').trim();
    data.line = ($('a-line').value || '').trim();
    data.family = ($('a-family').value || '').trim();
    data.category = $('a-cat').value;
    data.owner = ($('a-owner').value || '').trim();
    data.model = ($('a-model').value || '').trim();
    data.vendor = ($('a-vendor').value || '').trim();
    data.installDate = $('a-install').value || '';
    data.status = $('a-status').value;
    data.remark = ($('a-remark').value || '').trim();
    EquipApi.save(code, data, (editingArchive ? '修改设备档案:' : '新增设备:') + name).then(function (r) {
        if (!r.ok) { showToast(r.msg || '保存失败'); return; }
        EQ[code] = data;
        showToast('已保存');
        refreshLocal(code);
    });
}
// ---------- 转移设备到其他车间(仅设备管理员) ----------
function openTransfer() {
    if (!caps().manageDevices) { showToast('仅设备管理员可转移设备'); return; }
    var e = EQ[currentCode];
    if (!e) { showToast('请先选择设备'); return; }
    if (String(e.code || '').indexOf('GEN-') === 0) {
        showToast('通用报修卡属于车间本身，不能转移');
        return;
    }
    var cur = e.line || '';
    $('tr-dev').textContent = (e.name || '') + (e.number ? (' ' + e.number) : '') + '（' + e.code + '）';
    $('tr-from').textContent = cur || '（未设置车间）';
    var opts = '<option value="">请选择目标车间</option>';
    for (var i = 0; i < DEPTS.length; i++) {
        if (DEPTS[i] === cur) continue;
        opts += '<option value="' + esc(DEPTS[i]) + '">' + esc(DEPTS[i]) + '</option>';
    }
    $('tr-to').innerHTML = opts;
    switchView('transfer');
}
function doTransfer() {
    if (!caps().manageDevices) { showToast('仅设备管理员可转移设备'); return; }
    var e = EQ[currentCode];
    if (!e) { showToast('请先选择设备'); return; }
    var to = $('tr-to').value;
    if (!to) { showToast('请选择目标车间'); return; }
    var from = e.line || '';
    if (to === from) { showToast('目标车间与当前相同'); return; }
    if (!confirm('确定把【' + (e.name || e.code) + '】从「' + (from || '未设置') + '」转移到「' + to + '」？\n该设备的全部履历会一起转移。')) return;
    var data = JSON.parse(JSON.stringify(e));
    data.line = to;
    EquipApi.save(e.code, data, '转移车间:' + (from || '(空)') + ' → ' + to).then(function (r) {
        if (!r.ok) { showToast(r.msg || '转移失败'); return; }
        EQ[e.code] = data;
        showToast('已转移到 ' + to);
        refreshLocal(e.code);
    });
}
function deleteEquipment(code) {
    if (!caps().manageDevices) return;
    if (!confirm('确定删除设备【' + ((EQ[code] || {}).name || code) + '】?该设备全部记录会一起删除,操作会留痕。\n删除后会先进「回收站」,30 天内可整台恢复。')) return;
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

// ---------- 回收站(设备 / 工单) ----------
var TRASH = [];
function openTrash() {
    switchView('trash');
    $('trash-list').innerHTML = '<div class="empty">加载中…</div>';
    $('trash-count').textContent = '';
    EquipApi.trashList().then(function (r) {
        if (!r.ok) {
            $('trash-list').innerHTML = '<div class="empty">' + esc(r.msg || '加载失败') + '</div>';
            return;
        }
        TRASH = r.items || [];
        renderTrash();
    });
}
function renderTrash() {
    var h = '';
    if (!TRASH.length) {
        h = '<div class="empty">回收站是空的<br><span style="font-size:12px">删除的设备 / 工单会先放这里,30 天后自动清理</span></div>';
    } else {
        for (var i = 0; i < TRASH.length; i++) {
            var it = TRASH[i], isDev = it.kind === 'equipment', snap = it.snapshot || {};
            var sub = isDev
                ? ('设备' + (snap.number ? (' · ' + esc(snap.number)) : '') + (snap.line ? (' · ' + esc(snap.line)) : '')
                    + ' · ' + ((snap.records || []).length) + ' 条履历')
                : ('工单' + (snap.no ? (' · ' + esc(snap.no)) : '') + ' · 设备 ' + esc(it.ref_key)
                    + (snap.reportAt ? (' · 报修 ' + esc(snap.reportAt)) : ''));
            h += '<div class="tl-item"><div class="tl-dot ' + (isDev ? 'fault' : 'open') + '"></div><div class="tl-body">'
                + '<div class="tl-top"><span class="tl-type ' + (isDev ? 'tl-delay' : 'tl-open') + '">' + (isDev ? '设备' : '工单') + '</span>'
                + '<span class="tl-symptom">' + esc(it.label || it.ref_key) + '</span></div>'
                + '<div class="tl-sub">' + sub + '</div>'
                + '<div class="tl-sub">' + esc(it.deleted_by_name || '—') + ' 于 ' + esc(it.deleted_at || '') + ' 删除 · 还剩 '
                + (it.days_left == null ? 30 : it.days_left) + ' 天</div>'
                + '<div style="margin-top:8px">'
                + '<span class="tl-act" onclick="restoreTrash(\'' + esc(String(it.id)) + '\')">恢复</span>'
                + '<span class="tl-act danger" onclick="purgeTrash(\'' + esc(String(it.id)) + '\')">彻底删除</span>'
                + '</div></div></div>';
        }
    }
    $('trash-list').innerHTML = h
        + (TRASH.length ? '<div class="bottom-bar"><button class="btn btn-danger btn-block" onclick="purgeAllTrash()">清空回收站</button></div>' : '');
    $('trash-count').textContent = TRASH.length ? ('共 ' + TRASH.length + ' 条') : '';
}
// 先按「跳过」恢复;撞上已存在再问要不要覆盖 —— 这样默认安全,又给了覆盖的口子
function restoreTrash(id) {
    EquipApi.trashRestore(id, 'skip').then(function (r) {
        if (r.ok) { showToast('已恢复'); reloadAll(function () { openTrash(); }); return; }
        var msg = r.msg || '恢复失败';
        if (msg.indexOf('已存在') >= 0) {
            if (confirm(msg + '\n\n要用回收站里的版本覆盖现在这条吗?\n· 确定 = 覆盖\n· 取消 = 保持现状(这条继续留在回收站)')) {
                EquipApi.trashRestore(id, 'overwrite').then(function (r2) {
                    showToast(r2.ok ? '已覆盖恢复' : (r2.msg || '恢复失败'));
                    reloadAll(function () { openTrash(); });
                });
            } else {
                showToast('已跳过,未做修改');
            }
            return;
        }
        showToast(msg);
    });
}
function purgeTrash(id) {
    if (!confirm('彻底删除后找不回来,确定?')) return;
    EquipApi.trashPurge(id).then(function (r) {
        showToast(r.ok ? '已彻底删除' : (r.msg || '删除失败'));
        openTrash();
    });
}
function purgeAllTrash() {
    if (!confirm('清空回收站?里面的设备 / 工单会被永久删除,无法恢复。')) return;
    EquipApi.trashPurge('').then(function (r) {
        showToast(r.ok ? ('已清空 ' + (r.n || 0) + ' 条') : (r.msg || '清空失败'));
        openTrash();
    });
}

// ---------- 按需加载第三方库(首屏不下载,见 index.html 注释) ----------
var _libs = {};
function loadLib(key, src) {
    if (_libs[key]) return _libs[key];
    _libs[key] = new Promise(function (resolve, reject) {
        var el = document.createElement('script');
        el.src = src;
        el.async = true;
        el.onload = function () { resolve(); };
        el.onerror = function () { _libs[key] = null; reject(new Error(src)); };
        document.head.appendChild(el);
    });
    return _libs[key];
}
function withQr(cb) {
    loadLib('qr', './js/qrcode.min.js').then(cb).catch(function () {
        showToast('二维码组件加载失败,请检查网络后重试');
    });
}
function withXlsx(cb) {
    loadLib('xlsx', './js/xlsx.mini.min.js').then(cb).catch(function () {
        showToast('导出组件加载失败,请检查网络后重试');
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
    withQr(function () { renderLabels(codes); });
}
function renderLabels(codes) {
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
    withXlsx(doExportXlsx);
}
function doExportXlsx() {
    var head = ['工单号', '设备名称', '设备编号', '所属部门', '设备位置', '设备类别', '报修人', '报修日期', '预计修复日期', '实际完成时间', '维修跟踪情况通报', '故障原因分析', '维修措施', '故障部件名称', '维修/更换', '内部维修/外协维修', '维修责任人', '外协维修供应商', '状态', '费用', '故障分类1', '故障分类2', '故障分类3', '是否延期', '延时时间(天)', '延时原因', '维修工时(天)'];
    var widths = [14, 16, 12, 10, 16, 10, 9, 12, 13, 13, 42, 24, 28, 16, 10, 14, 10, 14, 8, 10, 20, 22, 24, 8, 12, 14, 12];
    var rows = [head];
    var n = 0;
    Object.keys(EQ).sort().forEach(function (c) {
        var e = EQ[c];
        (e.records || []).slice().sort(function (a, b) { return (a.reportAt || '') < (b.reportAt || '') ? 1 : -1; }).forEach(function (r) {
            var done = isDone(r);
            rows.push([
                r.no || '',
                e.name || '', e.number || '', e.line || '', r.place || '', CAT_TXT[e.category || 'prod'] || '',
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

// ---------- 类别排序页(仅设备管理员;分部门各排一套) ----------
function openGroupOrder() {
    if (!caps().manageDevices) { showToast('仅设备管理员可调整类别顺序'); return; }
    switchView('gorder');
    gorderDept = '';
    renderGorderDeptOptions();
    $('gorder-list').innerHTML = '<div class="empty">加载中…</div>';
    $('gorder-count').textContent = '';
    loadGroupOrder().then(function () {
        gorderDraft = buildGroupOrderDraft(gorderDept);
        renderGroupOrder();
    });
}
// 部门下拉:全部部门 + 15 个车间
function renderGorderDeptOptions() {
    var sel = $('gorder-dept');
    if (!sel) return;
    var h = '<option value="">全部部门</option>';
    for (var i = 0; i < DEPTS.length; i++) {
        h += '<option value="' + esc(DEPTS[i]) + '"' + (DEPTS[i] === gorderDept ? ' selected' : '') + '>' + esc(DEPTS[i]) + '</option>';
    }
    sel.innerHTML = h;
    sel.value = gorderDept;
}
// 切换要排的部门:草稿换成那部门的,未保存的改动丢弃
function switchGorderDept(v) {
    gorderDept = String(v || '');
    gorderDraft = buildGroupOrderDraft(gorderDept);
    renderGroupOrder();
}
// 用「当前档案里真实出现的类别」做底,再补上已保存顺序里多出来的(已删空的类别也不丢)
// dept 为空 = 全部部门(统计全部设备);否则只统计该部门的设备
function buildGroupOrderDraft(dept) {
    dept = dept || '';
    var cnt = {}, order = [];
    for (var c in EQ) {
        var e = EQ[c];
        if (dept && e.line !== dept) continue;
        var k = groupKeyOf(e);
        if (!k) continue;
        if (cnt[k] == null) { cnt[k] = 0; order.push(k); }
        cnt[k] += 1;
    }
    // 这个部门自己存过、但当前没设备的类别也要留着,否则置顶/顺序取消不掉
    var own = gorderOf(dept);
    for (var o = 0; o < own.length; o++) {
        var on = String((own[o] || {}).n || '').trim();
        if (on && cnt[on] == null) { cnt[on] = 0; order.push(on); }
    }
    var src = gorderEffective(dept), out = [], used = {};
    for (var i = 0; i < src.length; i++) {
        var n = String((src[i] || {}).n || '').trim();
        if (!n || used[n]) continue;
        if (cnt[n] == null) continue;      // 本部门没有的类别不列出来,免得页面上全是 0 台
        used[n] = 1;
        out.push({ n: n, pin: !!(src[i] || {}).pin, total: cnt[n] || 0 });
    }
    order.sort(function (a, b) { return a < b ? -1 : (a > b ? 1 : 0); });
    for (var j = 0; j < order.length; j++) {
        if (used[order[j]]) continue;
        out.push({ n: order[j], pin: false, total: cnt[order[j]] || 0 });
    }
    return out;
}
function renderGroupOrder() {
    var a = gorderDraft || [];
    if (!a.length) {
        $('gorder-list').innerHTML = '<div class="empty">还没有设备类别可分</div>';
        $('gorder-count').textContent = '';
        var cb0 = $('gorder-clean');
        if (cb0) cb0.style.display = 'none';
        return;
    }
    var h = '', nEmpty = 0;
    for (var i = 0; i < a.length; i++) {
        var it = a[i];
        // 0 台 = 本部门顺序里的历史残留(设备都改到别的类别去了)。这种行可以单独移除,
        // 不必为了去掉两行而「恢复默认」把整套排序清掉。
        var empty = (it.total || 0) === 0;
        if (empty) nEmpty++;
        h += '<div class="go-item' + (it.pin ? ' pinned' : '') + (empty ? ' is-empty' : '') + '" draggable="true" data-i="' + i + '"'
            + ' ondragstart="goDragStart(event,' + i + ')" ondragover="goDragOver(event)"'
            + ' ondrop="goDrop(event,' + i + ')" ondragend="goDragEnd(event)">'
            + '<span class="go-handle">☰</span>'
            + '<span class="go-name">' + esc(it.n) + (empty ? '<span class="go-empty">空</span>' : '') + '</span>'
            + '<span class="go-meta">' + (it.total || 0) + ' 台</span>'
            + '<span class="go-act" onclick="openCatRename(' + i + ')" title="改类别名">✏️</span>'
            + '<span class="go-act' + (it.pin ? ' on' : '') + '" onclick="toggleGroupPin(' + i + ')" title="置顶">📌</span>'
            + '<span class="go-act" onclick="moveGroupOrder(' + i + ',-1)" title="上移">↑</span>'
            + '<span class="go-act" onclick="moveGroupOrder(' + i + ',1)" title="下移">↓</span>'
            + (empty ? '<span class="go-act del" onclick="removeEmptyCat(' + i + ')" title="从本部门顺序里移除(当前 0 台)">🗑</span>' : '')
            + '</div>';
    }
    $('gorder-list').innerHTML = h;
    $('gorder-count').textContent = '共 ' + a.length + ' 个类别' + (nEmpty ? ('（其中 ' + nEmpty + ' 个空）') : '');
    var cb = $('gorder-clean');
    if (cb) cb.style.display = nEmpty ? '' : 'none';
}
// 从当前部门这套顺序里移除一个「0 台」的类别(只动草稿,点保存才生效)
function removeEmptyCat(i) {
    var a = gorderDraft || [], it = a[i];
    if (!it) return;
    if ((it.total || 0) > 0) { showToast('该类别还有设备，不能移除'); return; }
    var who = gorderDept ? ('「' + gorderDept + '」') : '「全部部门」';
    if (!confirm('从' + who + '的类别顺序里移除「' + it.n + '」？\n\n'
        + '它当前 0 台，移除不影响任何设备档案、工单和履历；\n'
        + '其它部门的顺序也不受影响。\n\n'
        + '（改动要先点「保存顺序」才生效）')) return;
    a.splice(i, 1);
    renderGroupOrder();
    showToast('已移除「' + it.n + '」，点「保存顺序」生效');
}
// 一次性清掉本部门这套顺序里所有 0 台的类别
function cleanEmptyCats() {
    var a = gorderDraft || [], keep = [], drop = [];
    for (var i = 0; i < a.length; i++) {
        if ((a[i].total || 0) === 0) drop.push(a[i].n); else keep.push(a[i]);
    }
    if (!drop.length) { showToast('没有空类别可清理'); return; }
    var who = gorderDept ? ('「' + gorderDept + '」') : '「全部部门」';
    if (!confirm('从' + who + '的类别顺序里移除 ' + drop.length + ' 个空类别？\n\n'
        + drop.join('、') + '\n\n'
        + '它们当前都是 0 台，移除不影响设备档案、工单和履历；\n'
        + '（改动要先点「保存顺序」才生效）')) return;
    gorderDraft = keep;
    renderGroupOrder();
    showToast('已移除 ' + drop.length + ' 个空类别，点「保存顺序」生效');
}
function goDragStart(e, i) {
    gorderDragFrom = i;
    try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));
        if (e.currentTarget && e.currentTarget.classList) e.currentTarget.classList.add('dragging');
    } catch (x) { }
}
function goDragOver(e) { if (e && e.preventDefault) e.preventDefault(); }
function goDragEnd() {
    gorderDragFrom = -1;
    var els = document.querySelectorAll('#gorder-list .go-item');
    for (var k = 0; k < els.length; k++) els[k].classList.remove('dragging');
}
function goDrop(e, to) {
    if (e && e.preventDefault) e.preventDefault();
    var from = gorderDragFrom;
    if (from < 0 || from === to) { gorderDragFrom = -1; return; }
    var a = gorderDraft || [];
    var it = a.splice(from, 1)[0];
    if (!it) { gorderDragFrom = -1; return; }
    a.splice(to, 0, it);
    // 置顶状态不因拖动改变,但置顶项必须始终连成一排在最前
    normalizePins(a);
    gorderDragFrom = -1;
    renderGroupOrder();
}
// 置顶项连成一排排在最前(内部保持相对顺序),其余按原顺序跟随
function normalizePins(a) {
    var pin = [], rest = [];
    for (var i = 0; i < a.length; i++) { if (a[i].pin) pin.push(a[i]); else rest.push(a[i]); }
    if (!pin.length) return;
    var out = pin.concat(rest);
    for (var j = 0; j < out.length; j++) a[j] = out[j];
}
function toggleGroupPin(i) {
    var a = gorderDraft || [];
    if (!a[i]) return;
    a[i].pin = !a[i].pin;
    if (a[i].pin) {
        var it = a.splice(i, 1)[0];
        var to = 0;
        for (var k = 0; k < a.length; k++) if (a[k].pin) to = k + 1;
        a.splice(to, 0, it);
    } else {
        // 取消置顶:落到未置顶区的最前面,免得位置突然跳到很远
        var it2 = a.splice(i, 1)[0];
        var to2 = 0;
        for (var m2 = 0; m2 < a.length; m2++) if (a[m2].pin) to2 = m2 + 1;
        a.splice(to2, 0, it2);
    }
    renderGroupOrder();
}
function moveGroupOrder(i, d) {
    var a = gorderDraft || [], j = i + d;
    if (j < 0 || j >= a.length) return;
    if (a[i].pin !== a[j].pin) { showToast('先取消其中一项的置顶再调整'); return; }
    var t = a[i]; a[i] = a[j]; a[j] = t;
    renderGroupOrder();
}
function saveGroupOrder() {
    var a = gorderDraft || [], out = [];
    normalizePins(a);
    for (var i = 0; i < a.length; i++) out.push({ n: a[i].n, pin: !!a[i].pin });
    // 只替换当前这个部门那一套,别的部门不动
    var obj = {}, k;
    for (k in GORDERS) if (Object.prototype.hasOwnProperty.call(GORDERS, k)) obj[k] = GORDERS[k];
    if (out.length) obj[gorderDept] = out; else delete obj[gorderDept];
    EquipApi.groupOrderSet(obj).then(function (r) {
        if (!r.ok) { showToast(r.msg || '保存失败'); return; }
        GORDERS = gorderNorm(obj);
        if (caps().seeList) renderList(); else renderMine();
        showToast(gorderDept ? ('已保存「' + gorderDept + '」的顺序')
            : '已保存「全部部门」的顺序');
        switchView('list');
    });
}
function resetGroupOrder() {
    var who = gorderDept ? ('「' + gorderDept + '」') : '「全部部门」';
    if (!confirm('恢复' + who + '的默认顺序?(只清空这一套自定义排序和置顶,其他部门不受影响)')) return;
    var obj = {}, k;
    for (k in GORDERS) if (Object.prototype.hasOwnProperty.call(GORDERS, k)) obj[k] = GORDERS[k];
    delete obj[gorderDept];
    EquipApi.groupOrderSet(obj).then(function (r) {
        if (!r.ok) { showToast(r.msg || '重置失败'); return; }
        GORDERS = gorderNorm(obj);
        gorderDraft = buildGroupOrderDraft(gorderDept);
        renderGroupOrder();
        showToast('已恢复' + who + '的默认顺序');
    });
}

// ---------- 类别改名(该类别下所有设备的 family 一起改;可改名到已有类别=合并) ----------
var catRenameIdx = -1;
function openCatRename(i) {
    if (!caps().manageDevices) { showToast('仅设备管理员可改类别名'); return; }
    var a = gorderDraft || [], it = a[i];
    if (!it) return;
    var m = $('cat-modal');
    if (!m) return;
    catRenameIdx = i;
    $('cat-old').textContent = it.n;
    // 注意:改名是全公司生效的,而排序页可能正按某个部门在看,所以这里一律显示全公司台数
    $('cat-cnt').textContent = String(catDeviceCount(it.n));
    var inp = $('cat-input');
    inp.value = it.n;
    $('cat-warn').innerHTML = '';
    var tip = $('cat-tip');
    if (tip) {
        tip.innerHTML = '改名会把该类别下<b>所有设备</b>的类别一起改掉'
            + (gorderDept ? '（含其它部门，不限当前查看的「' + esc(gorderDept) + '」）' : '')
            + '，设备履历、工单不受影响。改成已经存在的类别名就是<b>合并</b>。';
    }
    m.classList.add('show');
    setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) { } }, 30);
}
function closeCatRename() {
    var m = $('cat-modal');
    if (m) m.classList.remove('show');
    catRenameIdx = -1;
}
// 某个类别名现在有多少台(用于改名前的「会合并多少台」提示)
function catDeviceCount(name) {
    var n = 0;
    for (var c in EQ) {
        if (!Object.prototype.hasOwnProperty.call(EQ, c)) continue;
        if (String((EQ[c] || {}).family || '').trim() === name) n++;
    }
    return n;
}
// 输入时实时提示:重名=合并;也能顺手提示空名
function onCatInput() {
    var a = gorderDraft || [], it = a[catRenameIdx] || {};
    var oldN = String(it.n || '');
    var v = String($('cat-input').value || '').trim();
    var w = $('cat-warn');
    if (!v) { w.innerHTML = '<span class="cat-warn-bad">类别名不能为空</span>'; return; }
    if (v === oldN) { w.innerHTML = '<span class="cat-warn-ok">未改动</span>'; return; }
    if (v.length > 40) { w.innerHTML = '<span class="cat-warn-bad">最多 40 个字</span>'; return; }
    var n = catDeviceCount(v);
    if (n > 0) {
        w.innerHTML = '<span class="cat-warn-bad">「' + esc(v) + '」已存在，共 ' + n
            + ' 台 —— 保存后会把两类合并成一类，合计 ' + (n + catDeviceCount(oldN)) + ' 台</span>';
    } else {
        w.innerHTML = '<span class="cat-warn-ok">将把 ' + catDeviceCount(oldN)
            + ' 台设备改成「' + esc(v) + '」</span>';
    }
}
function doCatRename() {
    var a = gorderDraft || [], it = a[catRenameIdx] || null;
    if (!it) { closeCatRename(); return; }
    var oldN = String(it.n || '');
    var newN = String($('cat-input').value || '').trim();
    if (!newN) { showToast('类别名不能为空'); return; }
    if (newN === oldN) { closeCatRename(); return; }
    var merged = catDeviceCount(newN);
    var total = catDeviceCount(oldN);
    if (merged > 0 && !confirm('「' + newN + '」已经有 ' + merged + ' 台设备。\n确定把「' + oldN + '」下的 '
        + total + ' 台并进去吗？(合并后共 ' + (merged + total) + ' 台，原类别名不再存在)')) return;
    var btn = $('cat-ok');
    if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
    EquipApi.catRename(oldN, newN).then(function (r) {
        if (btn) { btn.disabled = false; btn.textContent = '确定改名'; }
        if (!r.ok) { showToast(r.msg || '改名失败'); return; }
        // 本地档案同步(免得还要手动刷新一次)
        for (var c in EQ) {
            if (!Object.prototype.hasOwnProperty.call(EQ, c)) continue;
            if (String((EQ[c] || {}).family || '').trim() === oldN) EQ[c].family = newN;
        }
        closeCatRename();
        loadGroupOrder().then(function () {
            gorderDraft = buildGroupOrderDraft(gorderDept);
            renderGroupOrder();
            if (caps().seeList) renderList();
            showToast('已改名：' + oldN + ' → ' + newN + '（' + (r.n || 0) + ' 台）'
                + (r.merged ? ('，已与原有 ' + (r.merged_n || 0) + ' 台合并') : ''));
        });
    });
}

// ---------- 重新加载 ----------
// 整包重下(仅手动刷新 / 回收站恢复这类「一次改动影响多台」的场景用)
function reloadAll(cb) {
    EquipApi.listAll().then(function (r) {
        if (r.ok) { EQ = r.equipments || {}; renderList(); renderTodoBadge(); }
        if (cb) cb();
    });
}
// 保存成功后:本地 EQ 就是最新数据,只重绘,不再重下 1.76 MB 全量
function refreshLocal(code) {
    renderList(); renderTodoBadge();
    if (code) openDetail(code, true); else showListDefault();
}
// 服务端单方面改了数据(报修 / 回应):只重拉这一台,其余沿用本地
function refreshDevice(code) {
    EquipApi.getDevice(code).then(function (r) {
        if (r.ok) EQ[code] = r.equipment;
        renderList(); renderTodoBadge();
        openDetail(code, true);
    });
}

// ---------- 手动刷新 ----------
// 说明:新报修提醒统一走企业微信群机器人(服务端直发,页面关着也能收到),
// 页面内不再做定时轮询,避免每次刷新拉全量履历浪费流量。
function refreshList() {
    if (ROLE === 'reporter') { loadMine(currentCode); showToast('已刷新'); return; }
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

// 今日待办:发一条带【测试】标记的样例到群,便于核对格式
function testDailyTodo() {
    if (!caps().manageDevices) { showToast('仅设备管理员可测试'); return; }
    showToast('正在生成并发送…');
    EquipApi.dailyTodoTest().then(function (r) {
        if (!r.ok) { showToast(r.msg || '发送失败'); return; }
        if (r.local) {
            alert('本地模式:不真发,以下为预览\n\n' + (r.preview || ''));
            return;
        }
        showToast('测试消息已发送到群');
        if (r.preview) alert('已发送到群,内容如下:\n\n' + r.preview);
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
