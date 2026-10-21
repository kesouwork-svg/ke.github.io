-- ============================================================
-- ROI 计算器 - Supabase 数据库脚本
-- 用法:Supabase 控制台 → SQL Editor → 粘贴本文件全部内容 → Run
-- 包含:建表、RPC 函数(登录/注册/审核/项目CRUD/权限)、锁表
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- 表 ----------
create table if not exists public.users (
  account text primary key,
  name text not null,
  pwd text not null,
  level int not null default 2,
  status text not null default 'pending',
  reg_time text default '',
  dept text default '',                 -- 所属车间(报修人按车间限权;管理员建号时指定)
  must_change_pwd boolean default false -- 首次登录/被重置密码后强制改密
);
-- 老库补列(create table if not exists 不会给已存在的表加列)
alter table public.users add column if not exists dept text default '';
alter table public.users add column if not exists must_change_pwd boolean default false;
create table if not exists public.projects (
  name text primary key,
  data jsonb not null default '{}',
  saved_at text default ''
);
create table if not exists public.sessions (
  token text primary key,
  account text not null,
  exp bigint not null
);

-- 锁表:客户端(anon)不允许直接读写,一切走 RPC
revoke all on public.users, public.projects, public.sessions from anon, authenticated;

-- ---------- 内部函数 ----------
-- 按 token 取当前用户(过期校验)
create or replace function public._get_user_by_token(p_token text)
returns public.users language sql security definer stable as $$
  select u.* from public.users u
  where u.account = (
    select s.account from public.sessions s
    where s.token = p_token and s.exp > (extract(epoch from now()) * 1000)::bigint
    limit 1
  )
  and u.status = 'active'          -- 停用账号立即失效,不用等 token 过期
  limit 1;
$$;

-- 初始化管理员(幂等)
create or replace function public.init_admin()
returns void language plpgsql security definer as $$
begin
  insert into public.users (account, name, pwd, level, status, reg_time)
  values ('admin', '管理员', crypt('admin123', gen_salt('bf')), 1, 'active', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
  on conflict (account) do nothing;
end $$;

-- ---------- 认证 ----------
create or replace function public.login(p_account text, p_pwd text)
returns jsonb language plpgsql security definer as $$
declare
  u public.users%rowtype;
  tk text;
begin
  perform public.init_admin();
  select * into u from public.users where account = p_account;
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '账号不存在'); end if;
  if u.status = 'pending' then return jsonb_build_object('ok', false, 'msg', '账号待管理员审核,请稍后'); end if;
  if u.status = 'disabled' then return jsonb_build_object('ok', false, 'msg', '账号已停用,请联系管理员'); end if;
  if u.pwd <> crypt(p_pwd, u.pwd) then return jsonb_build_object('ok', false, 'msg', '密码错误'); end if;
  tk := gen_random_uuid()::text;
  insert into public.sessions (token, account, exp) values (tk, u.account, (extract(epoch from now()) * 1000)::bigint + 2592000000);
  return jsonb_build_object('ok', true, 'data',
    jsonb_build_object('token', tk, 'user', jsonb_build_object(
      'account', u.account, 'name', u.name, 'level', u.level,
      'tools', coalesce(u.tools, '["roi"]'::jsonb),
      'dept', coalesce(u.dept, ''),
      'must_change_pwd', coalesce(u.must_change_pwd, false))));
end $$;

create or replace function public.register(p_name text, p_account text, p_pwd text, p_invite text)
returns jsonb language plpgsql security definer as $$
declare
  u public.users%rowtype;
begin
  if p_name is null or p_account is null or p_pwd is null then
    return jsonb_build_object('ok', false, 'msg', '请填写姓名、账号、密码'); end if;
  if length(p_pwd) < 6 then return jsonb_build_object('ok', false, 'msg', '密码至少 6 位'); end if;
  if p_invite <> 'ROI2026' then return jsonb_build_object('ok', false, 'msg', '邀请码不正确'); end if;
  select * into u from public.users where account = p_account;
  if u.account is not null then return jsonb_build_object('ok', false, 'msg', '该账号已存在'); end if;
  insert into public.users (account, name, pwd, level, status, reg_time)
  values (p_account, p_name, crypt(p_pwd, gen_salt('bf')), 2, 'pending', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'));
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('msg', '申请已提交,等待管理员审核'));
end $$;

create or replace function public.me(p_token text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录'); end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('user', jsonb_build_object(
    'account', u.account, 'name', u.name, 'level', u.level,
    'tools', coalesce(u.tools, '["roi"]'::jsonb),
    'dept', coalesce(u.dept, ''),
    'must_change_pwd', coalesce(u.must_change_pwd, false))));
end $$;

create or replace function public.logout(p_token text)
returns jsonb language plpgsql security definer as $$
begin
  delete from public.sessions where token = p_token;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- 账号管理(仅1级) ----------
