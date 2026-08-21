# ROI 计算器 - GitHub Pages + CloudBase 部署指南

架构:**GitHub Pages 托管页面(免费)+ 腾讯云 CloudBase 做后端(云函数 + 云数据库)**。
页面与 API 在不同域名,云函数已内置 CORS 跨域支持,浏览器可正常访问。

```
浏览器(同事)
  → GitHub Pages:index.html / login.html / css / images / js   (免费)
  → CloudBase 云函数 roi-api:登录/注册/审核/项目CRUD/权限   (HTTP 触发器)
  → CloudBase 云数据库:users / projects / sessions
```

---

## 第 1 步:CloudBase 后端(一次做完)

1. 腾讯云控制台 → 云开发 CloudBase → 创建环境(如 `roi-prod`,体验版即可,免费),记下**环境 ID**
2. 「SQL 型数据库(PostgreSQL)」→ 新建数据库(如 `roi`)→ 在其中执行以下建表 SQL(若你已手动建表,请**对照校准字段**):

```sql
CREATE TABLE IF NOT EXISTS users (
  account VARCHAR(64) PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  salt VARCHAR(64) NOT NULL DEFAULT '',
  pwd VARCHAR(128) NOT NULL,
  level INT NOT NULL DEFAULT 2,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  reg_time VARCHAR(64) DEFAULT ''
);
CREATE TABLE IF NOT EXISTS projects (
  name VARCHAR(128) PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}',
  saved_at VARCHAR(64) DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions (
  token VARCHAR(64) PRIMARY KEY,
  account VARCHAR(64) NOT NULL,
  exp BIGINT NOT NULL
);
```

3. 「云函数」→ 新建函数 `roi-api` → 上传 `cloudbase/roi-api/` 整个目录(含 index.js 与 package.json,依赖 `pg` 由平台自动安装)
4. 配置**环境变量**(关键,PostgreSQL 版必需):
   - `DATABASE_URL` = 从 SQL 型数据库「连接信息」里复制的 **外网连接地址**,格式:
     `postgres://用户名:密码@主机:端口/数据库名`
   - `INVITE_CODE = ROI2026`(可选)
5. 云函数 → 「HTTP 访问服务 / 触发配置」→ 添加 HTTP 触发器,路径 `/roi-api`
6. 发布后得到 URL,形如:
   `https://roi-prod-xxxxxx.service.tcloudbase.com/roi-api`
7. **复制这个 URL(apiBase),下一步用**

> 云函数已内置 CORS 头 + OPTIONS 预检处理,跨域由后端解决,前端无需任何额外配置。

## 第 2 步:GitHub Pages 部署页面

1. 注册/登录 GitHub → 新建仓库(如 `roi-calculator`,建议 **Private**)
2. 把下列文件上传到仓库根目录(**不要传 cloudbase/ 目录和 *.md 文档**):
   ```
   index.html
   login.html
   css/style.css
   images/logo.png
   js/app-api.js
   ```
3. 仓库 → Settings → Pages:
   - Source 选 `Deploy from a branch`
   - Branch 选 `main`,目录 `/ (root)`,Save
4. 等 1-2 分钟,得到站点地址:
   `https://你的用户名.github.io/roi-calculator/`
5. 访问该地址,应能看到登录页(此时登录会失败,因为还没切云端模式)

## 第 3 步:前端切到云端模式

打开仓库里的 `js/app-api.js`,改两处:

```js
var AppConfig = {
    cloud: true,          // false → true
    apiBase: ''           // 填第 1 步的 CloudBase HTTP 触发器 URL
};
```

保存后重新上传/提交到仓库(Pages 会自动重新部署,等 1-2 分钟)。

> 注意:GitHub Pages 部署有缓存,若改后没生效,可在 Settings → Pages 点「Clear cache」或等几分钟。

## 第 4 步:验证

1. 打开 `https://你的用户名.github.io/roi-calculator/`
2. `admin / admin123` 登录(首次访问云函数会自动创建管理员)
3. 新建项目(填负责人)→ 保存 → 刷新,数据仍在(已存入 CloudBase 云数据库)
4. 注册测试号(邀请码 ROI2026)→ 管理员「账号管理」审核 → 新号可登录
5. 2 级用户看非本人负责项目 → 🔒 只读
6. **立即修改 admin 初始密码**(账号管理 → 重置密码)

## 第 5 步:数据迁移(可选)

本地版 localStorage 数据搬上云:
1. 本地页面 F12 执行:复制项目 JSON
   ```js
   console.log(localStorage.getItem('roi_calculator_projects'))
   ```
2. 把 JSON 发我,我给你批量导入脚本;或手动在控制台数据库 `projects` 集合逐条导入(一个文档=一个项目)

## 常见问题

| 现象 | 处理 |
|---|---|
| 登录提示"网络错误" | ①apiBase 是否填对且已重新上传 js;②HTTP 触发器是否生效(等几分钟再试);③浏览器 F12 Network 看请求状态 |
| 云函数报 500 "connection" 类错误 | `DATABASE_URL` 未配置/填错:确认外网连接地址完整、格式正确、云函数环境变量已保存 |
| 云函数报"关系 users 不存在" | 建表没执行成功:在 SQL 型数据库用上方 DDL 建表(或核对字段名一致) |
| 浏览器控制台 CORS 报错 | 云函数已带 CORS 头;若仍报错,确认部署的是最新版 index.js(含 CORS 的版本) |
| GitHub Pages 打开 404 | 仓库里确认有 index.html;Pages 已启用并选了 main/root;等部署完成 |
| GitHub Pages 访问慢/打不开 | 国内网络问题;公司网络有代理则正常。这是 GitHub 方案的固有风险 |
| 登录提示"账号不存在" | 触发器刚建好未完全生效,等几分钟;或访问一次 apiBase 触发初始化 |
| 数据不共享 | 确认 app-api.js 已 cloud:true 且重传生效(清除浏览器缓存再看) |

## 上线检查清单

- [ ] CloudBase:3 集合已建、云函数已部署、HTTP 触发器已通
- [ ] GitHub:仓库有全部静态文件、Pages 已发布、能打开登录页
- [ ] app-api.js:cloud=true + apiBase 已填并重新上传
- [ ] admin 登录 → 建项目(含负责人)→ 刷新数据仍在
- [ ] 注册/审核/定级可用
- [ ] 2 级非负责人项目只读
- [ ] admin 初始密码已改
