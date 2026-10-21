/**
 * 设备履历卡 - 数据适配层(v2:报修工单 + 三档权限)
 * 角色:manage(管理/维修,全量) / report(报修人,仅扫码单台状态) / view(普通账号,仅设备基本状况)
 * 本地沙箱:EqConfig.cloud=false → localStorage;云端走 Supabase RPC(脱敏在服务端)
 * 登录态复用 ROI 的 'roi_session'(同域名共享,由 js/session.js 统一读写)
 */
var EqConfig = {
    cloud: true,                           // 【feature-equipment 分支试用版】本地沙箱;上线前改 true
    supabaseUrl: 'https://frfsvgiykcytiemvallk.supabase.co',
    supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZyZnN2Z2l5a2N5dGllbXZhbGxrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyMTU4ODEsImV4cCI6MjEwMjc5MTg4MX0.ri51WLF_w-WgR4c1xcCKFa8GmueSsujmAgOZDt79Gjk'
};
(function () {
    if (location.search.indexOf('cloud=1') > -1) EqConfig.cloud = true;
})();

// 存储兜底:file:// 或隐私模式下 localStorage 可能不可用,退化为内存(仅当前页面有效)
var _memStore = {};
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return (k in _memStore) ? _memStore[k] : null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { _memStore[k] = String(v); } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { delete _memStore[k]; } }

var EQ_KEY = 'equip_list_v2';   // v2:真实案例数据,旧键 equip_list 作废
var EQ_AUDIT_KEY = 'equip_audit_v2';
var EQ_SEED_KEY = 'equip_seed_v2';

// 演示模式下的内存会话:file:// 下 iframe 可能读写不了 sessionStorage
var _demoSession = null;
function eqSession() {
    if (_demoSession) return _demoSession;
    try { return JSON.parse(SessionStore.raw() || 'null'); } catch (e) { return null; }
}
function eqToken() { var s = eqSession(); return s ? (s.token || '') : ''; }
function eqUser() {
    var s = eqSession();
    if (!s) return null;
    return { account: s.account, name: s.name, level: s.level, tools: s.tools || null, guest: !!s.guest };
}
// 角色判定:与 ROI 等级无关,只看 tools(admin 账号兜底为设备管理员)
// admin=设备管理员 / repairer=维修人 / reporter=报修人 / view=普通账号(仅扫码看基本状况)
function eqRole() {
    var u = eqUser();
    if (!u) return 'none';
    if (u.guest) return 'view';
    if (u.account === 'admin') return 'admin';
    var t = u.tools || [];
    if (t.indexOf('equipment-admin') > -1) return 'admin';
    if (t.indexOf('equipment') > -1) return 'repairer';
    if (t.indexOf('equipment-report') > -1) return 'reporter';
    return 'view';
}

function localGet() {
    return JSON.parse(lsGet(EQ_KEY) || '{}');
}
function localSet(o) { lsSet(EQ_KEY, JSON.stringify(o)); }
function localAudit() {
    return JSON.parse(lsGet(EQ_AUDIT_KEY) || '[]');
}
function localPushAudit(code, action, summary) {
    var u = eqUser() || {};
    var a = localAudit();
    a.unshift({ at: new Date().toLocaleString('zh-CN'), account: u.account || '', name: u.name || '', code: code, action: action, summary: summary || '' });
    lsSet(EQ_AUDIT_KEY, JSON.stringify(a.slice(0, 800)));
}

// 本地模式:按天流水生成工单号(与云端 _equip_next_no 规则一致)
function localNextNo(all) {
    var d = new Date();
    var day = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    var pfx = 'WO' + day + '-';
    var max = 0;
    for (var c in (all || {})) {
        var rs = (all[c].records || []);
        for (var i = 0; i < rs.length; i++) {
            var no = rs[i].no || '';
            if (no.indexOf(pfx) === 0) {
                var n = parseInt(no.slice(pfx.length), 10);
                if (n > max) max = n;
            }
        }
    }
    return pfx + String(max + 1).padStart(2, '0');
}

