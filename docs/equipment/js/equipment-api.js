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

// 车间字典(取自现有台账真实值,15 个;与 SQL _equip_dept_list 保持一致)
var DEPTS = ['冲压组', '注塑部', '水磨组', '行政部', '螺钉组', '成装组', '模具部', '生管部',
    '砂房组', '机加组', '奈爱制造部', '美容工具部', '生技部', '线割组', '品管组'];

// 类别排序的存储归一:{ '':[全部部门那套], '冲压组':[本部门那套], ... }
// 兼容历史格式:纯数组(旧的全公司一套)→ {'': 数组}
function gorderNorm(d) {
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
    if (Object.prototype.toString.call(d) === '[object Array]') d = { '': d };
    if (!d || typeof d !== 'object') return {};
    var out = {}, k, v, clean;
    for (k in d) {
        if (!Object.prototype.hasOwnProperty.call(d, k)) continue;
        v = d[k];
        if (Object.prototype.toString.call(v) !== '[object Array]') continue;
        clean = [];
        for (var i = 0; i < v.length; i++) {
            var it = v[i] || {}, n = String(it.n || '').trim();
            if (!n) continue;
            clean.push({ n: n, pin: !!it.pin });
        }
        if (clean.length) out[String(k || '')] = clean;
    }
    return out;
}

// 通用报修卡的设备编号:GEN-D01..GEN-D15(未知车间用 GEN-<哈希>)
function genericCode(dept) {
    var d = String(dept || '').trim();
    if (!d) return '';
    var i = DEPTS.indexOf(d);
    if (i < 0) return '';
    return 'GEN-D' + String(i + 1).padStart(2, '0');
}
// 本地模式:确保本车间通用报修卡存在(幂等),返回编号
function ensureGenericLocal(dept) {
    var d = String(dept || '').trim();
    var code = genericCode(d);
    if (!code) return '';
    var all = localGet();
    if (all[code]) return code;
    all[code] = {
        code: code, name: '通用报修 · ' + d, number: '', line: d,
        category: 'misc', status: 'active', owner: '', model: '', vendor: '', installDate: '',
        remark: '本车间通用报修入口(无固定二维码的设备与杂项)', records: [], photos: []
    };
    localSet(all);
    return code;
}

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
    return { account: s.account, name: s.name, level: s.level, tools: s.tools || null, dept: s.dept || '', guest: !!s.guest };
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
// 更正后的整包保存使用独立版本令牌,避免旧页面把已移动/更正的工单写回。
var _recordsRevSeq = 0;
function nextRecordsRev() {
    var crypto = window.crypto || window.msCrypto;
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    if (crypto && typeof crypto.getRandomValues === 'function') {
        var bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.prototype.map.call(bytes, function (n) { return ('0' + n.toString(16)).slice(-2); }).join('');
    }
    _recordsRevSeq++;
    return Date.now().toString(36) + '-' + _recordsRevSeq.toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
}
// JSON 值按内容比较(对象键序无关),供整包保存保护只追加历史。
function sameJsonValue(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object'
        || Array.isArray(a) !== Array.isArray(b)) return false;
    var keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length || (Array.isArray(a) && a.length !== b.length)) return false;
    return keys.every(function (key) {
        return Object.prototype.hasOwnProperty.call(b, key) && sameJsonValue(a[key], b[key]);
    });
}
function localAudit() {
    return JSON.parse(lsGet(EQ_AUDIT_KEY) || '[]');
}
function localPushAudit(code, action, summary) {
    var u = eqUser() || {};
    var a = localAudit();
    a.unshift({ at: new Date().toLocaleString('zh-CN'), account: u.account || '', name: u.name || '', code: code, action: action, summary: summary || '' });
    lsSet(EQ_AUDIT_KEY, JSON.stringify(a.slice(0, 800)));
}

