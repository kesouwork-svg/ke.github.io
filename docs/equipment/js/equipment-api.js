/**
 * 设备履历卡 - 数据适配层
 * 本地沙箱:EqConfig.cloud=false → localStorage(与 ROI 的云端数据完全隔离)
 * 云端:走 Supabase RPC(equipment_list/get/save/delete),金额脱敏由服务端完成
 * 登录态复用 ROI 的 sessionStorage 'roi_session'(同域名共享)
 */
var EqConfig = {
    cloud: false,                           // 【feature-equipment 分支试用版】本地沙箱;上线前改 true
    supabaseUrl: 'https://frfsvgiykcytiemvallk.supabase.co',
    supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZyZnN2Z2l5a2N5dGllbXZhbGxrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyMTU4ODEsImV4cCI6MjEwMjc5MTg4MX0.ri51WLF_w-WgR4c1xcCKFa8GmueSsujmAgOZDt79Gjk'
};
(function () {
    if (location.search.indexOf('cloud=1') > -1) EqConfig.cloud = true;
})();

var EQ_KEY = 'equip_list';
var EQ_AUDIT_KEY = 'equip_audit';
var EQ_SEED_KEY = 'equip_seeded';

function eqSession() {
    try { return JSON.parse(sessionStorage.getItem('roi_session') || 'null'); } catch (e) { return null; }
}
function eqToken() { var s = eqSession(); return s ? (s.token || '') : ''; }
function eqUser() {
    var s = eqSession();
    if (!s) return null;
    return { account: s.account, name: s.name, level: s.level, tools: s.tools || null, guest: !!s.guest };
}
// 本地模式:工具权限判定(admin/1级默认全工具,其余看 tools 字段)
function localCanEdit() {
    var u = eqUser();
    if (!u) return false;
    if (u.account === 'admin' || u.level === 1) return true;
    return !!(u.tools && u.tools.indexOf('equipment') > -1);
}
function localGet() {
    try { return JSON.parse(localStorage.getItem(EQ_KEY) || '{}'); } catch (e) { return {}; }
}
function localSet(o) { localStorage.setItem(EQ_KEY, JSON.stringify(o)); }
function localAudit() {
    try { return JSON.parse(localStorage.getItem(EQ_AUDIT_KEY) || '[]'); } catch (e) { return []; }
}
function localPushAudit(code, action, summary) {
    var u = eqUser() || {};
    var a = localAudit();
    a.unshift({ at: new Date().toLocaleString('zh-CN'), account: u.account || '', name: u.name || '', code: code, action: action, summary: summary || '' });
    localStorage.setItem(EQ_AUDIT_KEY, JSON.stringify(a.slice(0, 500)));
}
// 只读脱敏(与云端 _mask_equip 等价,沙箱用)
function maskEquip(d) {
    var out = JSON.parse(JSON.stringify(d));
    var recs = out.records || [];
    for (var i = 0; i < recs.length; i++) {
        delete recs[i].laborFee;
        delete recs[i].outsourceFee;
        var ps = recs[i].parts || [];
        for (var j = 0; j < ps.length; j++) delete ps[j].price;
    }
    return out;
}

// ---------- Supabase 客户端 ----------
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