// 本地时间戳:YYYY-MM-DD HH:MM(与云端 to_char(now(),'YYYY-MM-DD HH24:MI') 一致)
function nowStamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ---------- 脱敏(与云端 _mask_* 等价,沙箱用) ----------
// 报修人视图:只保留 日期/现象/状态/预计完成
function maskForReport(d) {
    var out = { code: d.code, name: d.name, number: d.number, line: d.line, category: d.category, status: d.status, owner: d.owner, records: [] };
    var rs = d.records || [];
    for (var i = 0; i < rs.length; i++) {
        var r = rs[i];
        out.records.push({
            id: r.id, no: r.no || '', type: r.type, status: r.status,
            reportAt: r.reportAt || r.date || '', expectedAt: r.expectedAt || '',
            symptom: r.symptom || '', doneAt: r.doneAt || '', place: r.place || '',
            updates: r.updates || []
        });
    }
    out.records.sort(function (a, b) { return (a.reportAt || '') < (b.reportAt || '') ? 1 : -1; });
    return out;
}
// 普通账号视图:只有设备基本状况
function maskForView(d) {
    return { code: d.code, name: d.name, number: d.number, line: d.line, category: d.category, status: d.status };
}

// ---------- Supabase ----------
var _eqSb = null;
function eqSb() {
    if (!_eqSb && window.supabase && EqConfig.supabaseUrl && EqConfig.supabaseKey) {
        _eqSb = window.supabase.createClient(EqConfig.supabaseUrl, EqConfig.supabaseKey);
    }
    return _eqSb;
}
function eqRpc(fn, params) {
    var sb = eqSb();
    if (!sb) return Promise.resolve({ ok: false, msg: 'Supabase 未加载' });
    return sb.rpc(fn, params).then(function (r) {
        if (r.error) return { ok: false, msg: r.error.message || '请求失败' };
        return r.data || { ok: false, msg: '空响应' };
    }).catch(function (e) {
        return { ok: false, msg: (e && e.message) || '网络错误' };
    });
}

