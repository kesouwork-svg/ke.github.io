# ROI 计算器 - CloudBase 上线指南

方案:CloudBase 静态托管(页面)+ 云函数(后端)+ 云数据库(数据)。
前端已带「本地/云端」双模式开关,上线只需三步:建后端 → 传页面 → 改配置。

## 项目文件说明

```
Web_Project_ROI/
├── index.html           页面(已接 AppApi)
├── login.html           登录页(已接 AppApi)
├── css/style.css
├── images/logo.png
├── js/app-api.js        数据适配层(本地/云端开关在这里配置)
└── cloudbase/roi-api/   云函数目录(index.js + package.json)
```

---

## 第 1 步:创建 CloudBase 环境

1. 腾讯云控制台 → 搜索「云开发 CloudBase」→ 进入
2. 创建环境,名称如 `roi-prod`,按量计费(有免费额度)
3. 记下 **环境 ID**(形如 `roi-prod-xxxxxx`)

## 第 2 步:创建数据库集合

环境详情 → 「数据库」→ 新建 3 个集合:

| 集合名 | 用途 |
|---|---|
| `users` | 账号(含姓名/级别/状态) |
| `projects` | 项目(含负责人 owners) |
| `sessions` | 登录会话(token) |

> 权限设置选「仅云函数可读写」(客户端不直连,安全),或保持默认并在安全规则中禁止客户端写。

## 第 3 步:上传云函数

1. 环境 → 「云函数」→ 新建函数,名称 `roi-api`
2. 上传方式:选择「上传文件夹」,上传 `cloudbase/roi-api/` 整个目录(含 index.js 和 package.json;依赖 `@cloudbase/node-sdk` 由平台自动安装)
3. 环境变量(可选):`INVITE_CODE = ROI2026`
4. 部署完成

## 第 4 步:配置 HTTP 触发器(让前端能 fetch 调用)

1. 云函数 `roi-api` → 「触发配置 / HTTP 访问服务」→ 添加 HTTP 触发器
2. 路径填:`/roi-api`(可自定义),勾选「GET/POST」
3. 发布后得到访问地址,形如:
   `https://roi-prod-xxxxxx.service.tcloudbase.com/roi-api`
4. **复制这个完整 URL**,下一步要用

> 触发器生效需要一点时间(分钟级)。

## 第 5 步:部署静态页面

环境 → 「静态网站托管」→ 开通 → 上传文件,把下面这些传上去(**不要传 cloudbase 目录和 md 文档**):

```
index.html
login.html
css/style.css
images/logo.png
js/app-api.js
```

部署后得到静态托管地址,如 `https://roi-prod-xxxxxx.tcloudbaseapp.com`。
访问该地址,应能看到登录页。

## 第 6 步:前端切到云端模式(关键)

打开 `js/app-api.js`,改两处:

```js
var AppConfig = {
    cloud: true,          // false → true
    apiBase: ''           // 填第 4 步的 HTTP 触发器 URL
};
```

改完重新上传 `js/app-api.js`(静态托管覆盖即可)。

> 临时测试也可以不改文件:访问静态地址时加 `?cloud=1`(如 `...tcloudbaseapp.com/index.html?cloud=1`),但 apiBase 仍需先填好。

## 第 7 步:验证

1. 打开登录页 → 用 `admin / admin123` 登录(首次访问函数会自动创建管理员)
2. 进入主页 → 新建项目(填负责人)→ 保存 → 刷新数据仍在
3. 注册一个测试号(邀请码 ROI2026)→ 管理员在「账号管理」审核 → 新号可登录
4. 2 级用户看非本人负责项目 → 显示 🔒 只读
5. **务必立即改掉 admin 初始密码**(账号管理→重置密码)

## 第 8 步:数据迁移(把本地数据搬上云,可选)

本地演示版数据在浏览器 localStorage。迁移:

1. 在本地版页面 F12 执行:复制项目 JSON
   ```js
   console.log(localStorage.getItem('roi_calculator_projects'))
   ```
2. 把 JSON 发给我(或导入到控制台数据库 `projects` 集合,一个文档一个项目,字段照原样)

## 常见问题

| 现象 | 处理 |
|---|---|
| 登录/列表提示"网络错误" | apiBase 没填对 / HTTP 触发器未生效 / 跨域(触发器一般同域,若独立域名需在云函数响应加 CORS 头,可找我) |
| 云函数报错 500 | 检查集合是否已建;云函数依赖是否安装成功(部署日志) |
| 首次登录 admin 提示"账号不存在" | 触发器还没完全生效,等几分钟重试;或调一次 `/roi-api` 任意请求触发初始化 |
| 静态页面打不开 | 确认已上传 index.html 且路径正确;静态托管服务已开通 |
| 数据不共享 | 前端还是本地模式:确认 app-api.js 里 cloud=true 且 apiBase 已填,并重新上传 js 文件 |

## 上线检查清单

- [ ] 云函数 roi-api 已部署、HTTP 触发器已通(能返回 {ok:false,msg})
- [ ] 静态托管能打开登录页
- [ ] app-api.js:cloud=true + apiBase 已填并重传
- [ ] admin 登录 → 建项目(含负责人)→ 刷新仍在
- [ ] 注册/审核/定级 流程可用
- [ ] 2 级非负责人项目只读
- [ ] admin 初始密码已改
