/**
 * ROI 计算器 - 数据适配层(本地演示 / Supabase 云端)
 * 用法:页面 <script src="./js/supabase.js"></script><script src="./js/app-api.js"></script>
 * 云端模式:AppConfig.cloud=true(URL 加 ?cloud=1 可临时开启),数据走 Supabase RPC 函数
 * 本地模式:数据存 localStorage/sessionStorage(与云端同接口,返回 Promise)
 */
var AppConfig = {
    cloud: true,                           // 【feature-equipment 分支试用版】本地沙箱;合并上线前改回 true
    supabaseUrl: 'https://frfsvgiykcytiemvallk.supabase.co',
    supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZyZnN2Z2l5a2N5dGllbXZhbGxrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyMTU4ODEsImV4cCI6MjEwMjc5MTg4MX0.ri51WLF_w-WgR4c1xcCKFa8GmueSsujmAgOZDt79Gjk'
};
(function () {
    if (location.search.indexOf('cloud=1') > -1) AppConfig.cloud = true;
})();

// ---------- Supabase 客户端与 RPC ----------
var _sb = null;
function getSb() {
    if (!_sb && window.supabase && AppConfig.supabaseUrl && AppConfig.supabaseKey) {
        _sb = window.supabase.createClient(AppConfig.supabaseUrl, AppConfig.supabaseKey);
    }
    return _sb;
}
function rpcCall(fn, params) {
    var sb = getSb();
    if (!sb) return Promise.resolve({ ok: false, msg: 'Supabase SDK 未加载' });
    return sb.rpc(fn, params || {}).then(function (res) {
        if (res.error) return { ok: false, msg: res.error.message || '请求失败' };
        return res.data;
    }).catch(function (e) { return { ok: false, msg: e.message || '网络错误' }; });
}
function getSessionToken() {
    try {
        var d = SessionStore.raw();
        var s = d ? JSON.parse(d) : null;
        return s && s.token ? s.token : '';
    } catch (e) { return ''; }
}

// ---------- 本地实现 ----------
function localGetUsers() {
    try { var d = localStorage.getItem('roi_users'); return d ? JSON.parse(d) : {}; } catch (e) { return {}; }
}
function localSetUsers(u) { try { localStorage.setItem('roi_users', JSON.stringify(u)); } catch (e) {} }
function localHash(pwd) {
    var h = 5381;
    for (var i = 0; i < pwd.length; i++) { h = ((h << 5) + h + pwd.charCodeAt(i)) & 0x7fffffff; }
    return 'h' + h.toString(36) + '_' + pwd.length;
}
function localEnsureAdmin() {
    var u = localGetUsers();
    if (!u.admin) {
        u.admin = { account: 'admin', name: '管理员', pwd: localHash('admin123'), level: 1, status: 'active', invite: '', regTime: new Date().toLocaleString('zh-CN') };
        localSetUsers(u);
    }
    return u;
}
function localProjects() {
    try { var d = localStorage.getItem('roi_calculator_projects'); return d ? JSON.parse(d) : {}; } catch (e) { return {}; }
}
function localSetProjects(p) { try { localStorage.setItem('roi_calculator_projects', JSON.stringify(p)); } catch (e) {} }