create or replace function public.admin_users(p_token text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('users',
    coalesce((select jsonb_object_agg(x.account, jsonb_build_object('account', x.account, 'name', x.name, 'level', x.level, 'status', x.status, 'reg_time', x.reg_time, 'tools', coalesce(x.tools, '["roi"]'::jsonb), 'dept', coalesce(x.dept, ''), 'must_change_pwd', coalesce(x.must_change_pwd, false))) from public.users x), '{}'::jsonb)));
end $$;

create or replace function public.admin_audit(p_token text, p_account text, p_level int)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  update public.users set status = 'active', level = case when p_level = 1 then 1 else 2 end where account = p_account;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_reject(p_token text, p_account text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  delete from public.users where account = p_account;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_level(p_token text, p_account text, p_level int)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  update public.users set level = case when p_level = 1 then 1 else 2 end where account = p_account;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_toggle(p_token text, p_account text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; t public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  select * into t from public.users where account = p_account;
  if t.account is not null then
    update public.users set status = case when t.status = 'active' then 'disabled' else 'active' end where account = p_account;
    -- 停用即踢下线(否则旧 token 仍可用到过期)
    if t.status = 'active' then
      delete from public.sessions where account = p_account;
    end if;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_resetpwd(p_token text, p_account text, p_newpwd text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  if p_newpwd is null or length(p_newpwd) < 6 then return jsonb_build_object('ok', false, 'msg', '新密码至少 6 位'); end if;
  update public.users set pwd = crypt(p_newpwd, gen_salt('bf')), must_change_pwd = true where account = p_account;
  -- 改密后旧会话立即失效,要求用新密码重新登录
  delete from public.sessions where account = p_account;
  return jsonb_build_object('ok', true);
end $$;

-- 自助改密(任意登录用户):首登强制改密 / 日常改密都走这里
create or replace function public.change_pwd(p_token text, p_old text, p_new text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录'); end if;
  if u.pwd <> crypt(coalesce(p_old, ''), u.pwd) then
    return jsonb_build_object('ok', false, 'msg', '原密码不正确');
  end if;
  if p_new is null or length(p_new) < 6 then
    return jsonb_build_object('ok', false, 'msg', '新密码至少 6 位');
  end if;
  if p_new = p_old then return jsonb_build_object('ok', false, 'msg', '新密码不能与原密码相同'); end if;
  update public.users set pwd = crypt(p_new, gen_salt('bf')), must_change_pwd = false where account = u.account;
  -- 其它设备上的会话立即失效,当前会话保留
  delete from public.sessions where account = u.account and token <> p_token;
  return jsonb_build_object('ok', true);
end $$;

-- 管理员建号(仅1级):账号/姓名/初始密码/ROI等级/工具权限/车间
-- 新号 status=active、must_change_pwd=true(首次登录必须先改密)
create or replace function public.admin_create_user(p_token text, p_account text, p_name text, p_pwd text,
                                                   p_level int, p_tools jsonb, p_dept text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  p_account := trim(coalesce(p_account, ''));
  p_name := trim(coalesce(p_name, ''));
  if p_account = '' or p_name = '' then
    return jsonb_build_object('ok', false, 'msg', '请填写账号与姓名'); end if;
  if p_pwd is null or length(p_pwd) < 6 then
    return jsonb_build_object('ok', false, 'msg', '初始密码至少 6 位'); end if;
  if exists(select 1 from public.users where account = p_account) then
    return jsonb_build_object('ok', false, 'msg', '该账号已存在'); end if;
  if p_tools is null or jsonb_typeof(p_tools) <> 'array' then
    p_tools := '["roi"]'::jsonb; end if;
  insert into public.users (account, name, pwd, level, status, reg_time, tools, dept, must_change_pwd)
  values (p_account, p_name, crypt(p_pwd, gen_salt('bf')),
          case when p_level = 1 then 1 else 2 end, 'active',
          to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), p_tools, trim(coalesce(p_dept, '')), true);
  return jsonb_build_object('ok', true);
end $$;

-- 设置账号所属车间(仅1级;报修人靠它限定可报修的设备范围)
create or replace function public.admin_set_dept(p_token text, p_account text, p_dept text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  if not exists(select 1 from public.users where account = p_account) then
    return jsonb_build_object('ok', false, 'msg', '账号不存在'); end if;
  update public.users set dept = trim(coalesce(p_dept, '')) where account = p_account;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- 项目 ----------
create or replace function public.projects_list(p_token text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录'); end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('projects',
    coalesce((select jsonb_object_agg(x.name, x.data) from public.projects x), '{}'::jsonb)));
end $$;

create or replace function public.project_get(p_token text, p_name text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; p public.projects%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录'); end if;
  select * into p from public.projects where name = p_name;
  if p.name is null then return jsonb_build_object('ok', false, 'msg', '项目不存在'); end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('project', p.data));
end $$;

create or replace function public.project_save(p_token text, p_name text, p_project jsonb)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; exist public.projects%rowtype; is_owner boolean;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录'); end if;
  select * into exist from public.projects where name = p_name;
  if exist.name is not null then
    if u.level <> 1 then
      select exists (
        select 1 from jsonb_array_elements_text(coalesce(p_project -> 'owners', '[]'::jsonb)) o where o = u.name
      ) into is_owner;
      if not is_owner then return jsonb_build_object('ok', false, 'msg', '无权限修改该项目'); end if;
    end if;
  end if;
  insert into public.projects (name, data, saved_at)
  values (p_name, p_project, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
  on conflict (name) do update set data = excluded.data, saved_at = excluded.saved_at;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.project_delete(p_token text, p_name text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; exist public.projects%rowtype; is_owner boolean;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录'); end if;
  select * into exist from public.projects where name = p_name;
  if exist.name is null then return jsonb_build_object('ok', false, 'msg', '项目不存在'); end if;
  if u.level <> 1 then
    select exists (
      select 1 from jsonb_array_elements_text(coalesce(exist.data -> 'owners', '[]'::jsonb)) o where o = u.name
    ) into is_owner;
    if not is_owner then return jsonb_build_object('ok', false, 'msg', '无权限删除该项目'); end if;
  end if;
  delete from public.projects where name = p_name;
  return jsonb_build_object('ok', true);
end $$;

-- 赋予 RPC 调用权限(anon 只能调用函数,不能直接读表)
grant execute on function public._get_user_by_token(text) to anon;
grant execute on function public.init_admin() to anon;
grant execute on function public.login(text, text) to anon;
grant execute on function public.register(text, text, text, text) to anon;
grant execute on function public.me(text) to anon;
grant execute on function public.logout(text) to anon;
grant execute on function public.admin_users(text) to anon;
grant execute on function public.admin_audit(text, text, int) to anon;
grant execute on function public.admin_reject(text, text) to anon;
grant execute on function public.admin_level(text, text, int) to anon;
grant execute on function public.admin_toggle(text, text) to anon;
grant execute on function public.admin_resetpwd(text, text, text) to anon;
grant execute on function public.change_pwd(text, text, text) to anon;
grant execute on function public.admin_create_user(text, text, text, text, int, jsonb, text) to anon;
grant execute on function public.admin_set_dept(text, text, text) to anon;
grant execute on function public.projects_list(text) to anon;
grant execute on function public.project_get(text, text) to anon;
grant execute on function public.project_save(text, text, jsonb) to anon;
grant execute on function public.project_delete(text, text) to anon;

-- ---------- 账号修改/删除(仅1级;2026-10-13 增) ----------
-- 修改姓名/登录账号;同步会话表与项目负责人名单中的旧姓名
create or replace function public.admin_update_user(p_token text, p_account text, p_new_account text, p_new_name text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; t public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  select * into t from public.users where account = p_account;
  if t.account is null then return jsonb_build_object('ok', false, 'msg', '账号不存在'); end if;
  p_new_account := coalesce(nullif(trim(p_new_account), ''), t.account);
  p_new_name := coalesce(nullif(trim(p_new_name), ''), t.name);
  if p_new_account <> t.account and exists(select 1 from public.users where account = p_new_account) then
    return jsonb_build_object('ok', false, 'msg', '新账号已被占用');
  end if;
  update public.users set account = p_new_account, name = p_new_name where account = t.account;
  update public.sessions set account = p_new_account where account = t.account;
  if t.name <> p_new_name then
    update public.projects
    set data = jsonb_set(data, '{owners}',
      coalesce((select jsonb_agg(case when v#>>'{}' = t.name then to_jsonb(p_new_name) else v end)
        from jsonb_array_elements(data->'owners') v), data->'owners'))
    where data->'owners' @> to_jsonb(t.name)::jsonb;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- 删除账号(不可删自己与内置admin);会话一并清除,已有项目保留
create or replace function public.admin_delete_user(p_token text, p_account text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  if p_account = u.account then return jsonb_build_object('ok', false, 'msg', '不能删除自己的账号'); end if;
  if p_account = 'admin' then return jsonb_build_object('ok', false, 'msg', '不能删除内置管理员账号'); end if;
  if not exists(select 1 from public.users where account = p_account) then
    return jsonb_build_object('ok', false, 'msg', '账号不存在');
  end if;
  delete from public.sessions where account = p_account;
  delete from public.users where account = p_account;
  return jsonb_build_object('ok', true);
end $$;

grant execute on function public.admin_update_user(text, text, text, text) to anon;
grant execute on function public.admin_delete_user(text, text) to anon;

-- ============================================================
-- 设备履历卡(工具2;2026-10-20)
-- ============================================================

-- 1) 账号工具权限:["roi"] / ["roi","equipment"];老账号默认只有 roi,admin 全开
alter table public.users add column if not exists tools jsonb default '["roi"]'::jsonb;
update public.users set tools = '["roi"]'::jsonb where tools is null;
update public.users set tools = '["roi","equipment"]'::jsonb where account = 'admin';

-- 2) 设备表(一台设备一条,data jsonb 含档案+履历数组)
create table if not exists public.equipments (
  code text primary key,
  data jsonb not null,
  saved_at text,
  updated_by text
);
revoke all on public.equipments from anon, authenticated;

-- 3) 编辑留痕(服务端记录,客户端不可伪造)
create table if not exists public.equip_audit (
  id bigserial primary key,
  at text not null,
  account text not null,
  name text,
  code text not null,
  action text not null,
  summary text
);
revoke all on public.equip_audit from anon, authenticated;

-- 3.1) 工单号流水(按天递增,用于群里「报修 ↔ 完成」一一对应)
create table if not exists public.equip_seq (
  day text primary key,
  n int not null default 0
);
revoke all on public.equip_seq from anon, authenticated;

create or replace function public._equip_next_no()
returns text language plpgsql security definer as $$
declare d text; n int;
begin
  d := to_char(now(), 'YYMMDD');
  insert into public.equip_seq (day, n) values (d, 1)
  on conflict (day) do update set n = public.equip_seq.n + 1
  returning n into n;
  return 'WO' || d || '-' || lpad(n::text, 2, '0');
end $$;

-- 4) 查看编辑留痕(需登录)
create or replace function public.equipment_audit_list(p_token text, p_code text)
returns jsonb language plpgsql security definer as $$
declare cu public.users%rowtype;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录'); end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('logs', coalesce((
    select jsonb_agg(jsonb_build_object('at', a.at, 'account', a.account, 'name', a.name, 'action', a.action, 'summary', a.summary) order by a.id desc)
    from public.equip_audit a where a.code = p_code), '[]'::jsonb)));