// ---------- 回收站(本地模式;云端走 recycle_bin 表 + RPC) ----------
// 语义与 SQL 一致:kind = equipment(设备,含全部工单) / record(单条工单),保留 30 天
var EQ_TRASH_KEY = 'equip_trash_v1';
var TRASH_KEEP_DAYS = 30;
function localTrash() {
    try { return JSON.parse(lsGet(EQ_TRASH_KEY) || '[]'); } catch (e) { return []; }
}
function localTrashSet(a) { lsSet(EQ_TRASH_KEY, JSON.stringify((a || []).slice(0, 500))); }
function _trashPad(n) { return String(n).length < 2 ? ('0' + n) : String(n); }
function _trashStamp(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + _trashPad(d.getMonth() + 1) + '-' + _trashPad(d.getDate()) + ' '
        + _trashPad(d.getHours()) + ':' + _trashPad(d.getMinutes()) + ':' + _trashPad(d.getSeconds());
}
function localTrashPush(kind, ref, label, snap) {
    var u = eqUser() || {};
    var now = new Date();
    var keep = new Date(now.getTime() + TRASH_KEEP_DAYS * 86400000);
    var a = localTrash();
    a.unshift({
        id: now.getTime() + Math.floor(Math.random() * 1000),
        kind: kind, ref_key: ref || '', label: label || '', snapshot: snap,
        deleted_at: _trashStamp(now), deleted_by: u.account || '',
        deleted_by_name: u.name || u.account || '', purge_at: _trashStamp(keep)
    });
    localTrashSet(a);
}
// 与 SQL 的 _trash_purge_expired 等价:过期的直接丢掉
function localTrashSweep() {
    var now = _trashStamp();
    var a = localTrash().filter(function (it) { return !it.purge_at || it.purge_at >= now; });
    localTrashSet(a);
    return a;
}
function localTrashDaysLeft(it) {
    var p = String(it.purge_at || '').slice(0, 10);
    if (!p) return TRASH_KEEP_DAYS;
    var d = Math.round((new Date(p + 'T00:00:00') - new Date(new Date().toDateString())) / 86400000);
    return d > 0 ? d : 0;
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
// family(设备类别)必须带上:报修人列表按类别分组、搜索都靠它
function maskForReport(d) {
    var out = { code: d.code, name: d.name, number: d.number, line: d.line, category: d.category, status: d.status, family: d.family || '', owner: d.owner, records: [] };
    var rs = d.records || [];
    for (var i = 0; i < rs.length; i++) {
        var r = rs[i];
        out.records.push({
            id: r.id, no: r.no || '', type: r.type, status: r.status,
            reportAt: r.reportAt || r.date || '', expectedAt: r.expectedAt || '',
            symptom: r.symptom || '', doneAt: r.doneAt || '', place: r.place || '',
            updates: r.updates || [],
            supplements: (Array.isArray(r._supplements) ? r._supplements : []).map(function (s) {
                s = s || {};
                return { at: s.at || '', by: s.by || '', text: s.text || '' };
            }),
            corrections: (Array.isArray(r._corrections) ? r._corrections : []).map(function (c) {
                c = c || {};
                return { by: c.by || '', at: c.at || '', summary: c.summary || '', reason: c.reason || '', fromCode: c.fromCode || '', toCode: c.toCode || '' };
            })
        });
    }
    out.records.sort(function (a, b) { return (a.reportAt || '') < (b.reportAt || '') ? 1 : -1; });
    return out;
}
// 普通账号视图:只有设备基本状况
function maskForView(d) {
    return { code: d.code, name: d.name, number: d.number, line: d.line, category: d.category, status: d.status };
}

// ---------- 每日待办(逾期 / 今天到期) ----------
// 说明:生产环境由 SQL 函数 _equip_todo_msg 生成同样的文本、pg_cron 每天 08:00 推送;
// 这里是本地沙箱/预览用的同一份格式实现,两边必须保持一致。
function todoTag(ups) {
    if (!ups || !ups.length) return '';
    var t = String((ups[ups.length - 1] || {}).text || '').trim();
    if (!t) return '';
    if (t.indexOf('备件') > -1) return '等备件';
    if (t.indexOf('外协') > -1) return '等外协';
    if (t.indexOf('采购') > -1) return '待采购';
    if (t.indexOf('停机') > -1 || t.indexOf('窗口') > -1) return '等停机窗口';
    return t.length > 10 ? (t.slice(0, 10) + '…') : t;
}
// 消息里的设备显示名(与 SQL _equip_label 保持一致):
// 有编号 → 名称 + 编号；无编号 → 名称 · 车间(名称里已含车间则不重复)
function equipLabel(x) {
    var name = String((x && x.name) || ''), num = String((x && x.number) || ''), line = String((x && x.line) || '');
    if (num) return name + ' ' + num;
    if (line && name.indexOf(line) < 0) return name + ' · ' + line;
    return name;
}
function buildTodoMsg(all, opts) {
    opts = opts || {};
    var now = new Date();
    function ymd(x) {
        return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
    }
    var today = ymd(now);
    var md = String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    var dow = '日一二三四五六'.charAt(now.getDay());
    var items = [];
    for (var c in (all || {})) {
        var e = all[c] || {};
        (e.records || []).forEach(function (r) {
            if ((r.status || (r.doneAt ? 'done' : 'open')) === 'done') return;
            var ex = String(r.expectedAt || '');
            if (!ex) return;                        // 没有预计完成,无法判断紧迫度
            var left = Math.round((new Date(today + 'T00:00:00') - new Date(ex + 'T00:00:00')) / 86400000);
            if (left < 0) return;                   // 还没到期,不推
            items.push({
                no: r.no || '', name: e.name || c, number: e.number || '', line: e.line || '',
                days: left, expected: ex, updates: r.updates || []
            });
        });
    }
    items.sort(function (a, b) {
        if (a.expected !== b.expected) return a.expected < b.expected ? -1 : 1;
        return (a.no || '') < (b.no || '') ? -1 : 1;
    });
    var overdue = items.filter(function (i) { return i.days > 0; }).length;
    var dueToday = items.filter(function (i) { return i.days === 0; }).length;
    var total = items.length;

    // 测试且没有真实待办时,用样例数据演示格式
    var sample = false;
    if (!total && opts.test) {
        sample = true;
        items = [
            { no: 'WO261018-03', name: '双面磨', number: 'PS04-70', line: '水磨组', days: 3, expected: '', updates: [{ text: '待备件到货' }] },
            { no: 'WO261016-02', name: '注塑机', number: 'PS41-17', line: '注塑部', days: 5, expected: '', updates: [] },
            { no: 'WO261021-01', name: '风扇', number: '', line: '水磨组', days: 0, expected: '', updates: [] }
        ];
        overdue = 2; dueToday = 1; total = 5;
    }

    var head = (opts.test ? '【测试】' : '') + '【今日待办】' + md + ' 周' + dow;
    var sum = '逾期 ' + overdue + ' 单 · 今天到期 ' + dueToday + ' 单';
    var lines = '';
    var shown = Math.min(items.length, 5);
    for (var i = 0; i < shown; i++) {
        var it = items[i];
        var one = (i + 1) + '. ' + (it.no || '(无单号)') + ' ' + equipLabel(it);
        one += (it.days > 0) ? (' · 逾期 ' + it.days + ' 天') : ' · 今天到期';
        var tag = todoTag(it.updates);
        if (tag) one += ' · ' + tag;
        lines += one + '\n';
    }
    var base = opts.base || 'https://kekits.com/equipment/';
    var link = base + '?todo=1';
    var msg = head + '\n' + sum + '\n\n' + lines + '\n[▶ 查看全部 ' + total + ' 单](' + link + ')';
    if (sample) msg += '\n\n> 以上为测试样例(当前没有逾期或今天到期的工单)';
    return { msg: msg, total: total, overdue: overdue, dueToday: dueToday, sample: sample };
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
    function dev(code, name, number, line, category, status, family) {
        D[code] = { code: code, name: name, number: number, line: line, category: category, family: family || '', status: status || 'active', owner: '', model: '', vendor: '', installDate: '', remark: '', records: [], photos: [] };
        return D[code];
    }
    var adm = dev('ADM-001', '行政工作', '', '行政部', 'misc', 'active', '行政/杂项');
    var inj = dev('PS41-17', '注塑机', 'PS41-17', '注塑部', 'prod', 'active', '注塑机');
    var grin = dev('PS04-70', '双面磨', 'PS04-70', '水磨组', 'prod', 'active', '磨削/抛光');
    var punch = dev('PS06-65', '16T冲床', 'PS06-65', '冲压组', 'prod', 'active', '冲床/精冲');
    var cnc = dev('PS00-72', '钻攻中心', 'PS00-72', '机加组', 'prod', 'active', '钻攻/钻孔');

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
                // 合并写入:别把 dept / must_change_pwd 这类字段写丢
                SessionStore.merge({
                    token: s.token, account: u.account, name: u.name,
                    level: u.level, tools: u.tools || [],
                    dept: u.dept || '', must_change_pwd: !!u.must_change_pwd
                });
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

    // 报修人入口:只返回本车间设备(状态级)+ 本车间通用报修卡
    myList: function () {
        if (EqConfig.cloud) {
            return eqRpc('equipment_my_list', { p_token: eqToken() }).then(function (r) {
                if (!r.ok) return { ok: false, msg: r.msg || '无权限' };
                return {
                    ok: true, role: r.data.role || 'reporter', dept: r.data.dept || '',
                    generic: r.data.generic || '', equipments: r.data.equipments || {}
                };
            });
        }
        var role = eqRole();
        if (role !== 'reporter') return Promise.resolve({ ok: false, msg: '无权限' });
        var u = eqUser() || {};
        var dept = String(u.dept || '').trim();
        if (!dept) return Promise.resolve({ ok: false, msg: '账号未设置车间,请联系管理员' });
        seedLocal();
        var gen = ensureGenericLocal(dept);
        var all = localGet(), out = {};
        for (var c in all) {
            if (String(all[c].line || '').trim() !== dept) continue;
            out[c] = maskForReport(all[c]);
        }
        return Promise.resolve({ ok: true, role: role, dept: dept, generic: gen, equipments: out });
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
        payload = payload || {};
        var place = String(payload.place || '').trim();
        if (!place) return Promise.resolve({ ok: false, msg: '请填写设备位置' });
        if (EqConfig.cloud) {
            return eqRpc('equipment_report', {
                p_token: eqToken(), p_code: code,
                p_symptom: payload.symptom, p_expected: payload.expectedAt,
                p_reportby: payload.reportBy || '', p_place: place
            });
        }
        var role = eqRole();
        if (role !== 'admin' && role !== 'repairer' && role !== 'reporter') return Promise.resolve({ ok: false, msg: '无报修权限' });
        var all = localGet();
        var d = all[code];
        if (!d) return Promise.resolve({ ok: false, msg: '设备不存在' });
        // 硬规则:报修人只能报本车间的设备(管理员/维修人不限)
        if (role === 'reporter') {
            var myDept = String((eqUser() || {}).dept || '').trim();
            if (!myDept) return Promise.resolve({ ok: false, msg: '账号未设置车间,请联系管理员' });
            if (String(d.line || '').trim() !== myDept) {
                return Promise.resolve({ ok: false, msg: '只能报修本车间(' + myDept + ')的设备' });
            }
        }
        var u = eqUser() || {};
        d.records = d.records || [];
        var wo = localNextNo(all);
        d.records.push({
            id: 'r' + Date.now(), no: wo, type: 'fault', status: 'open',
            reportAt: new Date().toISOString().slice(0, 10), reportBy: payload.reportBy || u.name || '',
            place: place,
            expectedAt: '', doneAt: '', handler: '', symptom: payload.symptom || '',
            cause1: '', cause2: '', cause3: '', cause: '', action: '', handleType: '', repairMode: 'inner', supplier: '',
            parts: [], cost: 0, delayReason: '', remark: '', photos: [],
            createdAt: new Date().toLocaleString('zh-CN'), createdBy: u.name || ''
        });
        if (d._recordsRev != null) d._recordsRev = nextRecordsRev();
        localSet(all);
        localPushAudit(code, 'report', '报修:' + (payload.symptom || '').slice(0, 30));
        return Promise.resolve({ ok: true, no: wo });
    },

    // 补充报修说明:只追加历史、不新建工单;云端成功后发送独立报修补充通知。
    supplementReport: function (code, recordId, text) {
        var trimmed = typeof text === 'string' ? text.trim() : '';
        if (!trimmed) return Promise.resolve({ ok: false, msg: '请填写补充说明' });
        if (Array.from(trimmed).length > 2000) return Promise.resolve({ ok: false, msg: '补充说明最多2000字' });
        if (EqConfig.cloud) {
            return eqRpc('equipment_report_supplement', {
                p_token: eqToken(), p_code: code, p_record_id: recordId, p_text: trimmed
            });
        }
        var role = eqRole();
        if (role !== 'admin' && role !== 'reporter') return Promise.resolve({ ok: false, msg: '无报修补充权限' });
        var all = localGet();
        var source = Object.prototype.hasOwnProperty.call(all, code) ? all[code] : null;
        if (!source) return Promise.resolve({ ok: false, msg: '设备不存在' });
        if (!Array.isArray(source.records)) return Promise.resolve({ ok: false, msg: '设备工单数据异常,请刷新后重试' });
        var u = eqUser() || {};
        if (role === 'reporter') {
            var dept = String(u.dept || '').trim();
            if (!dept) return Promise.resolve({ ok: false, msg: '账号未设置车间,请联系管理员' });
            if (source.line !== dept) return Promise.resolve({ ok: false, msg: '只能补充本车间(' + dept + ')的工单' });
        }
        var id = String(recordId == null ? '' : recordId), index = -1, count = 0;
        source.records.forEach(function (r, i) {
            if (r && String(r.id == null ? '' : r.id) === id) { index = i; count++; }
        });
        if (!id.trim() || !count) return Promise.resolve({ ok: false, msg: '工单不存在' });
        if (count !== 1) return Promise.resolve({ ok: false, msg: '设备存在重复工单ID,无法补充' });
        var rec = source.records[index];
        if (role === 'reporter' && (rec.status === 'done' || (rec.doneAt != null && rec.doneAt !== ''))) {
            return Promise.resolve({ ok: false, msg: '该工单已完成,请联系设备管理员补充' });
        }
        if (Object.prototype.hasOwnProperty.call(rec, '_supplements') && !Array.isArray(rec._supplements)) {
            return Promise.resolve({ ok: false, msg: '工单补充说明数据异常,无法追加' });
        }
        var entry = { at: nowStamp(), account: u.account, by: u.name || u.account, text: trimmed };
        if (!Object.prototype.hasOwnProperty.call(rec, '_supplements')) rec._supplements = [];
        rec._supplements.push(entry);
        rec.updatedAt = entry.at;
        rec.updatedBy = entry.by;
        source._recordsRev = nextRecordsRev();
        localSet(all);
        localPushAudit(code, 'supplement', '补充说明 ' + (rec.no || id) + '：' + trimmed.slice(0, 30));
        return Promise.resolve({ ok: true, code: code, no: rec.no || '', equipment: role === 'reporter' ? maskForReport(source) : source });
    },

    // 更正单条完整工单,不走整包保存/回收站,也不重建工单号。
    correctReport: function (code, recordId, payload) {
        payload = payload || {};
        if (EqConfig.cloud) {
            return eqRpc('equipment_report_correct', {
                p_token: eqToken(), p_code: code, p_record_id: recordId,
                p_target_code: payload.targetCode, p_symptom: payload.symptom,
                p_place: payload.place, p_reason: payload.reason || '', p_expected: payload.expected
            });
        }
        var role = eqRole();
        if (role !== 'admin' && role !== 'reporter') return Promise.resolve({ ok: false, msg: '无报修更正权限' });
        var symptom = String(payload.symptom == null ? '' : payload.symptom).trim();
        var place = String(payload.place == null ? '' : payload.place).trim();
        var reason = String(payload.reason == null ? '' : payload.reason).trim();
        if (!symptom) return Promise.resolve({ ok: false, msg: '请填写故障现象' });
        if (!place) return Promise.resolve({ ok: false, msg: '请填写设备位置' });
        var expected = payload.expected;
        if (!expected || typeof expected !== 'object' || Array.isArray(expected)
            || !Object.prototype.hasOwnProperty.call(expected, 'symptom')
            || !Object.prototype.hasOwnProperty.call(expected, 'place')
            || typeof expected.symptom !== 'string' || typeof expected.place !== 'string') {
            return Promise.resolve({ ok: false, msg: '请刷新后重试,缺少原始报修信息' });
        }
        var all = localGet();
        var targetCode = String(payload.targetCode == null ? '' : payload.targetCode).trim();
        var source = Object.prototype.hasOwnProperty.call(all, code) ? all[code] : null;
        var target = Object.prototype.hasOwnProperty.call(all, targetCode) ? all[targetCode] : null;
        if (!source || !target) return Promise.resolve({ ok: false, msg: '设备不存在' });
        var u = eqUser() || {};
        if (role === 'reporter') {
            var dept = String(u.dept || '').trim();
            if (!dept) return Promise.resolve({ ok: false, msg: '账号未设置车间,请联系管理员' });
            if (String(source.line || '') !== dept || String(target.line || '') !== dept) {
                return Promise.resolve({ ok: false, msg: '只能更正本车间(' + dept + ')的工单,源和目标设备均须属于本车间' });
            }
        }
        var sourceRecords = source.records || [], targetRecords = target.records || [];
        if (!Array.isArray(sourceRecords) || !Array.isArray(targetRecords)) return Promise.resolve({ ok: false, msg: '设备工单数据异常,请刷新后重试' });
        var id = String(recordId == null ? '' : recordId), index = -1, count = 0;
        sourceRecords.forEach(function (r, i) {
            if (r && String(r.id == null ? '' : r.id) === id) { index = i; count++; }
        });
        if (!id.trim() || !count) return Promise.resolve({ ok: false, msg: '工单不存在' });
        if (count !== 1) return Promise.resolve({ ok: false, msg: '源设备存在重复工单ID,无法更正' });
        var rec = sourceRecords[index];
        if (role === 'reporter' && (rec.status === 'done' || String(rec.doneAt == null ? '' : rec.doneAt) !== '')) {
            return Promise.resolve({ ok: false, msg: '该工单已完成,请联系设备管理员更正' });
        }
        var oldSymptom = String(rec.symptom == null ? '' : rec.symptom);
        var oldPlace = String(rec.place == null ? '' : rec.place);
        if (String(expected.symptom == null ? '' : expected.symptom) !== oldSymptom
            || String(expected.place == null ? '' : expected.place) !== oldPlace) {
            return Promise.resolve({ ok: false, msg: '报修信息已更新,请刷新后重试' });
        }
        var moved = String(code) !== targetCode;
        var no = String(rec.no == null ? '' : rec.no);
        var conflict = targetRecords.some(function (r, i) {
            if (!r || (!moved && i === index)) return false;
            return String(r.id == null ? '' : r.id) === id
                || (no.trim() !== '' && String(r.no == null ? '' : r.no) === no);
        });
        if (conflict) return Promise.resolve({ ok: false, msg: '目标设备已存在相同工单ID或工单号,无法更正' });
        if (!moved && symptom === oldSymptom && place === oldPlace) {
            return Promise.resolve({ ok: false, msg: '没有需要保存的更正' });
        }
        var summary = '更正报修 ' + (rec.no || id) + '：' + (moved ? code + ' → ' + targetCode : '原设备 ' + code);
        if (symptom !== oldSymptom) summary += '；修改现象';
        if (place !== oldPlace) summary += '；修改位置';
        var correction = {
            at: nowStamp(), account: u.account || '', by: u.name || u.account || '',
            fromCode: code, fromName: source.name || '', fromDept: source.line || '',
            toCode: targetCode, toName: target.name || '', toDept: target.line || '',
            fromFamily: source.family || '', fromRecordName: rec.devName || '', fromRecordFamily: rec.family || '',
            oldSymptom: oldSymptom, oldPlace: oldPlace, newSymptom: symptom, newPlace: place,
            reason: reason, summary: summary
        };
        rec.symptom = symptom;
        rec.place = place;
        rec._corrections = Array.isArray(rec._corrections) ? rec._corrections : [];
        rec._corrections.push(correction);
        rec.updatedAt = correction.at;
        rec.updatedBy = correction.by;
        if (moved) {
            sourceRecords.splice(index, 1);
            targetRecords.push(rec);
            target.records = targetRecords;
            // 通用卡仍保留原物件提示;转至具体设备才刷新已有快照字段。
            if (targetCode.indexOf('GEN-') !== 0) {
                if (Object.prototype.hasOwnProperty.call(rec, 'devName')) rec.devName = target.name || '';
                if (Object.prototype.hasOwnProperty.call(rec, 'family')) rec.family = target.family || '';
            }
        }
        source._recordsRev = nextRecordsRev();
        if (moved) target._recordsRev = nextRecordsRev();
        localSet(all);
        var auditSummary = summary + (reason ? '；原因：' + reason : '');
        localPushAudit(code, 'correct', auditSummary);
        if (moved) localPushAudit(targetCode, 'correct', auditSummary);
        var equipments = Object.create(null);
        equipments[code] = role === 'reporter' ? maskForReport(source) : source;
        if (moved) equipments[targetCode] = role === 'reporter' ? maskForReport(target) : target;
        return Promise.resolve({
            ok: true, code: targetCode, source_code: code, no: rec.no || '', moved: moved,
            equipments: equipments
        });
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
        if (d._recordsRev != null) d._recordsRev = nextRecordsRev();
        localSet(all);
        localPushAudit(code, 'reply', '回应:' + upd.text.slice(0, 30));
        return Promise.resolve({ ok: true, update: upd });
    },

    // 保存设备(整包,仅 manage)
    save: function (code, data, summary) {
        if (EqConfig.cloud) {
            return eqRpc('equipment_save', { p_token: eqToken(), p_code: code, p_data: data, p_summary: summary || '' }).then(function (r) {
                if (r.ok && r.recordsRev != null) data._recordsRev = r.recordsRev;
                return r;
            });
        }
        var role = eqRole();
        if (role !== 'admin' && role !== 'repairer') return Promise.resolve({ ok: false, msg: '无设备履历编辑权限' });
        var all = localGet();
        var oldD = all[code], oldRev = oldD && oldD._recordsRev;
        if (oldRev != null && (!data || data._recordsRev !== oldRev)) {
            return Promise.resolve({ ok: false, msg: '设备履历已更新，请刷新后重试' });
        }
        if (role === 'repairer') {
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
        // 补充历史只允许专用接口追加;缺失按 [] 比较,显式 null 保留其 JSON 值。
        var oldRecords = (oldD && oldD.records) || [];
        var badSupplements = (data.records || []).some(function (r) {
            var matches = oldRecords.filter(function (o) {
                return String(o.id == null ? '' : o.id) === String(r.id == null ? '' : r.id);
            });
            var incoming = Object.prototype.hasOwnProperty.call(r, '_supplements') ? r._supplements : [];
            if (!matches.length) return !sameJsonValue(incoming, []);
            return matches.some(function (o) {
                var original = Object.prototype.hasOwnProperty.call(o, '_supplements') ? o._supplements : [];
                return !sameJsonValue(incoming, original);
            });
        });
        if (badSupplements) return Promise.resolve({ ok: false, msg: '补充说明只能通过补充接口追加,不能修改或删除' });
        // 回收站:这次少传的工单 = 被删掉的,逐个存快照(与 SQL 钩子同规则)
        var prev = all[code];
        if (prev) {
            var keepIds = {};
            (data.records || []).forEach(function (r) { keepIds[r.id] = 1; });
            (prev.records || []).forEach(function (r) {
                if (keepIds[r.id]) return;
                localTrashPush('record', code,
                    String(r.no || '工单') + ' · ' + String(r.symptom || '').slice(0, 40), r);
            });
        }
        if (oldRev != null) data._recordsRev = nextRecordsRev(); else delete data._recordsRev;
        all[code] = data;
        localSet(all);
        localPushAudit(code, 'save', summary || '');
        return Promise.resolve(oldRev != null ? { ok: true, recordsRev: data._recordsRev } : { ok: true });
    },

    remove: function (code) {
        if (EqConfig.cloud) return eqRpc('equipment_delete', { p_token: eqToken(), p_code: code });
        if (eqRole() !== 'admin') return Promise.resolve({ ok: false, msg: '仅设备管理员可删除设备' });
        var all = localGet();
        // 回收站:删前存快照(工单随设备一起进快照,不单独再存)
        if (all[code]) localTrashPush('equipment', code, all[code].name || code, all[code]);
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

    // ---------- 设备类别顺序(置顶 + 拖拽排序;分部门) ----------
    // 一次取回全部:{ '':全部部门那套, '冲压组':冲压组那套, ... },每套都是 [{n,pin},...]
    // 返回 { ok, data: { '':[{n:'冲床/精冲',pin:true},...], '冲压组':[...] } }
    groupOrderGet: function () {
        if (EqConfig.cloud) {
            return eqRpc('equip_group_order_get', { p_token: eqToken() }).then(function (r) {
                if (!r.ok) return r;
                return { ok: true, data: gorderNorm(r.data) };
            });
        }
        var d2 = {};
        try { d2 = JSON.parse(lsGet('eq_group_order') || '{}') || {}; } catch (e) { d2 = {}; }
        return Promise.resolve({ ok: true, data: gorderNorm(d2) });
    },
    // obj 是整张表(会把没出现在 obj 里的部门那套删掉)
    groupOrderSet: function (obj) {
        obj = gorderNorm(obj);
        if (EqConfig.cloud) return eqRpc('equip_group_order_set', { p_token: eqToken(), p_data: obj });
        if (eqRole() !== 'admin') return Promise.resolve({ ok: false, msg: '仅设备管理员可调整类别顺序' });
        lsSet('eq_group_order', JSON.stringify(obj));
        return Promise.resolve({ ok: true, n: Object.keys(obj).length });
    },

    // 类别改名:该类别下所有设备的 family 一起改
    // 改成已存在的类别名 = 合并两类,返回 merged=true 与那类原有台数
    // 返回 { ok, n:改了多少台, merged, merged_n }
    catRename: function (oldName, newName) {
        var o = String(oldName == null ? '' : oldName).trim();
        var n = String(newName == null ? '' : newName).trim();
        if (EqConfig.cloud) {
            return eqRpc('equip_cat_rename', { p_token: eqToken(), p_old: o, p_new: n });
        }
        if (eqRole() !== 'admin') return Promise.resolve({ ok: false, msg: '仅设备管理员可改类别名' });
        if (!o) return Promise.resolve({ ok: false, msg: '原类别名不能为空' });
        if (!n) return Promise.resolve({ ok: false, msg: '新类别名不能为空' });
        if (o === n) return Promise.resolve({ ok: false, msg: '新旧类别名相同' });
        seedLocal();
        var all = localGet(), hit = 0, changed = 0, c, e;
        for (c in all) {
            e = all[c] || {};
            if (String(e.family || '').trim() === n) hit++;
        }
        for (c in all) {
            e = all[c];
            if (!e || String(e.family || '').trim() !== o) continue;
            e.family = n;
            localPushAudit(c, 'save', '设备类别改名:' + o + ' → ' + n);
            changed++;
        }
        if (changed) localSet(all);
        // 排序配置里所有部门的旧名一起改,同名项合并去重
        var g = {};
        try { g = gorderNorm(JSON.parse(lsGet('eq_group_order') || '{}') || {}); } catch (x) { g = {}; }
        var out = {}, k, arr, seen, list, i, nm, it;
        for (k in g) {
            if (!Object.prototype.hasOwnProperty.call(g, k)) continue;
            arr = g[k]; seen = {}; list = [];
            for (i = 0; i < arr.length; i++) {
                it = arr[i] || {};
                nm = String(it.n || '').trim();
                if (!nm) continue;
                if (nm === o) nm = n;
                if (seen[nm] == null) { seen[nm] = !!it.pin; list.push(nm); }
                else if (it.pin) seen[nm] = true;
            }
            if (list.length) {
                out[k] = [];
                for (i = 0; i < list.length; i++) out[k].push({ n: list[i], pin: !!seen[list[i]] });
            }
        }
        lsSet('eq_group_order', JSON.stringify(out));
        return Promise.resolve({ ok: true, n: changed, merged: hit > 0, merged_n: hit });
    },

    // 今日待办:测试发送一条(带【测试】标记)到群;本地模式只生成预览不真发
    dailyTodoTest: function () {
        if (EqConfig.cloud) {
            return eqRpc('equip_daily_test', { p_token: eqToken() }).then(function (r) {
                if (!r.ok) return r;
                return { ok: true, preview: r.preview || '', total: r.total || 0 };
            });
        }
        if (eqRole() !== 'admin') return Promise.resolve({ ok: false, msg: '仅设备管理员可测试' });
        seedLocal();
        var r = buildTodoMsg(localGet(), { test: true, base: 'https://kekits.com/equipment/' });
        return Promise.resolve({ ok: true, preview: r.msg, total: r.total, local: true });
    },

    auditList: function (code) {
        if (EqConfig.cloud) {
            return eqRpc('equipment_audit_list', { p_token: eqToken(), p_code: code }).then(function (r) {
                return r.ok ? { ok: true, logs: (r.data && r.data.logs) || [] } : r;
            });
        }
        var a = localAudit().filter(function (x) { return x.code === code; });
        return Promise.resolve({ ok: true, logs: a });
    },

    // ---------- 回收站(设备 / 工单;仅设备管理员) ----------
    trashList: function () {
        if (EqConfig.cloud) {
            return eqRpc('equip_trash_list', { p_token: eqToken() }).then(function (r) {
                return r.ok ? { ok: true, items: r.items || [] } : r;
            });
        }
        if (eqRole() !== 'admin') return Promise.resolve({ ok: false, msg: '仅设备管理员可查看回收站' });
        var a = localTrashSweep().filter(function (x) { return x.kind === 'equipment' || x.kind === 'record'; });
        return Promise.resolve({
            ok: true, items: a.map(function (x) {
                return {
                    id: x.id, kind: x.kind, ref_key: x.ref_key, label: x.label, deleted_at: x.deleted_at,
                    deleted_by_name: x.deleted_by_name, days_left: localTrashDaysLeft(x), snapshot: x.snapshot
                };
            })
        });
    },
    // mode: 'skip'(默认,已存在就跳过) / 'overwrite'(用回收站里的版本覆盖)
    trashRestore: function (id, mode) {
        mode = (mode === 'overwrite') ? 'overwrite' : 'skip';
        if (EqConfig.cloud) {
            return eqRpc('equip_trash_restore', { p_token: eqToken(), p_id: id, p_mode: mode });
        }
        if (eqRole() !== 'admin') return Promise.resolve({ ok: false, msg: '仅设备管理员可恢复' });
        var a = localTrashSweep(), it = null;
        for (var i = 0; i < a.length; i++) if (String(a[i].id) === String(id)) { it = a[i]; break; }
        if (!it) return Promise.resolve({ ok: false, msg: '回收站里没有这条' });
        var all = localGet();
        var restored = it.kind === 'record' ? [it.snapshot || {}] : ((it.snapshot || {}).records || []);
        if ((it.kind === 'record' || it.kind === 'equipment') && Object.keys(all).some(function (code) {
            return code !== it.ref_key && (all[code].records || []).some(function (live) {
                return restored.some(function (snap) {
                    return (snap.id != null && String(snap.id) !== '' && String(live.id) === String(snap.id))
                        || (snap.no != null && String(snap.no) !== '' && String(live.no) === String(snap.no));
                });
            });
        })) return Promise.resolve({ ok: false, msg: '工单已存在于其他设备，未恢复，请先核对归属' });
        if (it.kind === 'equipment') {
            if (all[it.ref_key] && mode !== 'overwrite') {
                return Promise.resolve({ ok: false, msg: '设备 ' + it.ref_key + ' 已存在,已跳过' });
            }
            all[it.ref_key] = it.snapshot;
            all[it.ref_key]._recordsRev = nextRecordsRev();
            localSet(all);
            localPushAudit(it.ref_key, 'restore', '从回收站恢复设备' + (mode === 'overwrite' ? '(覆盖)' : ''));
        } else if (it.kind === 'record') {
            var dev = all[it.ref_key];
            if (!dev) return Promise.resolve({ ok: false, msg: '请先恢复设备 ' + it.ref_key });
            var rid = (it.snapshot || {}).id || '';
            var idx = -1;
            dev.records = dev.records || [];
            for (var j = 0; j < dev.records.length; j++) if (dev.records[j].id === rid) { idx = j; break; }
            if (idx >= 0 && mode !== 'overwrite') {
                return Promise.resolve({ ok: false, msg: '该工单已存在,已跳过' });
            }
            if (idx >= 0) dev.records[idx] = it.snapshot; else dev.records.push(it.snapshot);
            if (dev._recordsRev != null) dev._recordsRev = nextRecordsRev();
            localSet(all);
            localPushAudit(it.ref_key, 'restore', '从回收站恢复工单 ' + ((it.snapshot || {}).no || ''));
        } else {
            return Promise.resolve({ ok: false, msg: '这条不属于设备回收站' });
        }
        localTrashSet(localTrash().filter(function (x) { return String(x.id) !== String(id); }));
        return Promise.resolve({ ok: true });
    },
    // id 为空 = 清空
    trashPurge: function (id) {
        if (EqConfig.cloud) {
            return eqRpc('equip_trash_purge', { p_token: eqToken(), p_id: (id == null || id === '') ? null : id });
        }
        if (eqRole() !== 'admin') return Promise.resolve({ ok: false, msg: '仅设备管理员可清理回收站' });
        var a = localTrash(), before = a.length;
        a = a.filter(function (x) {
            if (x.kind !== 'equipment' && x.kind !== 'record') return true;
            if (id == null || id === '') return false;
            return String(x.id) !== String(id);
        });
        localTrashSet(a);
        return Promise.resolve({ ok: true, n: before - a.length });
    }
};
