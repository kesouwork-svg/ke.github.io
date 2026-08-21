/**
 * ROI 计算器 - CloudBase 云函数(PostgreSQL 版)
 *
 * 功能:登录/注册(邀请码)/管理员审核/项目 CRUD + 权限校验
 * 权限:1级(管理员)全改;2级仅可改自己负责的项目(owners 含本人姓名)
 *
 * 数据库:CloudBase SQL 型数据库(PostgreSQL)
 *   表:users(account/name/salt/pwd/level/status/reg_time)
 *       projects(name/data JSONB/saved_at)
 *       sessions(token/account/exp)
 *   建表 SQL 见 CloudBase 部署指南(SQL 型数据库章节)
 *
 * 环境变量:
 *   DATABASE_URL = postgres://用户:密码@主机:端口/数据库   (用"外网连接地址")
 *   INVITE_CODE  = ROI2026(可选)
 *
 * 部署:控制台创建云函数 roi-api(上传本目录),配置 HTTP 触发器(路径 /roi-api)
 * 前端(GitHub Pages)与 API 跨域:本函数响应已带 CORS 头并处理 OPTIONS 预检
 *
 * 调用协议(HTTP 触发器,POST JSON):
 *   { "action":"login", "data":{account,pwd} } 等,与之前一致
 */
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || '',
    max: 5,
    idleTimeoutMillis: 30000
});
const db = { query: (sql, params) => pool.query(sql, params) };

const DEFAULT_INVITE = 'ROI2026';
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const INVITE = process.env.INVITE_CODE || DEFAULT_INVITE;

let inited = false;

const hashPwd = (pwd, salt) => crypto.createHash('sha256').update(pwd + ':' + salt).digest('hex');
const genSalt = () => crypto.randomBytes(8).toString('hex');
const genToken = () => crypto.randomBytes(16).toString('hex');

// CORS:前端在 GitHub Pages(不同域),必须带跨域头
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
};
const respond = (obj, status) => ({
    statusCode: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS),
    body: JSON.stringify(obj)
});
const ok = (data, status) => respond({ ok: true, data }, status);
const fail = (msg, code) => respond({ ok: false, msg, code: code || 400 }, code || 400);

// ---------- 数据访问 ----------
async function findUser(account) {
    const r = await db.query('SELECT * FROM users WHERE account = $1', [account]);
    return r.rows.length ? r.rows[0] : null;
}
async function findSession(token) {
    const r = await db.query('SELECT * FROM sessions WHERE token = $1', [token]);
    return r.rows.length ? r.rows[0] : null;
}
async function findProject(name) {
    const r = await db.query('SELECT name, data FROM projects WHERE name = $1', [name]);
    return r.rows.length ? r.rows[0] : null;
}
async function getTokenUser(token) {
    if (!token) return null;
    const s = await findSession(token);
    if (!s || Date.now() > Number(s.exp)) return null;
    return await findUser(s.account);
}
const canEdit = (user, project) => {
    if (!user) return false;
    if (user.level === 1) return true;
    const owners = (project && project.owners) || [];
    return owners.indexOf(user.name) > -1;
};
async function ensureInit() {
    if (inited) return;
    const u = await findUser('admin');
    if (!u) {
        const salt = genSalt();
        await db.query(
            'INSERT INTO users (account, name, salt, pwd, level, status, reg_time) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            ['admin', '管理员', salt, hashPwd('admin123', salt), 1, 'active', new Date().toLocaleString('zh-CN')]
        );
    }
    inited = true;
}