end $$;

-- 5) 授予/取消工具权限(仅1级)
create or replace function public.admin_set_tools(p_token text, p_account text, p_tools jsonb)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  if p_tools is null or jsonb_typeof(p_tools) <> 'array' then return jsonb_build_object('ok', false, 'msg', '参数错误'); end if;
  update public.users set tools = p_tools where account = p_account;
  return jsonb_build_object('ok', true);
end $$;


-- ============================================================
-- 设备履历卡:脱敏视图(报修人 / 普通账号)
-- ============================================================

-- 报修人视图:只保留 报修日期/现象/状态/预计完成/完成日期
create or replace function public._mask_equip_report(p_data jsonb)
returns jsonb language plpgsql immutable as $$
declare recs jsonb; out_recs jsonb := '[]'::jsonb; r jsonb;
begin
  for r in select * from jsonb_array_elements(coalesce(p_data->'records', '[]'::jsonb)) loop
    out_recs := out_recs || jsonb_build_array(jsonb_build_object(
      'id', r->'id', 'no', r->'no', 'type', r->'type',
      'status', coalesce(r->'status', case when coalesce(r->>'doneAt','') <> '' then to_jsonb('done'::text) else to_jsonb('open'::text) end),
      'reportAt', r->'reportAt', 'expectedAt', r->'expectedAt',
      'doneAt', r->'doneAt', 'symptom', r->'symptom', 'place', r->'place',
      'updates', coalesce(r->'updates', '[]'::jsonb)));
  end loop;
  return jsonb_build_object(
    'code', p_data->'code', 'name', p_data->'name', 'number', p_data->'number',
    'line', p_data->'line', 'category', p_data->'category', 'status', p_data->'status',
    'records', out_recs);
