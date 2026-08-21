/**
 * ROI 计算器 - EdgeOne 边缘函数(后端)
 * 功能:登录/注册/审核/项目 CRUD + KV 存储 + 权限校验
 * 权限:1级(管理员)全改;2级仅可改自己负责的项目(owners 含本人姓名)
 *
 * 部署绑定:
 *   - KV 绑定:env.KV(键:users/projects/sessions/invite)
 *   - 环境变量:INVITE_CODE(邀请码,默认 ROI2026)
 *   - 路由:/api/* 交给本函数,其余走 Pages 静态
 *
 * 接口:
 *   POST /api/auth/login        {account,pwd}
 *   POST /api/auth/register     {name,account,pwd,invite}
 *   GET  /api/auth/me            (Bearer token)
 *   POST /api/auth/logout        (Bearer token)
 *   GET  /api/admin/users        (admin)
 *   POST /api/admin/audit        {account,level} (admin)
 *   POST /api/admin/reject       {account} (admin)
 *   POST /api/admin/level        {account,level} (admin)
 *   POST /api/admin/toggle       {account} (admin)
 *   POST /api/admin/resetpwd     {account,newpwd} (admin)
 *   GET  /api/projects           (auth)
 *   GET  /api/projects/{name}    (auth)
 *   PUT  /api/projects/{name}    (auth+权限) body=项目对象
 *   DELETE /api/projects/{name}  (auth+权限)
 */