// ============================================================
// 示例数据:来自公司现有《设备维修跟踪记录表2026年》真实案例(5台设备×最近6条)
// ============================================================
function seedLocal() {
    if (lsGet(EQ_SEED_KEY)) return;
    if (Object.keys(localGet()).length > 0) { lsSet(EQ_SEED_KEY, '1'); return; }
    // 清理旧版虚构示例(equip_list)避免混淆
    try { lsDel('equip_list'); lsDel('equip_audit'); } catch (e) { }
    var D = {};
    function dev(code, name, number, line, category, status) {
        D[code] = { code: code, name: name, number: number, line: line, category: category, status: status || 'active', owner: '', model: '', vendor: '', installDate: '', remark: '', records: [], photos: [] };
        return D[code];
    }
    var adm = dev('ADM-001', '行政工作', '', '行政部', 'misc', 'active');
    var inj = dev('PS41-17', '注塑机', 'PS41-17', '注塑部', 'prod', 'active');
    var grin = dev('PS04-70', '双面磨', 'PS04-70', '水磨组', 'prod', 'active');
    var punch = dev('PS06-65', '16T冲床', 'PS06-65', '冲压组', 'prod', 'active');
    var cnc = dev('PS00-72', '钻攻中心', 'PS00-72', '机加组', 'prod', 'active');

    function rec(id, o) {
        return {
            id: id, no: o.no || '', type: o.type || 'fault', status: o.status || (o.doneAt ? 'done' : 'open'),
            reportAt: o.reportAt || '', reportBy: o.reportBy || '',
            place: o.place || '',
            expectedAt: o.expectedAt || '', doneAt: o.doneAt || '',
            handler: o.handler || '', symptom: o.symptom || '',
            cause1: o.cause1 || '', cause2: o.cause2 || '', cause3: o.cause3 || '',
            cause: o.cause || '', action: o.action || '',
            handleType: o.handleType || '', repairMode: o.repairMode || 'inner', supplier: o.supplier || '',
            parts: o.part ? [{ name: o.part, qty: 1 }] : [],
            cost: o.cost || 0, delayReason: o.delayReason || '', remark: '', photos: [],
            updates: o.updates || [],
            createdAt: '', createdBy: '', updatedAt: '', updatedBy: ''
        };
    }
    adm.records = [
        rec('r1', { reportAt: '2026-10-16', reportBy: '许仕喜', expectedAt: '2026-10-16', doneAt: '2026-10-16', symptom: '修好饭堂电饭煲一个,更换磁吸开关', cause: '按钮开关故障失效', action: '更换按钮开关', part: '按钮开关', handleType: 'repair', handler: '许仕喜', cost: 0, cause2: '设备电气故障', cause3: '电气元件故障' }),
        rec('r2', { reportAt: '2026-10-15', reportBy: '许仕喜', expectedAt: '2026-10-15', doneAt: '2026-10-15', symptom: '维修好厨房洗碗机洗洁料自动加液泵', cause: '行政协助工作', action: '维修加液泵', handleType: 'repair', handler: '许仕喜' }),
        rec('r3', { reportAt: '2026-10-15', reportBy: '许仕喜', expectedAt: '2026-10-15', doneAt: '2026-10-15', symptom: '更换好一栋一楼生产办公室门合页3个', cause: '合页损坏', action: '更换合页', part: '合页', handleType: 'replace', handler: '许仕喜' }),
        rec('r4', { reportAt: '2026-10-14', reportBy: '林显柳', expectedAt: '2026-10-14', doneAt: '2026-10-14', symptom: '1楼3楼办公室厕所筒灯更换,共25个照明灯', cause: '照明灯故障损坏', action: '更换照明灯', part: '照明灯', handleType: 'replace', handler: '许仕喜', cause2: '照明线路设施维修维护', cause3: '照明灯具耗损' }),
        rec('r5', { reportAt: '2026-10-09', reportBy: '黄艳姬', expectedAt: '2026-10-09', doneAt: '2026-10-09', symptom: '@许仕喜 喜哥,楼顶上两个路灯不亮了,麻烦维修', cause: '照明灯故障损坏', action: '更换照明灯', part: '照明灯', handleType: 'replace', handler: '许仕喜', cause2: '照明线路设施维修维护', cause3: '照明灯具耗损' }),
        rec('r6', { reportAt: '2026-10-08', reportBy: '钟章要', expectedAt: '2026-10-09', doneAt: '2026-10-09', symptom: '1幢男卫生间照明灯坏了,麻烦更换下,晚上太暗了', cause: '照明灯故障损坏', action: '安装照明光管', part: '照明灯', handleType: 'replace', handler: '许仕喜', cause2: '照明线路设施维修维护', cause3: '照明灯具耗损' })
    ];
    inj.records = [
        rec('r7', { no: 'WO261016-01', reportAt: '2026-10-16', place: '注塑车间15号机位', reportBy: '钟章要', expectedAt: '2026-10-20', doneAt: '', symptom: '@德志,注塑15号机械手横出报警异常,已安排外协明天来检修', handler: '' }),
        rec('r8', { reportAt: '2026-10-13', reportBy: '钟章要', expectedAt: '2026-10-13', doneAt: '2026-10-13', symptom: '注塑车间8号机第5段温异常,更换接触器', cause: '交流接触器故障失效', action: '更换交流接触器', part: '交流接触器', handleType: 'replace', handler: '许仕喜', cause2: '设备电气故障', cause3: '温控加热系统故障' }),
        rec('r9', { reportAt: '2026-10-12', reportBy: '钟章要', expectedAt: '2026-10-12', doneAt: '2026-10-12', symptom: '注塑部9号机冷水管开关破裂,漏水严重', cause: '球阀故障损坏', action: '更换球阀', part: '球阀', handleType: 'replace', handler: '许仕喜', cause2: '设备给排水管路系统故障', cause3: '设备给排水管路故障' }),
        rec('r10', { reportAt: '2026-10-12', reportBy: '钟章要', expectedAt: '2026-10-12', doneAt: '2026-10-12', symptom: '注塑部12号机汽管漏汽严重', cause: '气管破损漏气', action: '更换气管', part: '气管', handleType: 'replace', handler: '许仕喜', cause2: '设备气动系统故障', cause3: '气动管路、接头损坏泄漏' }),
        rec('r11', { reportAt: '2026-10-08', reportBy: '张皓凯', expectedAt: '2026-10-08', doneAt: '2026-10-08', symptom: '注塑部10号机烤桶温度上不去,更换发热丝', cause: '发热管故障失效', action: '更换发热管', part: '发热管', handleType: 'replace', handler: '许仕喜', cause2: '设备电气故障', cause3: '温控加热系统故障' }),
        rec('r12', { reportAt: '2026-10-06', reportBy: '张皓凯', expectedAt: '2026-10-06', doneAt: '2026-10-06', symptom: '注塑部7号机机械手副臂上下感应器灯不亮', cause: '线路故障,接触不良', action: '检修电路', handleType: 'repair', handler: '张德志', cause2: '设备电气故障', cause3: '电气线路故障' })
    ];
    grin.records = [
        rec('r13', { no: 'WO261016-02', reportAt: '2026-10-16', place: '2栋1楼水磨组东侧', reportBy: '姜华友', expectedAt: '2026-10-19', doneAt: '', symptom: '2栋油泵、缓冲漏油,待买缓冲阀更换', updates: [{ at: '2026-10-16 15:20', by: '许仕喜', text: '已联系供应商报价,缓冲阀预计下周一到货' }] }),
        rec('r14', { reportAt: '2026-09-12', reportBy: '邓广文', expectedAt: '2026-09-12', doneAt: '2026-09-12', symptom: '4栋36号双面磨合石开关坏', cause: '按钮开关故障失效', action: '更换按钮开关', part: '按钮开关', handleType: 'replace', handler: '许仕喜', cause2: '设备电气故障', cause3: '电气元件故障' }),
        rec('r15', { reportAt: '2026-09-05', reportBy: '邓广文', expectedAt: '2026-09-05', doneAt: '2026-09-05', symptom: '4栋36号双面磨进入没法出来', cause: '动作异常', action: '检查正常', handleType: 'repair', handler: '许仕喜', cause2: '设备电气故障', cause3: '未检查出异常' }),
        rec('r16', { reportAt: '2026-09-03', reportBy: '姜华友', expectedAt: '2026-09-03', doneAt: '2026-09-03', symptom: '2栋57号双面磨离合转换开关坏了,急用', cause: '按钮开关故障失效', action: '更换开关', part: '按钮开关', handleType: 'replace', handler: '许仕喜', cause2: '设备电气故障', cause3: '电气元件故障' }),
        rec('r17', { reportAt: '2026-08-29', reportBy: '姜华友', expectedAt: '2026-08-29', doneAt: '2026-09-11', symptom: '2栋57号双面磨拖板异常', cause: '油缸漏油', action: '更换油缸总成', part: '油缸', handleType: 'replace', handler: '陈星宇', repairMode: 'outer', supplier: '陈英干', cost: 380, delayReason: '外协工作延时', cause2: '设备液压故障', cause3: '液压部件故障' }),
        rec('r18', { reportAt: '2026-08-19', reportBy: '姜华友', expectedAt: '2026-08-19', doneAt: '2026-08-28', symptom: '4栋36号双面磨离合坏了,无法正常生产,急用', cause: '三头牙轴承磨损', action: '更换轴承', part: '轴承', handleType: 'repair', handler: '陈星宇', repairMode: 'outer', supplier: '陈英干', cost: 1000, delayReason: '外协工作延时', cause2: '设备机械故障', cause3: '运动部件磨损、疲劳' })
    ];
    punch.records = [
        rec('r19', { reportAt: '2026-10-17', reportBy: '马显军', expectedAt: '2026-10-17', doneAt: '2026-10-17', symptom: '2幢车间16T冲床刹车挡块不转动,急用', cause: '弹簧断裂', action: '更换弹簧', part: '弹簧', handleType: 'replace', handler: '许仕喜', cause2: '设备机械故障', cause3: '结构部件磨损、损坏' }),
        rec('r20', { reportAt: '2026-10-12', reportBy: '马显军', expectedAt: '2026-10-12', doneAt: '2026-10-13', symptom: '2幢车间16T冲床刹车弹簧断', cause: '弹簧断裂', action: '更换弹簧', part: '弹簧', handleType: 'replace', handler: '许仕喜', delayReason: '', cause2: '设备机械故障', cause3: '结构部件磨损、损坏' }),
        rec('r21', { reportAt: '2026-10-11', reportBy: '马显军', expectedAt: '2026-10-11', doneAt: '2026-10-11', symptom: '16T冲床照明灯有时不亮', cause: '照明灯故障损坏', action: '更换照明灯', part: '照明灯', handleType: 'replace', handler: '许仕喜', cause1: '行政设备设施维修维护', cause2: '照明线路设施维修维护', cause3: '照明灯具耗损' }),
        rec('r22', { reportAt: '2026-10-07', reportBy: '马显军', expectedAt: '2026-10-07', doneAt: '2026-10-07', symptom: '16T冲床吹气异常', cause: '线路故障,接触不良', action: '检修电路', handleType: 'repair', handler: '韦椅钟', cause2: '设备电气故障', cause3: '电气线路故障' }),
        rec('r23', { reportAt: '2026-10-04', reportBy: '马显军', expectedAt: '2026-10-04', doneAt: '2026-10-04', symptom: '16T冲床照明灯坏', cause: '工作灯故障损坏', action: '更换灯头', part: '工作灯', handleType: 'replace', handler: '许仕喜', cause2: '照明线路设施维修维护', cause3: '照明灯具耗损' }),
        rec('r24', { reportAt: '2026-09-21', reportBy: '马显军', expectedAt: '2026-09-21', doneAt: '2026-09-21', symptom: '16T冲床滑块动不了', cause: '弹簧断裂', action: '更换弹簧', part: '弹簧', handleType: 'replace', handler: '许仕喜', cause2: '设备机械故障', cause3: '结构部件磨损、损坏' })
    ];
    cnc.records = [
        rec('r25', { reportAt: '2026-10-16', reportBy: '官雪锋', expectedAt: '2026-10-20', doneAt: '2026-10-17', symptom: '72号机打不开夹具,气动阀门坏,待买配件改气管', cause: '气动阀故障失效', action: '整改优化气动控制管路', handleType: 'repair', handler: '许仕喜', cause2: '设备升级优化改造', cause3: '设备升级改造或加装零部件' }),
        rec('r26', { reportAt: '2026-10-13', reportBy: '官雪锋', expectedAt: '2026-10-13', doneAt: '2026-10-13', symptom: '118号机按钮卡死,面板动不了', cause: '按钮开关故障失效', action: '开关复位', handleType: 'repair', handler: '许仕喜', cause2: '设备电气故障', cause3: '电气元件故障' }),
        rec('r27', { reportAt: '2026-10-09', reportBy: '官雪锋', expectedAt: '2026-10-09', doneAt: '2026-10-09', symptom: '72号机开关坏,线路断线', cause: '按钮开关故障失效', action: '更换按钮开关', part: '按钮开关', handleType: 'replace', handler: '许仕喜', cause2: '设备电气故障', cause3: '电气元件故障' }),
        rec('r28', { reportAt: '2026-10-07', reportBy: '官雪锋', expectedAt: '2026-10-07', doneAt: '2026-10-07', symptom: '70号机报警,复位后正常', cause: '系统故障', action: '电气复位', handleType: 'repair', handler: '许仕喜', cause2: '设备电气故障', cause3: '电气控制系统故障' }),
        rec('r29', { reportAt: '2026-10-07', reportBy: '官雪锋', expectedAt: '2026-10-07', doneAt: '2026-10-07', symptom: '78号机显示灯不亮', cause: '工作灯故障损坏', action: '更换工作灯', part: '工作灯', handleType: 'replace', handler: '韦椅钟', cause2: '照明线路设施维修维护', cause3: '照明灯具耗损' }),
        rec('r30', { reportAt: '2026-10-07', reportBy: '官雪峰', expectedAt: '2026-10-09', doneAt: '2026-10-09', symptom: '伺服电机过热警报', cause: 'X轴伺服电机故障损坏', action: '维修电机', part: '电机', handleType: 'repair', handler: '张德志', repairMode: 'outer', supplier: '罗健兴', cost: 950, cause2: '设备电气故障', cause3: '电气元件故障' })
    ];
    for (var c in D) {
        var rs = D[c].records;
        for (var i = 0; i < rs.length; i++) {
            if (rs[i].status === 'done') {
                rs[i].createdBy = rs[i].handler || '许仕喜';
                rs[i].createdAt = rs[i].doneAt || '';
                rs[i].updatedBy = rs[i].handler || '许仕喜';
                rs[i].updatedAt = rs[i].doneAt || '';
            } else {
                rs[i].createdBy = rs[i].reportBy;
                rs[i].createdAt = rs[i].reportAt;
            }
        }
    }
    localSet(D);
    lsSet(EQ_SEED_KEY, '1');
}