end $$;

-- 普通账号视图:仅设备基本状况
create or replace function public._mask_equip_basic(p_data jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'code', p_data->'code', 'name', p_data->'name', 'number', p_data->'number',
    'line', p_data->'line', 'category', p_data->'category', 'status', p_data->'status');
$$;


-- ============================================================
-- 通知:企业微信群机器人(服务端 pg_net 直发) + 配置
-- ============================================================
create extension if not exists pg_net;

create table if not exists public.app_config (
  key text primary key,
  value text,
  updated_at text
);
revoke all on public.app_config from anon, authenticated;

create or replace function public._get_config(p_key text)
returns text language sql security definer stable as $$
  select value from public.app_config where key = p_key;
$$;

-- 仅1级可设置(webhook / 站点地址)
create or replace function public.admin_set_config(p_token text, p_key text, p_value text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  insert into public.app_config(key, value, updated_at)
  values (p_key, p_value, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
  return jsonb_build_object('ok', true);
end $$;

-- 读取配置(仅1级,用于设置页回显;不返回 webhook 明文以外的敏感项)
create or replace function public.admin_get_config(p_token text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'wx_webhook', coalesce(public._get_config('wx_webhook'), ''),
    'site_url', coalesce(public._get_config('site_url'), 'https://kekits.com/equipment/')));
end $$;

-- 内部:发企业微信消息(pg_net 异步,失败不影响业务)
create or replace function public._wx_send(p_content text)
returns void language plpgsql security definer as $$
declare hook text;
begin
  hook := public._get_config('wx_webhook');
  if hook is null or hook = '' then return; end if;
  perform net.http_post(
    url := hook,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('msgtype', 'markdown', 'markdown', jsonb_build_object('content', p_content))
  );
exception when others then
  null;
end $$;

grant execute on function public.admin_set_config(text, text, text) to anon;
grant execute on function public.admin_get_config(text) to anon;

-- ============================================================
-- 四档角色:admin(设备管理员) / repairer(维修人) / reporter(报修人) / view
-- ============================================================
create or replace function public._equip_role(p_token text)
returns text language sql security definer stable as $$
  select coalesce((
    select case
      when u.account = 'admin' then 'admin'
      when coalesce(u.tools,'[]'::jsonb) ? 'equipment-admin' then 'admin'
      when coalesce(u.tools,'[]'::jsonb) ? 'equipment' then 'repairer'
      when coalesce(u.tools,'[]'::jsonb) ? 'equipment-report' then 'reporter'
      else 'view' end
    from public.users u
    where u.account = (select s.account from public.sessions s
                       where s.token = p_token and s.exp > (extract(epoch from now()) * 1000)::bigint limit 1)
    limit 1), 'none');
$$;

-- 仅设备管理员可改档案/删设备;维修人只能处理工单
create or replace function public._can_edit_equipment(p_token text)
returns boolean language sql security definer stable as $$
  select public._equip_role(p_token) = 'admin';
$$;
create or replace function public._can_handle_equipment(p_token text)
returns boolean language sql security definer stable as $$
  select public._equip_role(p_token) in ('admin', 'repairer');
$$;

-- 车间字典(取自现有台账真实值,15 个;与前端 DEPTS 保持一致)
create or replace function public._equip_dept_list()
returns text[] language sql immutable as $$
  select array['冲压组','注塑部','水磨组','行政部','螺钉组','成装组','模具部','生管部',
               '砂房组','机加组','奈爱制造部','美容工具部','生技部','线割组','品管组'];
$$;

create or replace function public._equip_dept(p_token text)
returns text language sql security definer stable as $$
  select coalesce(trim(u.dept), '') from public.users u
  where u.account = (select s.account from public.sessions s
                     where s.token = p_token and s.exp > (extract(epoch from now()) * 1000)::bigint limit 1)
  limit 1;
$$;

-- 每车间一张「通用报修」归集卡(风扇/叉车/行政杂项等没有固定二维码的对象都报到这里)
-- 首次访问时自动建卡,幂等;返回该卡设备编号
create or replace function public._equip_ensure_generic(p_dept text)
returns text language plpgsql security definer as $$
declare d text := trim(coalesce(p_dept, '')); idx int; cd text; dat jsonb;
begin
  if d = '' then return ''; end if;
  idx := array_position(public._equip_dept_list(), d);
  if idx is null then
    cd := 'GEN-' || upper(substr(md5(d), 1, 6));
  else
    cd := 'GEN-D' || lpad(idx::text, 2, '0');
  end if;
  if exists(select 1 from public.equipments where code = cd) then return cd; end if;
  dat := jsonb_build_object(
    'code', cd, 'name', '通用报修 · ' || d, 'number', '', 'line', d,
    'category', 'misc', 'status', 'active', 'owner', '', 'model', '', 'vendor', '',
    'installDate', '', 'remark', '本车间通用报修入口(无固定二维码的设备与杂项)',
    'records', '[]'::jsonb, 'photos', '[]'::jsonb);
  insert into public.equipments (code, data, saved_at, updated_by)
  values (cd, dat, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), 'system')
  on conflict (code) do nothing;
  return cd;