// ---------- 回收站(本地模式;云端走 project_trash_* RPC) ----------
var ROI_TRASH_KEY = 'roi_trash_v1';
var ROI_TRASH_KEEP_DAYS = 30;
function _rtPad(n) { return String(n).length < 2 ? ('0' + n) : String(n); }
function _rtStamp(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + _rtPad(d.getMonth() + 1) + '-' + _rtPad(d.getDate()) + ' '
        + _rtPad(d.getHours()) + ':' + _rtPad(d.getMinutes()) + ':' + _rtPad(d.getSeconds());
}
function localTrashItems() {
    try {
        var a = JSON.parse(localStorage.getItem(ROI_TRASH_KEY) || '[]');
        var now = _rtStamp();
        return (a || []).filter(function (x) { return !x.purge_at || x.purge_at >= now; });
    } catch (e) { return []; }
}
function localTrashSet(a) { try { localStorage.setItem(ROI_TRASH_KEY, JSON.stringify((a || []).slice(0, 500))); } catch (e) {} }
function localTrashPushProject(name, project) {
    var cur = null;
    try { var s = SessionStore.raw(); cur = s ? JSON.parse(s) : null; } catch (e) { cur = null; }
    var now = new Date();
    var a = localTrashItems();
    a.unshift({
        id: now.getTime() + Math.floor(Math.random() * 1000),
        kind: 'project', ref_key: name, label: name, snapshot: project,
        deleted_at: _rtStamp(now), deleted_by: (cur && cur.account) || '',
        deleted_by_name: (cur && cur.name) || (cur && cur.account) || '',
        purge_at: _rtStamp(new Date(now.getTime() + ROI_TRASH_KEEP_DAYS * 86400000))
    });
    localTrashSet(a);
}
function _rtDaysLeft(it) {
    var p = String(it.purge_at || '').slice(0, 10);
    if (!p) return ROI_TRASH_KEEP_DAYS;
    var d = Math.round((new Date(p + 'T00:00:00') - new Date(new Date().toDateString())) / 86400000);
    return d > 0 ? d : 0;
}
function localTrashRestore(id, mode) {
    mode = (mode === 'overwrite') ? 'overwrite' : 'skip';
    var a = localTrashItems(), it = null;
    for (var i = 0; i < a.length; i++) if (String(a[i].id) === String(id)) { it = a[i]; break; }
    if (!it) return Promise.resolve({ ok: false, msg: '回收站里没有这条' });
    var p = localProjects();
    var nm = (it.snapshot && it.snapshot.name) || it.ref_key;
    if (p[nm] && mode !== 'overwrite') return Promise.resolve({ ok: false, msg: '项目「' + nm + '」已存在,已跳过' });
    p[nm] = it.snapshot;
    localSetProjects(p);
    localTrashSet(localTrashItems().filter(function (x) { return String(x.id) !== String(id); }));
    return Promise.resolve({ ok: true });
}
function localTrashPurge(id) {
    var a = localTrashItems(), before = a.length;
    a = a.filter(function (x) {
        if (id == null || id === '') return false;
        return String(x.id) !== String(id);
    });
    localTrashSet(a);
    return Promise.resolve({ ok: true, n: before - a.length });
}

