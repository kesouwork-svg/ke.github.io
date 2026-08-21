/**
 * ROI 计算器 - 数据适配层(本地演示 / Supabase 云端)
 * 用法:页面 <script src="./js/supabase.js"></script><script src="./js/app-api.js"></script>
 * 云端模式:AppConfig.cloud=true(URL 加 ?cloud=1 可临时开启),数据走 Supabase RPC 函数
 * 本地模式:数据存 localStorage/sessionStorage(与云端同接口,返回 Promise)
 */
var AppConfig = {
    cloud: false,                            // 上线时改为 true(或 URL 加 ?cloud=1)
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
        var d = sessionStorage.getItem('roi_session');
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
            resolve({ ok: true, data: { token: 'local', user: { account: u.account, name: u.name, level: u.level } } });
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
                var d = sessionStorage.getItem('roi_session');
                var s = d ? JSON.parse(d) : null;
                if (s && s.account) resolve({ ok: true, data: { user: { account: s.account, name: s.name, level: s.level } } });
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
                list[k] = { account: u.account, name: u.name, level: u.level, status: u.status, regTime: u.regTime };
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
            if (users[account]) users[account].pwd = localHash(newpwd);
            localSetUsers(users);
            resolve({ ok: true });
        });
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
                    var s = sessionStorage.getItem('roi_session');
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
                var s = sessionStorage.getItem('roi_session');
                var cur = s ? JSON.parse(s) : null;
                can = cur && (cur.level === 1 || owners.indexOf(cur.name) > -1);
            } catch (e) { can = false; }
            if (!can) return resolve({ ok: false, msg: '无权限删除该项目', code: 403 });
            delete p[name];
            localSetProjects(p);
            resolve({ ok: true });
        });
    }
};