end $$;

-- 报修人入口:本车间设备清单(脱敏为状态级)+ 本车间通用报修卡
-- 不返回其它车间设备(硬规则:不允许跨车间报修)
create or replace function public.equipment_my_list(p_token text)
returns jsonb language plpgsql security definer as $$
declare cu public.users%rowtype; role text; d text; gen text;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录'); end if;
  role := public._equip_role(p_token);
  if role <> 'reporter' then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  d := coalesce(trim(cu.dept), '');
  if d = '' then return jsonb_build_object('ok', false, 'msg', '账号未设置车间,请联系管理员'); end if;
  gen := public._equip_ensure_generic(d);
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'role', role, 'dept', d, 'generic', gen,
    'equipments', coalesce((
      select jsonb_object_agg(e.code, public._mask_equip_report(e.data))
      from public.equipments e
      where coalesce(e.data->>'line', '') = d), '{}'::jsonb)));
end $$;

create or replace function public.equipment_list(p_token text)
returns jsonb language plpgsql security definer as $$
declare cu public.users%rowtype; role text;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录'); end if;
  role := public._equip_role(p_token);
  if role not in ('admin', 'repairer') then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'role', role,
    'equipments', coalesce((select jsonb_object_agg(e.code, e.data) from public.equipments e), '{}'::jsonb)));
end $$;