exports.main = async (event) => {
    // HTTP 触发器 OPTIONS 预检(跨域)
    if (event && (event.httpMethod === 'OPTIONS' || event.method === 'OPTIONS'
        || (event.requestContext && event.requestContext.httpMethod === 'OPTIONS'))) {
        return respond({ ok: true });
    }
    let payload = event;
    if (typeof event === 'string') { try { payload = JSON.parse(event); } catch (e) { payload = {}; } }
    else if (event.body && typeof event.body === 'string') {
        try { payload = JSON.parse(event.body); } catch (e) { payload = {}; }
    }
    const action = payload.action || (payload.path ? String(payload.path).replace(/^\//, '') : '');
    const data = payload.data || {};
    const token = payload.token || '';

    try {
        await ensureInit();

        switch (action) {
            // ---------- 认证 ----------
            case 'login': {
                const { account, pwd } = data;
                if (!account || !pwd) return fail('请输入账号和密码');
                const u = await findUser(account);
                if (!u) return fail('账号不存在');
                if (u.status === 'pending') return fail('账号待管理员审核,请稍后');
                if (u.status === 'disabled') return fail('账号已停用,请联系管理员');
                if (u.pwd !== hashPwd(pwd, u.salt || '')) return fail('密码错误');
                const tk = genToken();
                await db.query('INSERT INTO sessions (token, account, exp) VALUES ($1,$2,$3)',
                    [tk, u.account, Date.now() + SESSION_TTL]);
                return ok({ token: tk, user: { account: u.account, name: u.name, level: u.level } });
            }
            case 'register': {
                const { name, account, pwd, invite } = data;
                if (!name || !account || !pwd) return fail('请填写姓名、账号、密码');
                if (String(pwd).length < 6) return fail('密码至少 6 位');
                if (invite !== INVITE) return fail('邀请码不正确');
                const exist = await findUser(account);
                if (exist) return fail('该账号已存在');
                const salt = genSalt();
                await db.query(
                    'INSERT INTO users (account, name, salt, pwd, level, status, reg_time) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                    [account, name, salt, hashPwd(pwd, salt), 2, 'pending', new Date().toLocaleString('zh-CN')]
                );
                return ok({ msg: '申请已提交,等待管理员审核' });
            }
            case 'me': {
                const u = await getTokenUser(token);
                if (!u) return fail('未登录', 401);
                return ok({ user: { account: u.account, name: u.name, level: u.level } });
            }
            case 'logout': {
                if (token) await db.query('DELETE FROM sessions WHERE token = $1', [token]);
                return ok({});
            }

            // ---------- 账号管理(仅1级) ----------
            case 'adminUsers': {
                const u = await getTokenUser(token);
                if (!u || u.level !== 1) return fail('无权限', 403);
                const r = await db.query('SELECT account, name, level, status, reg_time FROM users');
                const list = {};
                (r.rows || []).forEach(x => { list[x.account] = x; });
                return ok({ users: list });
            }
            case 'adminAudit': {
                const u = await getTokenUser(token);
                if (!u || u.level !== 1) return fail('无权限', 403);
                const { account, level } = data;
                await db.query('UPDATE users SET status = \'active\', level = $2 WHERE account = $1',
                    [account, level === 1 ? 1 : 2]);
                return ok({});
            }
            case 'adminReject': {
                const u = await getTokenUser(token);
                if (!u || u.level !== 1) return fail('无权限', 403);
                const { account } = data;
                await db.query('DELETE FROM users WHERE account = $1', [account]);
                return ok({});
            }
            case 'adminLevel': {
                const u = await getTokenUser(token);
                if (!u || u.level !== 1) return fail('无权限', 403);
                const { account, level } = data;
                await db.query('UPDATE users SET level = $2 WHERE account = $1', [account, level === 1 ? 1 : 2]);
                return ok({});
            }
            case 'adminToggle': {
                const u = await getTokenUser(token);
                if (!u || u.level !== 1) return fail('无权限', 403);
                const { account } = data;
                const t = await findUser(account);
                if (t) await db.query('UPDATE users SET status = $2 WHERE account = $1',
                    [account, t.status === 'active' ? 'disabled' : 'active']);
                return ok({});
            }
            case 'adminResetpwd': {
                const u = await getTokenUser(token);
                if (!u || u.level !== 1) return fail('无权限', 403);
                const { account, newpwd } = data;
                if (!newpwd || String(newpwd).length < 6) return fail('新密码至少 6 位');
                const salt = genSalt();
                await db.query('UPDATE users SET salt = $2, pwd = $3 WHERE account = $1',
                    [account, salt, hashPwd(newpwd, salt)]);
                return ok({});
            }

            // ---------- 项目 ----------
            case 'projectsList': {
                const u = await getTokenUser(token);
                if (!u) return fail('未登录', 401);
                const r = await db.query('SELECT name, data FROM projects');
                const projects = {};
                (r.rows || []).forEach(x => { projects[x.name] = x.data; });
                return ok({ projects });
            }
            case 'projectGet': {
                const u = await getTokenUser(token);
                if (!u) return fail('未登录', 401);
                const { name } = data;
                const p = await findProject(name);
                if (!p) return fail('项目不存在', 404);
                return ok({ project: p.data });
            }
            case 'projectSave': {
                const u = await getTokenUser(token);
                if (!u) return fail('未登录', 401);
                const { name, project } = data;
                if (!name || !project) return fail('参数不完整');
                const exist = await findProject(name);
                if (exist && !canEdit(u, exist.data)) return fail('无权限修改该项目', 403);
                const body = Object.assign({}, project, { name, savedAt: new Date().toLocaleString('zh-CN') });
                await db.query(
                    'INSERT INTO projects (name, data, saved_at) VALUES ($1,$2,$3) ON CONFLICT (name) DO UPDATE SET data = $2, saved_at = $3',
                    [name, JSON.stringify(body), body.savedAt]
                );
                return ok({});
            }
            case 'projectDelete': {
                const u = await getTokenUser(token);
                if (!u) return fail('未登录', 401);
                const { name } = data;
                const exist = await findProject(name);
                if (!exist) return fail('项目不存在', 404);
                if (!canEdit(u, exist.data)) return fail('无权限删除该项目', 403);
                await db.query('DELETE FROM projects WHERE name = $1', [name]);
                return ok({});
            }

            // ---------- 兜底 ----------
            case 'initAdmin': {
                const u = await getTokenUser(token);
                if (!u || u.level !== 1) return fail('无权限', 403);
                await db.query('DELETE FROM users WHERE account = \'admin\'');
                inited = false;
                await ensureInit();
                return ok({});
            }
            default:
                return fail('接口不存在: ' + action, 404);
        }
    } catch (e) {
        return fail('服务器错误: ' + e.message, 500);
    }
};
