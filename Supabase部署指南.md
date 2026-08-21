# ROI 计算器 - GitHub Pages + Supabase 部署指南

架构:**GitHub Pages 托管页面(免费)+ Supabase 做后端(数据库 + RPC 函数 + 权限)**。
前端通过 Supabase SDK 直连 RPC 函数(表已锁死,匿名只能调函数,权限在数据库内强制)。

```
浏览器(同事)
  → GitHub Pages:index.html / login.html / css / images / js   (免费)
  → Supabase RPC 函数:login/register/审核/项目CRUD/权限      (数据库层执行)
  → Supabase 数据库:users / projects / sessions
```

---

## 第 1 步:Supabase 项目(你已完成)

- Project URL:`https://frfsvgiykcytiemvallk.supabase.co`
- anon key:已在 `js/app-api.js` 里配好(勿改)

## 第 2 步:执行数据库脚本(关键)

1. 打开 supabase.com → 进入项目 → 左侧 **SQL Editor**
2. 打开本机 `Web_Project_ROI/supabase/schema.sql`,**全选复制** → 粘贴到 SQL Editor → **Run**
3. 应显示 3 张表创建成功 + 18 个函数创建成功(无红字报错)

脚本内容:建表 users/projects/sessions、**锁表**(anon 不能直接读写)、18 个 RPC 函数(登录/注册/审核/项目CRUD/权限校验,全部 security definer 以管理员身份执行)。

> 修改邀请码:找到 `schema.sql` 里 `p_invite <> 'ROI2026'`,改成你们内部码后重新执行(函数会覆盖)。

## 第 3 步:GitHub Pages 部署页面

1. GitHub 新建仓库(建议 Private),如 `roi-calculator`
2. 上传下列文件到仓库根目录:
   ```
   index.html
   login.html
   css/style.css
   images/logo.png
   js/supabase.js
   js/app-api.js
   ```
   (不要传 supabase/ 目录和 *.md)
3. 仓库 → Settings → Pages → Source: Deploy from a branch → main / (root) → Save
4. 等 1-2 分钟,得到地址 `https://你的用户名.github.io/roi-calculator/`

## 第 4 步:开启云端模式

打开仓库里 `js/app-api.js`,把第一行改成:

```js
cloud: true,   // 原来是 false
```

保存后重新提交到 GitHub(Pages 自动重新部署)。URL + anon key 已内置,无需再填。

> 也可以不改文件,直接访问站点地址加 `?cloud=1` 临时测试云端模式。

## 第 5 步:验证

1. 打开 GitHub Pages 地址 → `admin / admin123` 登录(首次登录函数会自动建管理员)
2. 新建项目(填负责人)→ 保存 → 刷新,数据仍在(Supabase 数据库)
3. 注册测试号(邀请码 ROI2026)→ 管理员「账号管理」审核 → 新号可登录
4. 2 级用户看非本人负责项目 → 🔒 只读
5. **立即改掉 admin 初始密码**(账号管理 → 重置密码)

## 第 6 步:数据迁移(可选)

本地 localStorage 项目数据搬上云:
1. 本地页面 F12:`console.log(localStorage.getItem('roi_calculator_projects'))`
2. 把 JSON 发我,我给批量导入脚本(SQL 或 RPC)

## 常见问题

| 现象 | 处理 |
|---|---|
| 登录提示"Supabase SDK 未加载" | 确认 `js/supabase.js` 已上传且路径正确;F12 Network 看 404 |
| 登录提示"账号不存在" | RPC 函数没执行成功:回 SQL Editor 重跑 schema.sql;或检查函数列表是否有 login |
| 提示"permission denied" | 锁表生效正常;确认用的是 RPC 不是直连表(页面已封装好) |
| CORS 报错 | Supabase 默认允许所有来源,一般不会出现;如有在 Supabase Authentication → URL Configuration 确认 |
| 数据不共享 | 确认 app-api.js 已 cloud:true 且重传生效(清浏览器缓存) |
| GitHub Pages 慢/打不开 | 国内访问 GitHub 的问题;公司有代理则正常 |

## 上线检查清单

- [ ] SQL Editor 执行 schema.sql 成功(3 表 + 18 函数)
- [ ] GitHub 仓库含全部静态文件,Pages 已发布
- [ ] app-api.js:cloud:true 已提交生效
- [ ] admin 登录 → 建项目(负责人)→ 刷新数据仍在
- [ ] 注册/审核/定级可用
- [ ] 2 级非负责人项目只读
- [ ] admin 初始密码已改