create or replace function public.equipment_get(p_token text, p_code text)
returns jsonb language plpgsql security definer as $$
declare cu public.users%rowtype; role text; d jsonb;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录'); end if;
  role := public._equip_role(p_token);
  if role = 'none' then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  select e.data into d from public.equipments e where e.code = p_code;
  if d is null then return jsonb_build_object('ok', false, 'msg', '设备不存在'); end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'role', role,
    'equipment', case role
      when 'admin' then d
      when 'repairer' then d
      when 'reporter' then public._mask_equip_report(d)
      else public._mask_equip_basic(d) end));
end $$;

-- 保存:管理员可改档案;维修人只能改工单(档案字段必须不变)
create or replace function public.equipment_save(p_token text, p_code text, p_data jsonb, p_summary text)
returns jsonb language plpgsql security definer as $$
declare cu public.users%rowtype; old_data jsonb; role text; nr jsonb; oldr jsonb;
        msg text := ''; line_txt text; base text; link text; nm text; num text; ln text;
        d_done text; d_rep text; late int; who text; wo text; open_left int;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  role := public._equip_role(p_token);
  if role not in ('admin', 'repairer') then return jsonb_build_object('ok', false, 'msg', '无设备履历编辑权限'); end if;

  select e.data into old_data from public.equipments e where e.code = p_code;
  if role = 'repairer' then
    if old_data is null then
      return jsonb_build_object('ok', false, 'msg', '仅设备管理员可新增设备');
    end if;
    if (p_data - 'records') <> (old_data - 'records') then
      return jsonb_build_object('ok', false, 'msg', '维修人不能修改设备档案');
    end if;
    -- 故障分类/原因、维修类别、外协与费用、延期原因:只由设备管理员填写
    if exists (
      select 1
        from jsonb_array_elements(coalesce(p_data->'records', '[]'::jsonb)) n
        join jsonb_array_elements(coalesce(old_data->'records', '[]'::jsonb)) o
          on o->>'id' = n->>'id'
       where coalesce(n->>'cause1','')     <> coalesce(o->>'cause1','')
          or coalesce(n->>'cause2','')     <> coalesce(o->>'cause2','')
          or coalesce(n->>'cause3','')     <> coalesce(o->>'cause3','')
          or coalesce(n->>'cause','')      <> coalesce(o->>'cause','')
          or coalesce(n->>'handleType','') <> coalesce(o->>'handleType','')
          or coalesce(n->>'repairMode','') <> coalesce(o->>'repairMode','')
          or coalesce(n->>'supplier','')   <> coalesce(o->>'supplier','')
          or coalesce(n->>'cost','0')      <> coalesce(o->>'cost','0')
          or coalesce(n->>'delayReason','')<> coalesce(o->>'delayReason','')
    ) then
      return jsonb_build_object('ok', false, 'msg', '故障分类、维修类别、外协费用、延期原因由设备管理员填写');
    end if;
  end if;

  insert into public.equipments (code, data, saved_at, updated_by)
  values (p_code, p_data, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), cu.account)
  on conflict (code) do update set data = excluded.data, saved_at = excluded.saved_at, updated_by = excluded.updated_by;

  insert into public.equip_audit (at, account, name, code, action, summary)
  values (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), cu.account, cu.name, p_code, 'save', coalesce(p_summary, ''));

  base := coalesce(public._get_config('site_url'), 'https://kekits.com/equipment/');
  link := base || '?code=' || p_code;
  nm := coalesce(p_data->>'name', p_code);
  num := coalesce(nullif(p_data->>'number',''), p_code);
  ln := coalesce(p_data->>'line', '');
  -- 本设备保存后仍处于进行中的单数(用于提醒还有别的单没做)
  select count(*) into open_left from jsonb_array_elements(coalesce(p_data->'records', '[]'::jsonb)) x
  where coalesce(x->>'status','') <> 'done';
  for nr in select * from jsonb_array_elements(coalesce(p_data->'records', '[]'::jsonb)) loop
    if coalesce(nr->>'status','') = 'done' and coalesce(nr->>'reportAt','') <> '' then
      select o into oldr from jsonb_array_elements(coalesce(old_data->'records', '[]'::jsonb)) o
      where o->>'id' = nr->>'id' limit 1;
      if oldr is null or coalesce(oldr->>'status','') <> 'done' then
        d_done := coalesce(nr->>'doneAt','');
        d_rep := coalesce(nr->>'reportAt','');
        who := coalesce(nullif(nr->>'handler',''), cu.name);
        late := 0;
        if d_rep <> '' and coalesce(nr->>'expectedAt','') <> ''
           and d_done::date > (nr->>'expectedAt')::date then
          late := (d_done::date - (nr->>'expectedAt')::date);
        end if;
        wo := coalesce(nullif(nr->>'no',''), '');
        link := base || '?code=' || p_code || case when wo <> '' then ('&wo=' || wo) else '' end;
        line_txt := '**【已完成】' || case when wo <> '' then wo else (nm || ' ' || num) end || E'**\n'
          || case when wo <> '' then ('> 设备:' || nm || ' ' || num || case when ln <> '' then (' · ' || ln) else '' end || E'\n') else '' end
          || '> 现象:' || left(replace(coalesce(nr->>'symptom',''), E'\n', ' '), 60) || E'\n'
          || '> 处理人:' || who
          || case when d_rep <> '' then ('   报修 ' || d_rep || ' → 完成 ' || d_done) else ('   完成 ' || d_done) end
          || case when late > 0 then ('   延期 ' || late || ' 天') else '' end || E'\n'
          || '[▶ 查看设备](' || link || ')';
        msg := case when msg = '' then line_txt else (msg || E'\n\n' || line_txt) end;
      end if;
    end if;
  end loop;
  if msg <> '' and open_left > 0 then
    msg := msg || E'\n\n' || '> 该设备还有 ' || open_left || ' 单进行中,别忘了处理';
  end if;
  if msg <> '' then perform public._wx_send(msg); end if;

  return jsonb_build_object('ok', true);