// ============================================================
// 对外接口
// ============================================================
var EquipApi = {
    session: eqSession,
    token: eqToken,
    user: eqUser,
    role: eqRole,

    // 仅演示/预览使用:注入内存会话(file:// 下 sessionStorage 可能不可用)
    demoSession: function (o) { _demoSession = o; },

    // 从服务端刷新会话(权限被管理员改动后无需重新登录)
    refresh: function () {
        if (!EqConfig.cloud) return Promise.resolve({ ok: true });
        var s = eqSession();
        if (!s || !s.token) return Promise.resolve({ ok: false });
        return eqRpc('me', { p_token: s.token }).then(function (r) {
            if (!r.ok) return r;
            var u = (r.data && r.data.user) || {};
            try {
                SessionStore.write(JSON.stringify({
                    token: s.token, account: u.account, name: u.name,
                    level: u.level, tools: u.tools || []
                }));
            } catch (e) { }
            return { ok: true };
        });
    },

    // 管理视图:全部设备
    listAll: function () {
        if (EqConfig.cloud) {
            return eqRpc('equipment_list', { p_token: eqToken() }).then(function (r) {
                if (r.ok) return { ok: true, role: r.data.role || 'admin', equipments: r.data.equipments || {} };
                return { ok: false, msg: r.msg || '无权限' };
            });
        }
        var r0 = eqRole();
        if (r0 !== 'admin' && r0 !== 'repairer') return Promise.resolve({ ok: false, msg: '无权限' });
        seedLocal();
        return Promise.resolve({ ok: true, role: r0, equipments: localGet() });
    },

    // 单台设备:按角色返回不同深度
    getDevice: function (code) {
        if (EqConfig.cloud) {
            return eqRpc('equipment_get', { p_token: eqToken(), p_code: code }).then(function (r) {
                if (!r.ok) return r;
                return { ok: true, role: r.data.role, equipment: r.data.equipment };
            });
        }
        seedLocal();
        var role = eqRole();
        if (role === 'none') return Promise.resolve({ ok: false, msg: '未登录' });
        var d = localGet()[code];
        if (!d) return Promise.resolve({ ok: false, msg: '设备不存在' });
        var eq = (role === 'admin' || role === 'repairer') ? d : (role === 'reporter' ? maskForReport(d) : maskForView(d));
        return Promise.resolve({ ok: true, role: role, equipment: eq });
    },

    // 报修(manage / report 均可)
    report: function (code, payload) {
        if (EqConfig.cloud) {
            return eqRpc('equipment_report', {
                p_token: eqToken(), p_code: code,
                p_symptom: payload.symptom, p_expected: payload.expectedAt,
                p_reportby: payload.reportBy || '', p_place: payload.place || ''
            });
        }
        var role = eqRole();
        if (role !== 'admin' && role !== 'repairer' && role !== 'reporter') return Promise.resolve({ ok: false, msg: '无报修权限' });
        var all = localGet();
        var d = all[code];
        if (!d) return Promise.resolve({ ok: false, msg: '设备不存在' });
        var u = eqUser() || {};
        d.records = d.records || [];
        var wo = localNextNo(all);
        d.records.push({
            id: 'r' + Date.now(), no: wo, type: 'fault', status: 'open',
            reportAt: new Date().toISOString().slice(0, 10), reportBy: payload.reportBy || u.name || '',
            place: (payload.place || '').trim(),
            expectedAt: '', doneAt: '', handler: '', symptom: payload.symptom || '',
            cause1: '', cause2: '', cause3: '', cause: '', action: '', handleType: '', repairMode: 'inner', supplier: '',
            parts: [], cost: 0, delayReason: '', remark: '', photos: [],
            createdAt: new Date().toLocaleString('zh-CN'), createdBy: u.name || ''
        });
        localSet(all);
        localPushAudit(code, 'report', '报修:' + (payload.symptom || '').slice(0, 30));
        return Promise.resolve({ ok: true, no: wo });
    },

    // 回应报修(管理员/维修人):追加一条进度说明,可同时设置预计完成
    reply: function (code, recordId, text, expected) {
        if (EqConfig.cloud) {
            return eqRpc('equipment_reply', {
                p_token: eqToken(), p_code: code, p_record_id: recordId,
                p_text: text, p_expected: expected || ''
            });
        }
        var role = eqRole();
        if (role !== 'admin' && role !== 'repairer') return Promise.resolve({ ok: false, msg: '无回应权限' });
        if (!String(text || '').trim()) return Promise.resolve({ ok: false, msg: '请填写回应内容' });
        var all = localGet();
        var d = all[code];
        if (!d) return Promise.resolve({ ok: false, msg: '设备不存在' });
        var rec = null;
        (d.records || []).forEach(function (r) { if (r.id === recordId) rec = r; });
        if (!rec) return Promise.resolve({ ok: false, msg: '工单不存在' });
        if ((rec.status || (rec.doneAt ? 'done' : 'open')) === 'done') return Promise.resolve({ ok: false, msg: '该工单已完成' });
        var u = eqUser() || {};
        var upd = { at: nowStamp(), by: u.name || '', text: String(text).trim() };
        rec.updates = rec.updates || [];
        rec.updates.push(upd);
        if (expected && role === 'admin') rec.expectedAt = expected;
        localSet(all);
        localPushAudit(code, 'reply', '回应:' + upd.text.slice(0, 30));
        return Promise.resolve({ ok: true, update: upd });
    },

    // 保存设备(整包,仅 manage)
    save: function (code, data, summary) {
        if (EqConfig.cloud) {
            return eqRpc('equipment_save', { p_token: eqToken(), p_code: code, p_data: data, p_summary: summary || '' });
        }
        var role = eqRole();
        if (role !== 'admin' && role !== 'repairer') return Promise.resolve({ ok: false, msg: '无设备履历编辑权限' });
        var all = localGet();
        if (role === 'repairer') {
            var oldD = all[code];
            if (!oldD) return Promise.resolve({ ok: false, msg: '仅设备管理员可新增设备' });
            var strip = function (d) { var o = JSON.parse(JSON.stringify(d || {})); delete o.records; return JSON.stringify(o); };
            if (strip(oldD) !== strip(data)) return Promise.resolve({ ok: false, msg: '维修人不能修改设备档案' });
            // 故障分类/原因、维修类别、外协与费用、延期原因:只由设备管理员填写
            var KEEP = ['cause1', 'cause2', 'cause3', 'cause', 'handleType', 'repairMode', 'supplier', 'cost', 'delayReason'];
            var om = {};
            (oldD.records || []).forEach(function (r) { om[r.id] = r; });
            var bad = (data.records || []).some(function (r) {
                var o = om[r.id];
                if (!o) return false;
                for (var k = 0; k < KEEP.length; k++) {
                    var f = KEEP[k];
                    if (String(r[f] == null ? '' : r[f]) !== String(o[f] == null ? '' : o[f])) return true;
                }
                return false;
            });
            if (bad) return Promise.resolve({ ok: false, msg: '故障分类、维修类别、外协费用、延期原因由设备管理员填写' });
        }
        all[code] = data;
        localSet(all);
        localPushAudit(code, 'save', summary || '');
        return Promise.resolve({ ok: true });
    },

    remove: function (code) {
        if (EqConfig.cloud) return eqRpc('equipment_delete', { p_token: eqToken(), p_code: code });
        if (eqRole() !== 'admin') return Promise.resolve({ ok: false, msg: '仅设备管理员可删除设备' });
        var all = localGet();
        delete all[code];
        localSet(all);
        localPushAudit(code, 'delete', '删除设备');
        return Promise.resolve({ ok: true });
    },

    // 通知配置(webhook)
    getConfig: function () {
        if (EqConfig.cloud) {
            return eqRpc('admin_get_config', { p_token: eqToken() }).then(function (r) {
                return r.ok ? { ok: true, data: r.data } : r;
            });
        }
        return Promise.resolve({ ok: true, data: { wx_webhook: lsGet('eq_wx_webhook') || '', site_url: 'https://kekits.com/equipment/' } });
    },
    setConfig: function (k, v) {
        if (EqConfig.cloud) return eqRpc('admin_set_config', { p_token: eqToken(), p_key: k, p_value: v });
        lsSet(k === 'wx_webhook' ? 'eq_wx_webhook' : ('eq_' + k), v);
        return Promise.resolve({ ok: true });
    },

    auditList: function (code) {
        if (EqConfig.cloud) {
            return eqRpc('equipment_audit_list', { p_token: eqToken(), p_code: code }).then(function (r) {
                return r.ok ? { ok: true, logs: (r.data && r.data.logs) || [] } : r;
            });
        }
        var a = localAudit().filter(function (x) { return x.code === code; });
        return Promise.resolve({ ok: true, logs: a });
    }
};
