# Supabase 日常管理命令

> 适用:ROI 计算器(GitHub Pages + Supabase)
> 所有命令都在 **Supabase 控制台 → SQL Editor** 里执行;执行前看清注释,涉及删除的命令先确认。

---

## 一、邀请码管理(config 表)

| 操作 | SQL |
|---|---|
| **查看当前邀请码和有效期** | `select * from public.config where key='invite_code';` |
| **修改邀请码** | `update public.config set value='新邀请码' where key='invite_code';` |
| **设置有效期**(如到 2026-12-31) | `update public.config set expire_at='2026-12-31 23:59:59' where key='invite_code';` |
| **取消有效期**(永久有效) | `update public.config set expire_at=null where key='invite_code';` |
| **立即停用**(马上作废) | `update public.config set expire_at=now() where key='invite_code';` |
| **换码+设有效期一步完成** | `update public.config set value='新码', expire_at='2026-09-30 23:59:59' where key='invite_code';` |

> 过期后注册会提示「邀请码已过期」;改完立即生效,前端不用动。

---

## 二、账号管理(users 表)

| 操作 | SQL |
|---|---|
| **查看全部账号** | `select account, name, level, status, reg_time from public.users order by reg_time desc;` |
| **查看待审核申请** | `select account, name, reg_time from public.users where status='pending';` |
| **直接审核通过(2级)** | `update public.users set status='active', level=2 where account='账号';` |
| **设为1级管理员** | `update public.users set level=1 where account='账号';` |
| **停用账号** | `update public.users set status='disabled' where account='账号';` |
| **启用账号** | `update public.users set status='active' where account='账号';` |
| **删除账号(含驳回)** | `delete from public.users where account='账号';` |
| **重置某账号密码** | `update public.users set pwd=crypt('新密码', gen_salt('bf')) where account='账号';` |
| **重置 admin(密码回到 admin123)** | `delete from public.users where account='admin'; select public.init_admin();` |

> 页面「账号管理」已覆盖大部分操作;SQL 用于批量或应急。

---

## 三、项目数据(projects 表)

| 操作 | SQL |
|---|---|
| **查看项目列表** | `select name, saved_at from public.projects order by saved_at desc;` |
| **查看某个项目的完整数据** | `select data from public.projects where name='项目名';` |
| **删除某个项目** | `delete from public.projects where name='项目名';` |
| **清空全部项目(慎用)** | `delete from public.projects;` |
| **导出全部项目为 JSON(备份)** | `select jsonb_object_agg(name, data) from public.projects;` |

> 项目数据是嵌套 JSONB,备份用「导出为 JSON」;控制台 Table Editor 也支持导出 CSV/JSON。

---

## 四、会话清理(sessions 表)

| 操作 | SQL |
|---|---|
| **清理已过期会话** | `delete from public.sessions where exp < (extract(epoch from now()) * 1000)::bigint;` |
| **清理全部会话(所有人重新登录)** | `delete from public.sessions;` |

---

## 五、数据备份建议

- **定期备份**:控制台 → Database → Backups(项目级备份),或每周执行一次:
  ```sql
  select jsonb_object_agg(name, data) from public.projects;
  ```
  把结果复制保存一份 JSON 文件
- 账号表较小,需要时同样导出:
  ```sql
  select jsonb_object_agg(account, jsonb_build_object('name',name,'level',level,'status',status,'reg_time',reg_time)) from public.users;
  ```

---

## 六、常见排查

| 问题 | 命令 |
|---|---|
| 有人注册了但管理员看不到 | 先确认线上页面是云端模式(`AppConfig.cloud=true`),再看 `select * from public.users where status='pending';` |
| 忘了 admin 密码 | 执行「重置 admin」那两条 |
| 邀请码不生效 | 看 config 表是否被改过、是否过期 |
| 项目数据不见了 | 看 `select name, saved_at from public.projects;` 是否为空(可能没保存成功或走错模式) |

---

*本文档随项目存放:`Web_Project_ROI/Supabase日常管理命令.md`*