end $$;

-- 报修:三种角色均可;预计完成由设备管理员后续设置(此处不写入)
-- 签名从 5 参改为 6 参(新增 p_place 设备位置,选填),旧函数必须显式删除
drop function if exists public.equipment_report(text, text, text, text, text);
create or replace function public.equipment_report(p_token text, p_code text, p_symptom text, p_expected text, p_reportby text, p_place text)
returns jsonb language plpgsql security definer as $$
declare cu public.users%rowtype; role text; d jsonb; recs jsonb; rec jsonb;
        base text; link text; msg text; nm text; ln text; num text; byname text; wo text; place_txt text;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  role := public._equip_role(p_token);
  if role not in ('admin', 'repairer', 'reporter') then return jsonb_build_object('ok', false, 'msg', '无报修权限'); end if;
  if coalesce(trim(p_symptom), '') = '' then return jsonb_build_object('ok', false, 'msg', '请填写故障现象'); end if;
  select e.data into d from public.equipments e where e.code = p_code;
  if d is null then return jsonb_build_object('ok', false, 'msg', '设备不存在'); end if;
  -- 硬规则:报修人只能报本车间的设备(管理员/维修人不限)
  if role = 'reporter' then
    if coalesce(trim(cu.dept), '') = '' then
      return jsonb_build_object('ok', false, 'msg', '账号未设置车间,请联系管理员');
    end if;
    if coalesce(d->>'line', '') <> trim(cu.dept) then
      return jsonb_build_object('ok', false, 'msg', '只能报修本车间(' || trim(cu.dept) || ')的设备');
    end if;
  end if;

  byname := coalesce(nullif(trim(p_reportby), ''), cu.name);
  place_txt := coalesce(trim(p_place), '');
  wo := public._equip_next_no();
  rec := jsonb_build_object(
    'id', 'r' || (extract(epoch from clock_timestamp()) * 1000)::bigint,
    'no', wo,
    'type', 'fault', 'status', 'open',
    'reportAt', to_char(now(), 'YYYY-MM-DD'),
    'reportBy', byname,
    'place', place_txt,
    'expectedAt', '', 'doneAt', '', 'handler', '',
    'symptom', p_symptom,
    'cause1', '', 'cause2', '', 'cause3', '', 'cause', '', 'action', '', 'handleType', '',
    'repairMode', 'inner', 'supplier', '', 'parts', '[]'::jsonb, 'cost', 0,
    'delayReason', '', 'remark', '', 'photos', '[]'::jsonb,
    'createdAt', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), 'createdBy', cu.name);
  recs := coalesce(d->'records', '[]'::jsonb) || jsonb_build_array(rec);
  d := jsonb_set(d, '{records}', recs);
  update public.equipments set data = d, saved_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), updated_by = cu.account where code = p_code;
  insert into public.equip_audit (at, account, name, code, action, summary)
  values (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), cu.account, cu.name, p_code, 'report', '报修:' || left(p_symptom, 30));

  base := coalesce(public._get_config('site_url'), 'https://kekits.com/equipment/');
  link := base || '?code=' || p_code || case when wo <> '' then ('&wo=' || wo) else '' end;
  nm := coalesce(d->>'name', p_code);
  ln := coalesce(d->>'line', '');
  num := coalesce(nullif(d->>'number',''), p_code);
  msg := '**【新报修】' || wo || E'**\n'
      || '> 设备:' || nm || ' ' || num || case when ln <> '' then (' · ' || ln) else '' end || E'\n'
      || case when place_txt <> '' then ('> 位置:' || replace(place_txt, E'\n', ' ') || E'\n') else '' end
      || '> 现象:' || replace(p_symptom, E'\n', ' ') || E'\n'
      || '> 报修人:' || byname || '   ' || to_char(now(), 'MM-DD HH24:MI') || E'\n'
      || '[▶ 去处理](' || link || ')';
  perform public._wx_send(msg);

  return jsonb_build_object('ok', true, 'no', wo);