// ---------- 示例数据(仅本地沙箱,首次自动灌入) ----------
function seedLocal() {
    if (localStorage.getItem(EQ_SEED_KEY)) return;
    var list = localGet();
    if (Object.keys(list).length > 0) { localStorage.setItem(EQ_SEED_KEY, '1'); return; }
    var mk = function (code, name, model, line, owner, status, installDate) {
        return { code: code, name: name, model: model, vendor: '', line: line, owner: owner, status: status, installDate: installDate, remark: '', records: [] };
    };
    list['EQ-001'] = mk('EQ-001', '一号线 装配机', 'ZP-200', '一号线', '张三', 'active', '2024-03-12');
    list['EQ-002'] = mk('EQ-002', '二号线 点胶机', 'DJ-350', '二号线', '李四', 'active', '2024-06-20');
    list['EQ-003'] = mk('EQ-003', '三号线 检测台', 'JC-100', '三号线', '王五', 'idle', '2023-11-05');
    var r1 = { id: 'r' + Date.now() + '1', type: 'fault', date: '2026-10-12', handler: '李四', symptom: '伺服报警停机,面板显示 AL-24', causeCat: 'electrical', cause: '驱动器散热风扇卡死导致过温', action: '更换驱动器风扇,清洁散热片', resolved: true, downHours: 2.5, parts: [{ name: '伺服驱动器风扇', model: 'FAN-24V', qty: 1, price: 260 }], laborFee: 0, outsourceFee: 0, remark: '', photos: [] };
    var r2 = { id: 'r' + Date.now() + '2', type: 'maintain', date: '2026-09-28', handler: '张三', symptom: '季度保养', causeCat: '', cause: '', action: '清洁导轨、更换润滑脂、检查气路', resolved: true, downHours: 4, parts: [{ name: '锂基润滑脂', model: '2#', qty: 1, price: 85 }], laborFee: 120, outsourceFee: 0, remark: '', photos: [] };
    var r3 = { id: 'r' + Date.now() + '3', type: 'fault', date: '2026-08-15', handler: '张三', symptom: '气缸漏气导致取件失败', causeCat: 'pneumatic', cause: '密封圈老化', action: '更换气缸密封圈', resolved: true, downHours: 1.5, parts: [{ name: '气缸密封圈', model: 'SC-32', qty: 2, price: 15 }], laborFee: 0, outsourceFee: 0, remark: '', photos: [] };
    list['EQ-001'].records = [r1, r2, r3];
    list['EQ-002'].records = [Object.assign({}, r2, { id: 'r' + Date.now() + '4', handler: '李四' })];
    localSet(list);
    localStorage.setItem(EQ_SEED_KEY, '1');
}

// ============================================================
// 对外接口
// ============================================================
var EquipApi = {
    session: eqSession,
    token: eqToken,
    user: eqUser,

    // 当前用户是否可编辑设备履历
    canEdit: function () {
        if (EqConfig.cloud) return this._cloudCanEdit === undefined ? false : this._cloudCanEdit;
        return localCanEdit();
    },

    // 列表:返回 { ok, canEdit, equipments:{code:data} }
    list: function () {
        if (EqConfig.cloud) {
            return eqRpc('equipment_list', { p_token: eqToken() }).then(function (r) {
                if (r.ok) {
                    EquipApi._cloudCanEdit = !!r.data.canEdit;
                    return { ok: true, canEdit: !!r.data.canEdit, equipments: r.data.equipments || {} };
                }
                return r;
            });
        }
        seedLocal();
        var ce = localCanEdit();
        var all = localGet();
        var out = {};
        for (var k in all) out[k] = ce ? all[k] : maskEquip(all[k]);
        return Promise.resolve({ ok: true, canEdit: ce, equipments: out });
    },

    // 单台
    get: function (code) {
        if (EqConfig.cloud) {
            return eqRpc('equipment_get', { p_token: eqToken(), p_code: code });
        }
        var ce = localCanEdit();
        var d = localGet()[code];
        if (!d) return Promise.resolve({ ok: false, msg: '设备不存在' });
        return Promise.resolve({ ok: true, canEdit: ce, equipment: ce ? d : maskEquip(d) });
    },

    // 保存设备(整包)
    save: function (code, data, summary) {
        if (EqConfig.cloud) {
            return eqRpc('equipment_save', { p_token: eqToken(), p_code: code, p_data: data, p_summary: summary || '' });
        }
        if (!localCanEdit()) return Promise.resolve({ ok: false, msg: '无设备履历编辑权限' });
        var all = localGet();
        all[code] = data;
        localSet(all);
        localPushAudit(code, 'save', summary || '');
        return Promise.resolve({ ok: true });
    },

    // 删除设备
    remove: function (code) {
        if (EqConfig.cloud) {
            return eqRpc('equipment_delete', { p_token: eqToken(), p_code: code });
        }
        if (!localCanEdit()) return Promise.resolve({ ok: false, msg: '无设备履历编辑权限' });
        var all = localGet();
        delete all[code];
        localSet(all);
        localPushAudit(code, 'delete', '删除设备');
        return Promise.resolve({ ok: true });
    },

    // 编辑留痕
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