var AppApi = {
    // 当前会话 token(云端模式用;本地模式为 'local' 或空)
    token: function () { return getSessionToken(); },
    // ---------- 认证 ----------
    login: function (account, pwd) {
        if (AppConfig.cloud) return rpcCall('login', { p_account: account, p_pwd: pwd });
        return new Promise(function (resolve) {
            localEnsureAdmin();
            var users = localGetUsers(), u = users[account];
            if (!u) return resolve({ ok: false, msg: '账号不存在' });
            if (u.status === 'pending') return resolve({ ok: false, msg: '账号待管理员审核,请稍后' });
            if (u.status === 'disabled') return resolve({ ok: false, msg: '账号已停用,请联系管理员' });
            if (u.pwd !== localHash(pwd)) return resolve({ ok: false, msg: '密码错误' });
            resolve({ ok: true, data: { token: 'local', user: {
                account: u.account, name: u.name, level: u.level,
                tools: u.tools || null, dept: u.dept || '',
                must_change_pwd: !!u.mustChangePwd } } });
        });
    },
    register: function (name, account, pwd, invite) {
        if (AppConfig.cloud) return rpcCall('register', { p_name: name, p_account: account, p_pwd: pwd, p_invite: invite });
        return new Promise(function (resolve) {
            localEnsureAdmin();
            if (!name || !account || !pwd) return resolve({ ok: false, msg: '请填写姓名、账号、密码' });
            if (String(pwd).length < 6) return resolve({ ok: false, msg: '密码至少 6 位' });
            if (invite !== 'ROI2026') return resolve({ ok: false, msg: '邀请码不正确' });
            var users = localGetUsers();
            if (users[account]) return resolve({ ok: false, msg: '该账号已存在' });
            users[account] = { account: account, name: name, pwd: localHash(pwd), level: 2, status: 'pending', invite: invite, regTime: new Date().toLocaleString('zh-CN') };
            localSetUsers(users);
            resolve({ ok: true, data: { msg: '申请已提交,等待管理员审核' } });
        });
    },
    me: function (token) {
        if (AppConfig.cloud) return rpcCall('me', { p_token: token });
        return new Promise(function (resolve) {
            try {
                var d = SessionStore.raw();
                var s = d ? JSON.parse(d) : null;
                if (s && s.account) resolve({ ok: true, data: { user: {
                    account: s.account, name: s.name, level: s.level,
                    tools: s.tools || null, dept: s.dept || '',
                    must_change_pwd: !!s.must_change_pwd } } });
                else resolve({ ok: false, msg: '未登录' });
            } catch (e) { resolve({ ok: false, msg: '未登录' }); }
        });
    },
    logout: function (token) {
        if (AppConfig.cloud) return rpcCall('logout', { p_token: token });
        return Promise.resolve({ ok: true });
    },

    // ---------- 账号管理 ----------
    adminUsers: function (token) {
        if (AppConfig.cloud) return rpcCall('admin_users', { p_token: token });
        return new Promise(function (resolve) {
            var users = localGetUsers(), list = {};
            for (var k in users) {
                var u = users[k];
                list[k] = { account: u.account, name: u.name, level: u.level, status: u.status, regTime: u.regTime, tools: u.tools || null, dept: u.dept || '', must_change_pwd: !!u.mustChangePwd };
            }
            resolve({ ok: true, data: { users: list } });
        });
    },
    adminAudit: function (token, account, level) {
        if (AppConfig.cloud) return rpcCall('admin_audit', { p_token: token, p_account: account, p_level: level });
        return new Promise(function (resolve) {
            var users = localGetUsers();
            if (users[account]) { users[account].status = 'active'; users[account].level = (level === 1 ? 1 : 2); }
            localSetUsers(users);
            resolve({ ok: true });
        });
    },
    adminReject: function (token, account) {
        if (AppConfig.cloud) return rpcCall('admin_reject', { p_token: token, p_account: account });
        return new Promise(function (resolve) {
            var users = localGetUsers();
            delete users[account];
            localSetUsers(users);
            resolve({ ok: true });
        });
    },
    adminLevel: function (token, account, level) {
        if (AppConfig.cloud) return rpcCall('admin_level', { p_token: token, p_account: account, p_level: level });
        return new Promise(function (resolve) {
            var users = localGetUsers();
            if (users[account]) users[account].level = (level === 1 ? 1 : 2);
            localSetUsers(users);
            resolve({ ok: true });
        });
    },
    adminToggle: function (token, account) {
        if (AppConfig.cloud) return rpcCall('admin_toggle', { p_token: token, p_account: account });
        return new Promise(function (resolve) {
            var users = localGetUsers();
            if (users[account]) users[account].status = users[account].status === 'active' ? 'disabled' : 'active';
            localSetUsers(users);
            resolve({ ok: true });
        });
    },
    adminResetpwd: function (token, account, newpwd) {
        if (AppConfig.cloud) return rpcCall('admin_resetpwd', { p_token: token, p_account: account, p_newpwd: newpwd });
        return new Promise(function (resolve) {
            var users = localGetUsers();
            if (users[account]) { users[account].pwd = localHash(newpwd); users[account].mustChangePwd = true; }
            localSetUsers(users);
            resolve({ ok: true });
        });
    },
    // 自助改密(任意登录用户):首登强制改密走这里
    changePwd: function (token, oldPwd, newPwd) {
        if (AppConfig.cloud) return rpcCall('change_pwd', { p_token: token, p_old: oldPwd, p_new: newPwd });
        return new Promise(function (resolve) {
            var s = null;
            try { s = JSON.parse(SessionStore.raw() || 'null'); } catch (e) { }
            var users = localGetUsers();
            var u = s && users[s.account];
            if (!u) return resolve({ ok: false, msg: '未登录' });
            if (u.pwd !== localHash(oldPwd || '')) return resolve({ ok: false, msg: '原密码不正确' });
            if (!newPwd || String(newPwd).length < 6) return resolve({ ok: false, msg: '新密码至少 6 位' });
            if (newPwd === oldPwd) return resolve({ ok: false, msg: '新密码不能与原密码相同' });
            u.pwd = localHash(newPwd);
            u.mustChangePwd = false;
            localSetUsers(users);
            resolve({ ok: true });
        });
    },
    // 管理员建号(仅1级):账号/姓名/初始密码/等级/工具/车间
    adminCreateUser: function (token, account, name, pwd, level, tools, dept) {
        if (AppConfig.cloud) return rpcCall('admin_create_user', {
            p_token: token, p_account: account, p_name: name, p_pwd: pwd,
            p_level: level, p_tools: tools, p_dept: dept
        });
        return new Promise(function (resolve) {
            account = String(account || '').trim();
            name = String(name || '').trim();
            if (!account || !name) return resolve({ ok: false, msg: '请填写账号与姓名' });
            if (!pwd || String(pwd).length < 6) return resolve({ ok: false, msg: '初始密码至少 6 位' });
            var users = localGetUsers();
            if (users[account]) return resolve({ ok: false, msg: '该账号已存在' });
            users[account] = {
                account: account, name: name, pwd: localHash(pwd),
                level: (level === 1 ? 1 : 2), status: 'active',
                tools: tools || ['roi'], dept: String(dept || '').trim(),
                mustChangePwd: true, invite: '', regTime: new Date().toLocaleString('zh-CN')
            };
            localSetUsers(users);
            resolve({ ok: true });
        });
    },
    // 设置账号车间(仅1级)
    adminSetDept: function (token, account, dept) {
        if (AppConfig.cloud) return rpcCall('admin_set_dept', { p_token: token, p_account: account, p_dept: dept });
        return new Promise(function (resolve) {
            var users = localGetUsers();
            if (!users[account]) return resolve({ ok: false, msg: '账号不存在' });
            users[account].dept = String(dept || '').trim();
            localSetUsers(users);
            resolve({ ok: true });
        });
    },
    // 修改账号(姓名/登录账号;仅1级)
    adminUpdate: function (token, account, newAccount, newName) {
        if (AppConfig.cloud) return rpcCall('admin_update_user', { p_token: token, p_account: account, p_new_account: newAccount, p_new_name: newName });
        return new Promise(function (resolve) {
            var users = localGetUsers();
            var u = users[account];
            if (!u) return resolve({ ok: false, msg: '账号不存在' });
            var na = (newAccount || '').trim() || account;
            var nn = (newName || '').trim() || u.name;
            if (na !== account && users[na]) return resolve({ ok: false, msg: '新账号已被占用' });
            delete users[account];
            u.account = na; u.name = nn;
            users[na] = u;
            localSetUsers(users);
            resolve({ ok: true });
        });
    },
    // 删除账号(仅1级;不可删自己与内置admin)
    adminDelete: function (token, account) {
        if (AppConfig.cloud) return rpcCall('admin_delete_user', { p_token: token, p_account: account });
        return new Promise(function (resolve) {
            try {
                var s = SessionStore.raw();
                var cur = s ? JSON.parse(s) : null;
                if (cur && cur.account === account) return resolve({ ok: false, msg: '不能删除自己的账号' });
            } catch (e) {}
            if (account === 'admin') return resolve({ ok: false, msg: '不能删除内置管理员账号' });
            var users = localGetUsers();
            if (!users[account]) return resolve({ ok: false, msg: '账号不存在' });
            delete users[account];
            localSetUsers(users);
            resolve({ ok: true });
        });
    },

    // 授予/取消工具权限(p_tools: jsonb 数组,如 ["roi","equipment"])
    adminSetTools: function (token, account, tools) {
        if (AppConfig.cloud) return rpcCall('admin_set_tools', { p_token: token, p_account: account, p_tools: tools });
        return new Promise(function (resolve) {
            var users = localGetUsers();
            if (!users[account]) return resolve({ ok: false, msg: '账号不存在' });
            users[account].tools = tools;
            localSetUsers(users);
            resolve({ ok: true });
        });
    },

    // ---------- 备份 / 恢复(仅 1 级;服务端强校验) ----------
    adminBackup: function (token) {
        if (AppConfig.cloud) return rpcCall('admin_backup', { p_token: token });
        return Promise.resolve({ ok: false, msg: '仅云端模式支持备份' });
    },
    adminRestoreClear: function (token, confirmWord) {
        if (AppConfig.cloud) return rpcCall('admin_restore_clear', { p_token: token, p_confirm: confirmWord });
        return Promise.resolve({ ok: false, msg: '仅云端模式支持恢复' });
    },
    adminRestoreDevice: function (token, code, data, savedAt) {
        if (AppConfig.cloud) return rpcCall('admin_restore_device', { p_token: token, p_code: code, p_data: data, p_saved_at: savedAt || null });
        return Promise.resolve({ ok: false, msg: '仅云端模式支持恢复' });
    },
    adminRestoreUsers: function (token, users) {
        if (AppConfig.cloud) return rpcCall('admin_restore_users', { p_token: token, p_users: users });
        return Promise.resolve({ ok: false, msg: '仅云端模式支持恢复' });
    },
    adminRestoreMeta: function (token, meta) {
        if (AppConfig.cloud) return rpcCall('admin_restore_meta', { p_token: token, p_meta: meta });
        return Promise.resolve({ ok: false, msg: '仅云端模式支持恢复' });
    },

    // ---------- 项目 ----------
    projectsList: function (token) {
        if (AppConfig.cloud) return rpcCall('projects_list', { p_token: token });
        return new Promise(function (resolve) {
            resolve({ ok: true, data: { projects: localProjects() } });
        });
    },
    projectGet: function (token, name) {
        if (AppConfig.cloud) return rpcCall('project_get', { p_token: token, p_name: name });
        return new Promise(function (resolve) {
            var p = localProjects()[name];
            if (p) resolve({ ok: true, data: { project: p } });
            else resolve({ ok: false, msg: '项目不存在', code: 404 });
        });
    },
    projectSave: function (token, name, project) {
        if (AppConfig.cloud) return rpcCall('project_save', { p_token: token, p_name: name, p_project: project });
        return new Promise(function (resolve) {
            var p = localProjects();
            var exist = p[name];
            if (exist) {
                var owners = project.owners || [];
                var can = false;
                try {
                    var s = SessionStore.raw();
                    var cur = s ? JSON.parse(s) : null;
                    can = cur && (cur.level === 1 || owners.indexOf(cur.name) > -1);
                } catch (e) { can = false; }
                if (!can) return resolve({ ok: false, msg: '无权限修改该项目', code: 403 });
            }
            p[name] = Object.assign({}, project, { name: name, savedAt: new Date().toLocaleString('zh-CN') });
            localSetProjects(p);
            resolve({ ok: true });
        });
    },
    projectDelete: function (token, name) {
        if (AppConfig.cloud) return rpcCall('project_delete', { p_token: token, p_name: name });
        return new Promise(function (resolve) {
            var p = localProjects();
            if (!p[name]) return resolve({ ok: false, msg: '项目不存在', code: 404 });
            var owners = p[name].owners || [];
            var can = false;
            try {
                var s = SessionStore.raw();
                var cur = s ? JSON.parse(s) : null;
                can = cur && (cur.level === 1 || owners.indexOf(cur.name) > -1);
            } catch (e) { can = false; }
            if (!can) return resolve({ ok: false, msg: '无权限删除该项目', code: 403 });
            localTrashPushProject(name, p[name]);
            delete p[name];
            localSetProjects(p);
            resolve({ ok: true });
        });
    },

    // ---------- 回收站(项目;1 级看全部,2 级只看自己删的) ----------
    trashList: function (token) {
        if (AppConfig.cloud) {
            return rpcCall('project_trash_list', { p_token: token }).then(function (r) {
                return r.ok ? { ok: true, items: r.items || [] } : r;
            });
        }
        return new Promise(function (resolve) {
            resolve({
                ok: true, items: localTrashItems().map(function (x) {
                    return {
                        id: x.id, ref_key: x.ref_key, label: x.label, deleted_at: x.deleted_at,
                        deleted_by_name: x.deleted_by_name, days_left: _rtDaysLeft(x), snapshot: x.snapshot
                    };
                })
            });
        });
    },
    // mode: 'skip'(默认) / 'overwrite'
    trashRestore: function (token, id, mode) {
        mode = (mode === 'overwrite') ? 'overwrite' : 'skip';
        if (AppConfig.cloud) return rpcCall('project_trash_restore', { p_token: token, p_id: id, p_mode: mode });
        return localTrashRestore(id, mode);
    },
    trashPurge: function (token, id) {
        if (AppConfig.cloud) return rpcCall('project_trash_purge', { p_token: token, p_id: (id == null || id === '') ? null : id });
        return localTrashPurge(id);
    }
};