end $$;

-- 回应报修:管理员/维修人。暂时修不完时先给个说法,工单保持进行中,
-- 群里推一条【进度】(同一个工单号),报修人打开设备页也能看到。
create or replace function public.equipment_reply(p_token text, p_code text, p_record_id text, p_text text, p_expected text)
returns jsonb language plpgsql security definer as $$
declare cu public.users%rowtype; role text; d jsonb; recs jsonb := '[]'::jsonb; r jsonb;
        hit boolean := false; base text; link text; msg text; nm text; num text; ln text;
        wo text; at_txt text; upd jsonb;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  role := public._equip_role(p_token);
  if role not in ('admin', 'repairer') then return jsonb_build_object('ok', false, 'msg', '无回应权限'); end if;
  if coalesce(trim(p_text), '') = '' then return jsonb_build_object('ok', false, 'msg', '请填写回应内容'); end if;
  select e.data into d from public.equipments e where e.code = p_code;
  if d is null then return jsonb_build_object('ok', false, 'msg', '设备不存在'); end if;

  at_txt := to_char(now(), 'YYYY-MM-DD HH24:MI');
  upd := jsonb_build_object('at', at_txt, 'by', cu.name, 'text', trim(p_text));

  for r in select * from jsonb_array_elements(coalesce(d->'records', '[]'::jsonb)) loop
    if (r->>'id') = p_record_id then
      if coalesce(r->>'status', case when coalesce(r->>'doneAt','') <> '' then 'done' else 'open' end) = 'done' then
        return jsonb_build_object('ok', false, 'msg', '该工单已完成,无需回应');
      end if;
      r := jsonb_set(r, '{updates}', coalesce(r->'updates', '[]'::jsonb) || jsonb_build_array(upd));
      -- 预计完成只有设备管理员能改
      if coalesce(p_expected, '') <> '' and role = 'admin' then
        r := jsonb_set(r, '{expectedAt}', to_jsonb(p_expected));
      end if;
      hit := true;
    end if;
    recs := recs || jsonb_build_array(r);
  end loop;
  if not hit then return jsonb_build_object('ok', false, 'msg', '工单不存在'); end if;

  update public.equipments
     set data = jsonb_set(d, '{records}', recs),
         saved_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
         updated_by = cu.account
   where code = p_code;
  insert into public.equip_audit (at, account, name, code, action, summary)
  values (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), cu.account, cu.name, p_code, 'reply', '回应:' || left(trim(p_text), 30));

  base := coalesce(public._get_config('site_url'), 'https://kekits.com/equipment/');
  nm := coalesce(d->>'name', p_code);
  num := coalesce(nullif(d->>'number',''), p_code);
  ln := coalesce(d->>'line', '');
  select o->>'no' into wo from jsonb_array_elements(recs) o where o->>'id' = p_record_id limit 1;
  link := base || '?code=' || p_code || case when coalesce(wo,'') <> '' then ('&wo=' || wo) else '' end;
  msg := '**【进度】' || case when coalesce(wo,'') <> '' then wo else (nm || ' ' || num) end || E'**\n'
      || '> 设备:' || nm || ' ' || num || case when ln <> '' then (' · ' || ln) else '' end || E'\n'
      || '> 说明:' || replace(trim(p_text), E'\n', ' ') || E'\n'
      || '> 回复人:' || cu.name || '   ' || to_char(now(), 'MM-DD HH24:MI') || E'\n'
      || '[▶ 查看设备](' || link || ')';
  perform public._wx_send(msg);

  return jsonb_build_object('ok', true, 'update', upd);
end $$;

-- 删除设备:仅设备管理员
create or replace function public.equipment_delete(p_token text, p_code text)
returns jsonb language plpgsql security definer as $$
declare cu public.users%rowtype;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if public._equip_role(p_token) <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅设备管理员可删除设备'); end if;
  delete from public.equipments where code = p_code;
  insert into public.equip_audit (at, account, name, code, action, summary)
  values (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), cu.account, cu.name, p_code, 'delete', '删除设备');
  return jsonb_build_object('ok', true);
end $$;

-- ============================================================
-- 授权(所有业务函数最后统一授予 anon,函数体内自行校验 token)
-- ============================================================
grant execute on function public.equipment_list(text) to anon;
grant execute on function public.equipment_my_list(text) to anon;
grant execute on function public.equipment_get(text, text) to anon;
grant execute on function public.equipment_save(text, text, jsonb, text) to anon;
grant execute on function public.equipment_report(text, text, text, text, text, text) to anon;
grant execute on function public.equipment_reply(text, text, text, text, text) to anon;
grant execute on function public.equipment_delete(text, text) to anon;
grant execute on function public.equipment_audit_list(text, text) to anon;
grant execute on function public.admin_set_tools(text, text, jsonb) to anon;
grant execute on function public.admin_set_config(text, text, text) to anon;
grant execute on function public.admin_get_config(text) to anon;