const DEFAULT_INVITE = 'ROI2026';
const SESSION_TTL = 7 * 24 * 3600 * 1000; // 7 天

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;

        // CORS(与 Pages 同域时可省,跨域部署时放开)
        const cors = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization'
        };
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors });
        }

        const respond = (obj, status) => new Response(JSON.stringify(obj), {
            status: status || 200,
            headers: { 'Content-Type': 'application/json', ...cors }
        });
        const fail = (msg, status) => respond({ ok: false, msg }, status || 400);
        const readBody = async () => {
            try { return await request.json(); } catch (e) { return {}; }
        };

        const INVITE = env.INVITE_CODE || DEFAULT_INVITE;

        // ---------- 工具 ----------
        const kvGet = async (key, def) => {
            const v = await env.KV.get(key);
            return v ? JSON.parse(v) : def;
        };
        const kvSet = async (key, val) => { await env.KV.put(key, JSON.stringify(val)); };

        const hashPwd = async (pwd, salt) => {
            const data = new TextEncoder().encode(pwd + ':' + salt);
            const buf = await crypto.subtle.digest('SHA-256', data);
            return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
        };
        const genSalt = () => {
            const a = new Uint8Array(8);
            crypto.getRandomValues(a);
            return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
        };
        const genToken = () => {
            const a = new Uint8Array(16);
            crypto.getRandomValues(a);
            return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
        };
        const getAuth = async (headers) => {
            const h = headers.get('Authorization') || '';
            const token = h.startsWith('Bearer ') ? h.slice(7) : '';
            if (!token) return null;
            const sessions = await kvGet('sessions', {});
            const s = sessions[token];
            if (!s || Date.now() > s.exp) return null;
            const users = await kvGet('users', {});
            return users[s.account] || null;
        };
        const canEdit = (user, project) => {
            if (!user) return false;
            if (user.level === 1) return true;
            const owners = project && project.owners ? project.owners : [];
            return owners.indexOf(user.name) > -1;
        };
        // 首次调用时初始化管理员与邀请码
        const ensureInit = async () => {
            const users = await kvGet('users', {});
            if (!users.admin) {
                const salt = genSalt();
                users.admin = {
                    account: 'admin', name: '管理员',
                    salt: salt,
                    pwd: await hashPwd('admin123', salt),
                    level: 1, status: 'active',
                    regTime: new Date().toLocaleString('zh-CN')
                };
                await kvSet('users', users);
            }
        };
        await ensureInit();

        // ---------- 认证 ----------
        if (path === '/api/auth/login' && request.method === 'POST') {
            const { account, pwd } = await readBody();
            if (!account || !pwd) return fail('请输入账号和密码');
            const users = await kvGet('users', {});
            const u = users[account];
            if (!u) return fail('账号不存在');
            if (u.status === 'pending') return fail('账号待管理员审核,请稍后');
            if (u.status === 'disabled') return fail('账号已停用,请联系管理员');
            const hp = await hashPwd(pwd, u.salt || '');
            if (hp !== u.pwd) return fail('密码错误');
            const token = genToken();
            const sessions = await kvGet('sessions', {});
            sessions[token] = { account: u.account, exp: Date.now() + SESSION_TTL };
            await kvSet('sessions', sessions);
            return respond({ ok: true, token, user: { account: u.account, name: u.name, level: u.level } });
        }

        if (path === '/api/auth/register' && request.method === 'POST') {
            const { name, account, pwd, invite } = await readBody();
            if (!name || !account || !pwd) return fail('请填写姓名、账号、密码');
            if (String(pwd).length < 6) return fail('密码至少 6 位');
            if (invite !== INVITE) return fail('邀请码不正确');
            const users = await kvGet('users', {});
            if (users[account]) return fail('该账号已存在');
            const salt = genSalt();
            users[account] = {
                account, name,
                salt, pwd: await hashPwd(pwd, salt),
                level: 2, status: 'pending',
                regTime: new Date().toLocaleString('zh-CN')
            };
            await kvSet('users', users);
            return respond({ ok: true, msg: '申请已提交,等待管理员审核' });
        }

        if (path === '/api/auth/me' && request.method === 'GET') {
            const u = await getAuth(request.headers);
            if (!u) return fail('未登录', 401);
            return respond({ ok: true, user: { account: u.account, name: u.name, level: u.level } });
        }

        if (path === '/api/auth/logout' && request.method === 'POST') {
            const h = request.headers.get('Authorization') || '';
            const token = h.startsWith('Bearer ') ? h.slice(7) : '';
            if (token) {
                const sessions = await kvGet('sessions', {});
                delete sessions[token];
                await kvSet('sessions', sessions);
            }
            return respond({ ok: true });
        }

        // ---------- 账号管理(仅1级) ----------
        const requireAdmin = async () => {
            const u = await getAuth(request.headers);
            return u && u.level === 1 ? u : null;
        };

        if (path === '/api/admin/users' && request.method === 'GET') {
            const admin = await requireAdmin();
            if (!admin) return fail('无权限', 403);
            const users = await kvGet('users', {});
            const list = {};
            for (const k in users) {
                const u = users[k];
                list[k] = { account: u.account, name: u.name, level: u.level, status: u.status, regTime: u.regTime };
            }
            return respond({ ok: true, users: list });
        }

        if (path === '/api/admin/audit' && request.method === 'POST') {
            const admin = await requireAdmin();
            if (!admin) return fail('无权限', 403);
            const { account, level } = await readBody();
            const users = await kvGet('users', {});
            if (users[account]) { users[account].status = 'active'; users[account].level = (level === 1 ? 1 : 2); }
            await kvSet('users', users);
            return respond({ ok: true });
        }

        if (path === '/api/admin/reject' && request.method === 'POST') {
            const admin = await requireAdmin();
            if (!admin) return fail('无权限', 403);
            const { account } = await readBody();
            const users = await kvGet('users', {});
            delete users[account];
            await kvSet('users', users);
            return respond({ ok: true });
        }

        if (path === '/api/admin/level' && request.method === 'POST') {
            const admin = await requireAdmin();
            if (!admin) return fail('无权限', 403);
            const { account, level } = await readBody();
            const users = await kvGet('users', {});
            if (users[account]) users[account].level = (level === 1 ? 1 : 2);
            await kvSet('users', users);
            return respond({ ok: true });
        }

        if (path === '/api/admin/toggle' && request.method === 'POST') {
            const admin = await requireAdmin();
            if (!admin) return fail('无权限', 403);
            const { account } = await readBody();
            const users = await kvGet('users', {});
            if (users[account]) users[account].status = users[account].status === 'active' ? 'disabled' : 'active';
            await kvSet('users', users);
            return respond({ ok: true });
        }

        if (path === '/api/admin/resetpwd' && request.method === 'POST') {
            const admin = await requireAdmin();
            if (!admin) return fail('无权限', 403);
            const { account, newpwd } = await readBody();
            if (!newpwd || String(newpwd).length < 6) return fail('新密码至少 6 位');
            const users = await kvGet('users', {});
            if (users[account]) {
                users[account].salt = genSalt();
                users[account].pwd = await hashPwd(newpwd, users[account].salt);
            }
            await kvSet('users', users);
            return respond({ ok: true });
        }

        // ---------- 项目 ----------
        if (path === '/api/projects' && request.method === 'GET') {
            const u = await getAuth(request.headers);
            if (!u) return fail('未登录', 401);
            const projects = await kvGet('projects', {});
            return respond({ ok: true, projects });
        }

        if (path.startsWith('/api/projects/') && request.method === 'GET') {
            const u = await getAuth(request.headers);
            if (!u) return fail('未登录', 401);
            const name = decodeURIComponent(path.slice('/api/projects/'.length));
            const projects = await kvGet('projects', {});
            return projects[name] ? respond({ ok: true, project: projects[name] })
                : fail('项目不存在', 404);
        }

        if (path.startsWith('/api/projects/') && request.method === 'PUT') {
            const u = await getAuth(request.headers);
            if (!u) return fail('未登录', 401);
            const name = decodeURIComponent(path.slice('/api/projects/'.length));
            const body = await readBody();
            const projects = await kvGet('projects', {});
            const exist = projects[name];
            // 权限:1级全改;2级仅负责人;新建项目(不存在)允许所有登录用户
            if (exist && !canEdit(u, exist)) return fail('无权限修改该项目', 403);
            projects[name] = Object.assign({ name }, body, { savedAt: new Date().toLocaleString('zh-CN') });
            await kvSet('projects', projects);
            return respond({ ok: true });
        }

        if (path.startsWith('/api/projects/') && request.method === 'DELETE') {
            const u = await getAuth(request.headers);
            if (!u) return fail('未登录', 401);
            const name = decodeURIComponent(path.slice('/api/projects/'.length));
            const projects = await kvGet('projects', {});
            const exist = projects[name];
            if (!exist) return fail('项目不存在', 404);
            if (!canEdit(u, exist)) return fail('无权限删除该项目', 403);
            delete projects[name];
            await kvSet('projects', projects);
            return respond({ ok: true });
        }

        // 未匹配的 /api 请求
        return fail('接口不存在', 404);
    }
};
