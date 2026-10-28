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

-- ---------- 账号管理(仅固定 admin 账号;ROI 1级不含管理权) ----------
create or replace function public.admin_users(p_token text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  -- 账户管理/全量备份恢复只属于固定 admin 账号,与 ROI 等级无关。
  if u.account <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅 admin 账号可操作'); end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('users',
    coalesce((select jsonb_object_agg(x.account, jsonb_build_object('account', x.account, 'name', x.name, 'level', x.level, 'status', x.status, 'reg_time', x.reg_time, 'tools', coalesce(x.tools, '["roi"]'::jsonb), 'dept', coalesce(x.dept, ''), 'must_change_pwd', coalesce(x.must_change_pwd, false))) from public.users x), '{}'::jsonb)));
end $$;

create or replace function public.admin_audit(p_token text, p_account text, p_level int)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  -- 账户管理/全量备份恢复只属于固定 admin 账号,与 ROI 等级无关。
  if u.account <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅 admin 账号可操作'); end if;
  if p_account = 'admin' and p_level is distinct from 1 then
    return jsonb_build_object('ok', false, 'msg', 'admin 固定为 1 级');
  end if;
  -- ROI 等级三档:0=无权限 / 1=全量 / 2=仅本人项目(其它值一律按 2 处理)
  update public.users set status = 'active', level = case when p_level in (0, 1) then p_level else 2 end where account = p_account;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_reject(p_token text, p_account text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  -- 账户管理/全量备份恢复只属于固定 admin 账号,与 ROI 等级无关。
  if u.account <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅 admin 账号可操作'); end if;
  if p_account = 'admin' then return jsonb_build_object('ok', false, 'msg', '不能驳回内置管理员账号'); end if;
  delete from public.users where account = p_account;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_level(p_token text, p_account text, p_level int)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  -- 账户管理/全量备份恢复只属于固定 admin 账号,与 ROI 等级无关。
  if u.account <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅 admin 账号可操作'); end if;
  if p_account = 'admin' and p_level is distinct from 1 then
    return jsonb_build_object('ok', false, 'msg', 'admin 固定为 1 级');
  end if;
  update public.users set level = case when p_level in (0, 1) then p_level else 2 end where account = p_account;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_toggle(p_token text, p_account text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; t public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  -- 账户管理/全量备份恢复只属于固定 admin 账号,与 ROI 等级无关。
  if u.account <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅 admin 账号可操作'); end if;
  if p_account = 'admin' then return jsonb_build_object('ok', false, 'msg', '不能停用内置管理员账号'); end if;
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
  -- 账户管理/全量备份恢复只属于固定 admin 账号,与 ROI 等级无关。
  if u.account <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅 admin 账号可操作'); end if;
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

-- 管理员建号(仅 admin):账号/姓名/初始密码/ROI等级/工具权限/车间
-- 新号 status=active、must_change_pwd=true(首次登录必须先改密)
create or replace function public.admin_create_user(p_token text, p_account text, p_name text, p_pwd text,
                                                   p_level int, p_tools jsonb, p_dept text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  -- 账户管理/全量备份恢复只属于固定 admin 账号,与 ROI 等级无关。
  if u.account <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅 admin 账号可操作'); end if;
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
          case when p_level in (0, 1) then p_level else 2 end, 'active',
          to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), p_tools, trim(coalesce(p_dept, '')), true);
  return jsonb_build_object('ok', true);
end $$;

-- 设置账号所属车间(仅 admin;报修人靠它限定可报修的设备范围)
create or replace function public.admin_set_dept(p_token text, p_account text, p_dept text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  -- 账户管理/全量备份恢复只属于固定 admin 账号,与 ROI 等级无关。
  if u.account <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅 admin 账号可操作'); end if;
  if not exists(select 1 from public.users where account = p_account) then
    return jsonb_build_object('ok', false, 'msg', '账号不存在'); end if;
  update public.users set dept = trim(coalesce(p_dept, '')) where account = p_account;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- 项目 ----------
-- ROI 权限判定(三档):'none'=无权限(level=0) / 'own'=仅本人项目(level=2) / 'all'=全量(level=1)
-- level=0 以前只被前端游客使用;真账号用 0 表示「ROI 无权限」,两者都拿不到任何项目数据。
create or replace function public._roi_role(p_token text)
returns text language plpgsql security definer stable as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return 'none'; end if;
  if u.level = 1 then return 'all'; end if;
  if coalesce(u.level, 2) = 0 then return 'none'; end if;
  return 'own';
end $$;

create or replace function public.projects_list(p_token text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录'); end if;
  if public._roi_role(p_token) = 'none' then
    return jsonb_build_object('ok', false, 'msg', '无 ROI 权限,请联系管理员开通'); end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('projects',
    coalesce((select jsonb_object_agg(x.name, x.data) from public.projects x), '{}'::jsonb)));
end $$;

create or replace function public.project_get(p_token text, p_name text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; p public.projects%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录'); end if;
  if public._roi_role(p_token) = 'none' then
    return jsonb_build_object('ok', false, 'msg', '无 ROI 权限,请联系管理员开通'); end if;
  select * into p from public.projects where name = p_name;
  if p.name is null then return jsonb_build_object('ok', false, 'msg', '项目不存在'); end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('project', p.data));
end $$;

create or replace function public.project_save(p_token text, p_name text, p_project jsonb)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; exist public.projects%rowtype; is_owner boolean; rk text;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录'); end if;
  rk := public._roi_role(p_token);
  if rk = 'none' then return jsonb_build_object('ok', false, 'msg', '无 ROI 权限,请联系管理员开通'); end if;
  select * into exist from public.projects where name = p_name;
  if exist.name is not null then
    if rk <> 'all' then
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
declare u public.users%rowtype; exist public.projects%rowtype; is_owner boolean; rk text;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录'); end if;
  rk := public._roi_role(p_token);
  if rk = 'none' then return jsonb_build_object('ok', false, 'msg', '无 ROI 权限,请联系管理员开通'); end if;
  select * into exist from public.projects where name = p_name;
  if exist.name is null then return jsonb_build_object('ok', false, 'msg', '项目不存在'); end if;
  if rk <> 'all' then
    select exists (
      select 1 from jsonb_array_elements_text(coalesce(exist.data -> 'owners', '[]'::jsonb)) o where o = u.name
    ) into is_owner;
    if not is_owner then return jsonb_build_object('ok', false, 'msg', '无权限删除该项目'); end if;
  end if;
  -- 回收站:删前存快照(恢复权限另判:1 级全部 / 2 级仅本人删的)
  perform public._trash_push('project', p_name, p_name, to_jsonb(exist), u.account, u.name);
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
grant execute on function public._roi_role(text) to anon;
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
  -- 账户管理/全量备份恢复只属于固定 admin 账号,与 ROI 等级无关。
  if u.account <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅 admin 账号可操作'); end if;
  select * into t from public.users where account = p_account;
  if t.account is null then return jsonb_build_object('ok', false, 'msg', '账号不存在'); end if;
  p_new_account := coalesce(nullif(trim(p_new_account), ''), t.account);
  p_new_name := coalesce(nullif(trim(p_new_name), ''), t.name);
  if t.account = 'admin' and p_new_account <> 'admin' then
    return jsonb_build_object('ok', false, 'msg', '内置管理员登录账号固定为 admin,不能改名');
  end if;
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

-- 删除账号(仅 admin;不可删自己与内置admin);会话一并清除,已有项目保留
create or replace function public.admin_delete_user(p_token text, p_account text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  -- 账户管理/全量备份恢复只属于固定 admin 账号,与 ROI 等级无关。
  if u.account <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅 admin 账号可操作'); end if;
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

-- 3.2) 回收站(2026-10-22):删除设备/工单/项目时先存快照,30 天后清理
--      kind = equipment(设备,含全部工单) / record(单条工单) / project(ROI 项目)
--      ref_key: equipment/record 存设备号,project 存项目名
create table if not exists public.recycle_bin (
  id bigserial primary key,
  kind text not null,
  ref_key text not null default '',
  label text not null default '',
  snapshot jsonb not null,
  deleted_at text not null default '',
  deleted_by text not null default '',
  deleted_by_name text not null default '',
  purge_at text not null default ''
);
revoke all on public.recycle_bin from anon, authenticated;
create index if not exists recycle_bin_kind_idx on public.recycle_bin (kind, deleted_at desc);

create or replace function public._equip_next_no()
returns text language plpgsql security definer as $$
declare
  v_day text;
  v_n int;
begin
  v_day := to_char(now(), 'YYMMDD');
  insert into public.equip_seq as s (day, n) values (v_day, 1)
  on conflict (day) do update set n = s.n + 1
  returning s.n into v_n;
  return 'WO' || v_day || '-' || lpad(v_n::text, 2, '0');
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
  -- 账户管理/全量备份恢复只属于固定 admin 账号,与 ROI 等级无关。
  if u.account <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅 admin 账号可操作'); end if;
  if p_tools is null or jsonb_typeof(p_tools) <> 'array' then return jsonb_build_object('ok', false, 'msg', '参数错误'); end if;
  update public.users set tools = p_tools where account = p_account;
  return jsonb_build_object('ok', true);
end $$;


-- ============================================================
-- 设备履历卡:脱敏视图(报修人 / 普通账号)
-- ============================================================

-- 报修人视图:只保留 报修日期/现象/状态/预计完成/完成日期
-- family(设备类别)也要给:报修人列表按类别分组/搜索都要用,且它只是类别名,不含敏感信息
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
      'updates', coalesce(r->'updates', '[]'::jsonb),
      'supplements', coalesce((select jsonb_agg(jsonb_build_object('at', s->'at', 'by', s->'by', 'text', s->'text') order by ord)
        from jsonb_array_elements(case when jsonb_typeof(r->'_supplements') = 'array'
          then r->'_supplements' else '[]'::jsonb end) with ordinality a(s, ord)), '[]'::jsonb),
      'corrections', coalesce((select jsonb_agg(jsonb_build_object(
        'at', c->'at', 'by', c->'by', 'summary', c->'summary', 'reason', c->'reason',
        'fromCode', c->'fromCode', 'toCode', c->'toCode'))
        from jsonb_array_elements(case when jsonb_typeof(r->'_corrections') = 'array'
          then r->'_corrections' else '[]'::jsonb end) c), '[]'::jsonb)));
  end loop;
  return jsonb_build_object(
    'code', p_data->'code', 'name', p_data->'name', 'number', p_data->'number',
    'line', p_data->'line', 'category', p_data->'category', 'status', p_data->'status',
    'family', coalesce(p_data->'family', to_jsonb(''::text)),
    'records', out_recs);
end $$;

-- 普通账号视图:仅设备基本状况
create or replace function public._mask_equip_basic(p_data jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'code', p_data->'code', 'name', p_data->'name', 'number', p_data->'number',
    'line', p_data->'line', 'category', p_data->'category', 'status', p_data->'status');
$$;

-- 消息里显示的设备名:名称 + 编号;没有编号才补车间，且名称里已含车间就不重复
-- 例:双面磨 PS04-70 / 通用报修 · 成装组 / 风扇 · 水磨组
create or replace function public._equip_label(p_data jsonb)
returns text language sql immutable as $$
  select case
    when coalesce(p_data->>'number', '') <> '' then
      coalesce(p_data->>'name', '') || ' ' || (p_data->>'number')
    when coalesce(p_data->>'line', '') <> ''
         and position((p_data->>'line') in coalesce(p_data->>'name', '')) = 0 then
      coalesce(p_data->>'name', '') || ' · ' || (p_data->>'line')
    else coalesce(p_data->>'name', '')
  end;
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

-- ============================================================
-- 设备类别排序(置顶 + 自定义顺序) —— 分部门存,app_config
-- 结构:{"":[全部部门那套], "冲压组":[冲压组那套], ...}
--       每套是 [{"n":"冲床/精冲","pin":true}, ...]
--       数组顺序即显示顺序;pin=true 的固定排在未置顶的前面。
-- 生效规则(前端 _equip_gorder_effective):
--       选中某部门时 = 本部门那套 + 「全部部门」里本部门没排过的
--       选「全部部门」时 = 只有「全部部门」那套
-- 读:任何已登录账号;写:仅设备管理员
-- ============================================================
create or replace function public.equip_group_order_get(p_token text)
returns jsonb language plpgsql security definer as $$
declare v text; j jsonb;
begin
  if public._equip_role(p_token) = 'none' then
    return jsonb_build_object('ok', false, 'msg', '未登录或无权限');
  end if;
  v := public._get_config('equip_group_order');
  if v is null or trim(v) = '' then
    return jsonb_build_object('ok', true, 'data', '{}'::jsonb);
  end if;
  begin
    j := v::jsonb;
  exception when others then
    return jsonb_build_object('ok', true, 'data', '{}'::jsonb);
  end;
  -- 老数据是纯数组(全公司一套),包成「全部部门」那一套
  if jsonb_typeof(j) = 'array' then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object('', j));
  end if;
  if jsonb_typeof(j) <> 'object' then
    return jsonb_build_object('ok', true, 'data', '{}'::jsonb);
  end if;
  return jsonb_build_object('ok', true, 'data', j);
end $$;

create or replace function public.equip_group_order_set(p_token text, p_data jsonb)
returns jsonb language plpgsql security definer as $$
declare raw jsonb; obj jsonb;
begin
  if not public._can_edit_equipment(p_token) then
    return jsonb_build_object('ok', false, 'msg', '仅设备管理员可调整类别顺序');
  end if;
  raw := coalesce(p_data, '{}'::jsonb);
  if jsonb_typeof(raw) = 'array' then
    raw := jsonb_build_object('', raw);          -- 兼容旧的单套格式
  elsif jsonb_typeof(raw) <> 'object' then
    return jsonb_build_object('ok', false, 'msg', '格式错误:需要对象');
  end if;
  -- 只保留「值是非空数组」的键,空的那套视为没排(回退到默认规则)
  obj := coalesce((
    select jsonb_object_agg(e.k, e.v)
    from jsonb_each(raw) e(k, v)
    where jsonb_typeof(e.v) = 'array' and jsonb_array_length(e.v) > 0
  ), '{}'::jsonb);
  insert into public.app_config(key, value, updated_at)
  values ('equip_group_order', obj::text, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
  return jsonb_build_object('ok', true, 'n', (select count(*) from jsonb_object_keys(obj)));
end $$;

grant execute on function public.equip_group_order_get(text) to anon;
grant execute on function public.equip_group_order_set(text, jsonb) to anon;

-- ============================================================
-- 设备类别改名(连带该类别下全部设备的 family 一起改)
--   仅设备管理员可用。
--   允许改成「已经存在的类别名」= 合并两类,返回 merged=true 与那类原有台数。
--   排序配置 equip_group_order 里所有部门的旧名一并改掉,同名项合并去重
--   (位置取第一次出现,pin 取或),保证改名后置顶/顺序不乱。
-- ============================================================
create or replace function public.equip_cat_rename(p_token text, p_old text, p_new text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
        o text; nn text;
        v text; j jsonb; obj jsonb; k text; arr jsonb;
        mapped jsonb; names jsonb; seen jsonb; merged jsonb; it jsonb; nm text;
        n int := 0; hit int := 0;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if public._equip_role(p_token) <> 'admin' then
    return jsonb_build_object('ok', false, 'msg', '仅设备管理员可改类别名');
  end if;
  o := trim(coalesce(p_old, ''));
  nn := trim(coalesce(p_new, ''));
  if o = '' then return jsonb_build_object('ok', false, 'msg', '原类别名不能为空'); end if;
  if nn = '' then return jsonb_build_object('ok', false, 'msg', '新类别名不能为空'); end if;
  if nn = o then return jsonb_build_object('ok', false, 'msg', '新旧类别名相同'); end if;
  if length(nn) > 40 then return jsonb_build_object('ok', false, 'msg', '类别名最多 40 个字'); end if;

  -- 目标名已存在的台数(>0 说明这是合并)
  select count(*) into hit from public.equipments e
   where coalesce(e.data->>'family', '') = nn;

  -- 1) 逐台留痕(记下改名前后,便于回溯)
  insert into public.equip_audit (at, account, name, code, action, summary)
  select to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), u.account, u.name, e.code, 'save',
         '设备类别改名：' || o || ' → ' || nn
    from public.equipments e
   where coalesce(e.data->>'family', '') = o;

  -- 2) 改档案(只动 family,履历原样保留)
  update public.equipments e
     set data = jsonb_set(e.data, '{family}', to_jsonb(nn), true),
         saved_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
         updated_by = u.account
   where coalesce(e.data->>'family', '') = o;
  get diagnostics n = row_count;

  -- 3) 排序配置:所有部门那几套里的旧名一起改,同名合并去重
  v := public._get_config('equip_group_order');
  if v is not null and trim(v) <> '' then
    begin
      j := v::jsonb;
    exception when others then
      j := null;                       -- 配置坏了就不动它,免得整段报错
    end;
    if j is not null and jsonb_typeof(j) = 'array' then
      j := jsonb_build_object('', j);  -- 兼容老的「全公司一套」格式
    end if;
    if j is not null and jsonb_typeof(j) = 'object' then
      obj := '{}'::jsonb;
      for k, arr in select e3.key, e3.value from jsonb_each(j) e3
                   where jsonb_typeof(e3.value) = 'array' loop
        -- 3.1 旧名换成新名
        mapped := '[]'::jsonb;
        for it in select y from jsonb_array_elements(arr) y loop
          nm := trim(coalesce(it->>'n', ''));
          if nm = '' then continue; end if;
          if nm = o then nm := nn; end if;
          mapped := mapped || jsonb_build_array(
            jsonb_build_object('n', nm, 'pin', coalesce((it->>'pin')::boolean, false)));
        end loop;
        -- 3.2 去重:同名只留一条,位置取第一次出现,pin 取或
        names := '[]'::jsonb; seen := '{}'::jsonb;
        for it in select y from jsonb_array_elements(mapped) y loop
          nm := it->>'n';
          if seen ? nm then
            if coalesce((it->>'pin')::boolean, false) then
              seen := seen || jsonb_build_object(nm, true);
            end if;
          else
            seen := seen || jsonb_build_object(nm, coalesce((it->>'pin')::boolean, false));
            names := names || jsonb_build_array(to_jsonb(nm));
          end if;
        end loop;
        -- 3.3 还原成 [{n,pin}, ...]
        merged := '[]'::jsonb;
        for nm in select jsonb_array_elements_text(names) loop
          merged := merged || jsonb_build_array(
            jsonb_build_object('n', nm, 'pin', coalesce((seen->>nm)::boolean, false)));
        end loop;
        if jsonb_array_length(merged) > 0 then
          obj := obj || jsonb_build_object(k, merged);
        end if;
      end loop;
      insert into public.app_config (key, value, updated_at)
      values ('equip_group_order', obj::text, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'n', n, 'merged', hit > 0, 'merged_n', hit);
end $$;

grant execute on function public.equip_cat_rename(text, text, text) to anon;

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

-- 更正报修:只改一条工单的现象/位置/归属,两端在同一事务内完成。
-- 报修人可更正本车间任意未完成单;设备管理员含已完成;维修人不新增权限。
create or replace function public.equipment_report_correct(
  p_token text, p_code text, p_record_id text, p_target_code text,
  p_symptom text, p_place text, p_reason text, p_expected jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare cu public.users%rowtype; role text; src jsonb; dst jsonb; rec jsonb; changed jsonb;
        src_recs jsonb; dst_recs jsonb; matches int; at_txt text; summary text; entry jsonb;
        symptom_txt text; place_txt text; reason_txt text; moved boolean; out_eq jsonb;
        ws text := U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  role := public._equip_role(p_token);
  if role not in ('admin', 'reporter') then
    return jsonb_build_object('ok', false, 'msg', '仅设备管理员和报修人可更正报修');
  end if;
  if coalesce(p_code, '') = '' or coalesce(p_target_code, '') = '' or coalesce(p_record_id, '') = '' then
    return jsonb_build_object('ok', false, 'msg', '请选择原工单和目标设备');
  end if;
  symptom_txt := btrim(coalesce(p_symptom, ''), ws);
  place_txt := btrim(coalesce(p_place, ''), ws);
  reason_txt := btrim(coalesce(p_reason, ''), ws);
  if symptom_txt = '' then return jsonb_build_object('ok', false, 'msg', '请填写故障现象'); end if;
  if place_txt = '' then return jsonb_build_object('ok', false, 'msg', '请填写设备位置'); end if;
  if jsonb_typeof(p_expected) is distinct from 'object'
     or not (p_expected ? 'symptom' and p_expected ? 'place')
     or jsonb_typeof(p_expected->'symptom') is distinct from 'string'
     or jsonb_typeof(p_expected->'place') is distinct from 'string' then
    return jsonb_build_object('ok', false, 'msg', '请重新打开更正页面后提交');
  end if;

  -- 固定加锁顺序,避免相反方向迁移死锁;校验和两端写入均在锁内。
  perform e.code from public.equipments e
   where e.code in (p_code, p_target_code) order by e.code for update;
  select e.data into src from public.equipments e where e.code = p_code;
  select e.data into dst from public.equipments e where e.code = p_target_code;
  if src is null or dst is null then return jsonb_build_object('ok', false, 'msg', '原设备或目标设备不存在，请刷新'); end if;
  if role = 'reporter' then
    if coalesce(trim(cu.dept), '') = ''
       or coalesce(src->>'line', '') <> trim(cu.dept)
       or coalesce(dst->>'line', '') <> trim(cu.dept) then
      return jsonb_build_object('ok', false, 'msg', '只能更正和转入本车间的设备');
    end if;
  end if;
  select count(*) into matches from jsonb_array_elements(coalesce(src->'records', '[]'::jsonb)) r
   where r->>'id' = p_record_id;
  if matches <> 1 then return jsonb_build_object('ok', false, 'msg', '工单不存在、已移动或编号重复，请刷新'); end if;
  select r into rec from jsonb_array_elements(src->'records') r where r->>'id' = p_record_id;
  if role = 'reporter' and (coalesce(rec->>'status', '') = 'done' or coalesce(rec->>'doneAt', '') <> '') then
    return jsonb_build_object('ok', false, 'msg', '已完成工单仅设备管理员可更正');
  end if;
  if coalesce(rec->>'symptom', '') is distinct from coalesce(p_expected->>'symptom', '')
     or coalesce(rec->>'place', '') is distinct from coalesce(p_expected->>'place', '') then
    return jsonb_build_object('ok', false, 'msg', '报修信息已被更正，请刷新后重试');
  end if;
  moved := p_code <> p_target_code;
  if exists (
    select 1 from jsonb_array_elements(coalesce(dst->'records', '[]'::jsonb)) r
     where (moved or r->>'id' is distinct from p_record_id)
       and (r->>'id' = p_record_id
         or (coalesce(btrim(rec->>'no'), '') <> '' and r->>'no' = rec->>'no'))) then
    return jsonb_build_object('ok', false, 'msg', '目标设备已有相同工单，请刷新核对，未移动');
  end if;
  if not moved and symptom_txt = coalesce(rec->>'symptom','') and place_txt = coalesce(rec->>'place','') then
    return jsonb_build_object('ok', false, 'msg', '没有需要保存的更正');
  end if;

  at_txt := to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS');
  summary := '更正报修 ' || coalesce(nullif(rec->>'no', ''), p_record_id)
    || case when moved then ('：' || p_code || ' → ' || p_target_code) else ('：原设备 ' || p_code) end
    || case when symptom_txt <> coalesce(rec->>'symptom','') then '；修改现象' else '' end
    || case when place_txt <> coalesce(rec->>'place','') then '；修改位置' else '' end;
  entry := jsonb_build_object('at', at_txt, 'account', cu.account, 'by', cu.name,
    'fromCode', p_code, 'fromName', src->>'name', 'fromDept', src->>'line',
    'fromFamily', src->>'family', 'fromRecordName', rec->'devName', 'fromRecordFamily', rec->'family',
    'toCode', p_target_code, 'toName', dst->>'name', 'toDept', dst->>'line',
    'oldSymptom', rec->>'symptom', 'oldPlace', rec->>'place',
    'newSymptom', symptom_txt, 'newPlace', place_txt, 'reason', reason_txt, 'summary', summary);
  -- 不重建记录:原工单号/id/日期/处理/费用/照片/进度及未知字段全部保留。
  changed := rec || jsonb_build_object('symptom', symptom_txt, 'place', place_txt,
    'updatedAt', at_txt, 'updatedBy', cu.name,
    '_corrections', (case when jsonb_typeof(rec->'_corrections') = 'array' then rec->'_corrections' else '[]'::jsonb end) || jsonb_build_array(entry));
  -- 通用报修卡只是收纳入口,不能用“通用报修”覆盖历史具体物件提示。
  if moved and left(p_target_code, 4) <> 'GEN-' then
    if rec ? 'devName' then changed := changed || jsonb_build_object('devName', coalesce(dst->>'name', '')); end if;
    if rec ? 'family' then changed := changed || jsonb_build_object('family', coalesce(dst->>'family', '')); end if;
  end if;
  if moved then
    select coalesce(jsonb_agg(r order by ord), '[]'::jsonb) into src_recs
      from jsonb_array_elements(src->'records') with ordinality a(r, ord) where r->>'id' is distinct from p_record_id;
    dst_recs := coalesce(dst->'records', '[]'::jsonb) || jsonb_build_array(changed);
  else
    select jsonb_agg(case when r->>'id' = p_record_id then changed else r end order by ord) into src_recs
      from jsonb_array_elements(src->'records') with ordinality a(r, ord);
  end if;
  -- 只给触达设备启用乐观版本,防止仍打开的旧整包编辑页把工单移回/覆盖。
  src := jsonb_set(src, '{records}', src_recs) || jsonb_build_object('_recordsRev', gen_random_uuid()::text);
  update public.equipments set data = src, saved_at = at_txt, updated_by = cu.account where code = p_code;
  if moved then
    dst := jsonb_set(dst, '{records}', dst_recs) || jsonb_build_object('_recordsRev', gen_random_uuid()::text);
    update public.equipments set data = dst, saved_at = at_txt, updated_by = cu.account where code = p_target_code;
  else dst := src;
  end if;
  insert into public.equip_audit (at, account, name, code, action, summary)
    values (at_txt, cu.account, cu.name, p_code, 'correct', summary || case when reason_txt <> '' then ('；原因：' || reason_txt) else '' end);
  if moved then
    insert into public.equip_audit (at, account, name, code, action, summary)
      values (at_txt, cu.account, cu.name, p_target_code, 'correct', summary || case when reason_txt <> '' then ('；原因：' || reason_txt) else '' end);
  end if;
  out_eq := jsonb_build_object(p_code, case when role = 'reporter' then public._mask_equip_report(src) else src end);
  out_eq := out_eq || jsonb_build_object(p_target_code, case when role = 'reporter' then public._mask_equip_report(dst) else dst end);
  return jsonb_build_object('ok', true, 'source_code', p_code, 'code', p_target_code,
    'no', coalesce(rec->>'no', ''), 'moved', moved, 'equipments', out_eq);
end $$;

-- 补充说明只追加,不改原报修/处理或新建工单;成功后向现有群发送独立【报修补充】。
create or replace function public.equipment_report_supplement(
  p_token text, p_code text, p_record_id text, p_text text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare cu public.users%rowtype; role text; d jsonb; rec jsonb; changed jsonb;
        recs jsonb; matches int; at_txt text; text_txt text; entry jsonb;
        base text; link text; code_url text; wo_url text; wo text; raw text; encoded text;
        raw_bytes bytea; b int; i int; j int; mark text; fields text[];
        msg text; heading text; ending text; preview text; suffix text; budget int; lo int; hi int; mid int;
        ws text := U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  role := public._equip_role(p_token);
  if role not in ('admin', 'reporter') then
    return jsonb_build_object('ok', false, 'msg', '仅设备管理员和报修人可补充说明');
  end if;
  if btrim(coalesce(p_code, ''), ws) = '' or btrim(coalesce(p_record_id, ''), ws) = '' then
    return jsonb_build_object('ok', false, 'msg', '请选择设备和原工单');
  end if;
  text_txt := btrim(coalesce(p_text, ''), ws);
  if text_txt = '' then return jsonb_build_object('ok', false, 'msg', '请填写补充说明'); end if;
  if char_length(text_txt) > 2000 then return jsonb_build_object('ok', false, 'msg', '补充说明最多2000字'); end if;

  select e.data into d from public.equipments e where e.code = p_code for update;
  if d is null then return jsonb_build_object('ok', false, 'msg', '设备不存在，请刷新'); end if;
  if role = 'reporter' and (coalesce(trim(cu.dept), '') = '' or coalesce(d->>'line', '') <> trim(cu.dept)) then
    return jsonb_build_object('ok', false, 'msg', '只能补充本车间工单');
  end if;
  if jsonb_typeof(d->'records') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'msg', '设备工单数据异常，请联系设备管理员');
  end if;
  select count(*) into matches from jsonb_array_elements(d->'records') r where r->>'id' = p_record_id;
  if matches <> 1 then return jsonb_build_object('ok', false, 'msg', '工单不存在、已移动或编号重复，请刷新'); end if;
  select r into rec from jsonb_array_elements(d->'records') r where r->>'id' = p_record_id;
  if role = 'reporter' and (coalesce(rec->>'status', '') = 'done' or coalesce(rec->>'doneAt', '') <> '') then
    return jsonb_build_object('ok', false, 'msg', '已完成工单仅设备管理员可补充说明');
  end if;
  if rec ? '_supplements' and jsonb_typeof(rec->'_supplements') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'msg', '补充说明数据异常，请联系设备管理员');
  end if;
  at_txt := to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS');
  entry := jsonb_build_object('at', at_txt, 'account', cu.account,
    'by', coalesce(nullif(cu.name, ''), cu.account), 'text', text_txt);
  changed := rec || jsonb_build_object('_supplements', coalesce(rec->'_supplements', '[]'::jsonb) || jsonb_build_array(entry),
    'updatedAt', at_txt, 'updatedBy', entry->>'by');
  select jsonb_agg(case when r->>'id' = p_record_id then changed else r end order by ord) into recs
    from jsonb_array_elements(d->'records') with ordinality a(r, ord);
  -- 首次追加就启用版本,保护新说明不被已打开的旧整包编辑页覆盖。
  d := jsonb_set(d, '{records}', recs) || jsonb_build_object('_recordsRev', gen_random_uuid()::text);
  update public.equipments set data = d, saved_at = at_txt, updated_by = cu.account where code = p_code;
  insert into public.equip_audit (at, account, name, code, action, summary)
    values (at_txt, cu.account, cu.name, p_code, 'supplement',
      '补充说明 ' || coalesce(nullif(rec->>'no', ''), p_record_id) || '：' || left(text_txt, 80));

  -- 仅成功追加后提交一次异步群通知;与现有报修/进度相同,投递失败不影响业务保存。
  -- code/wo 按 UTF-8 字节编码,避免空格、&、# 等将链接指向另一张工单。
  wo := coalesce(rec->>'no', '');
  for j in 1..2 loop
    raw := case when j = 1 then p_code else wo end;
    raw_bytes := convert_to(raw, 'UTF8'); encoded := '';
    for i in 0..octet_length(raw_bytes)-1 loop
      b := get_byte(raw_bytes, i);
      encoded := encoded || case when (b between 48 and 57) or (b between 65 and 90)
        or (b between 97 and 122) or b in (45, 46, 95, 126) then chr(b)
        else '%' || upper(lpad(to_hex(b), 2, '0')) end;
    end loop;
    if j = 1 then code_url := encoded; else wo_url := encoded; end if;
  end loop;
  base := nullif(btrim(public._get_config('site_url')), '');
  if base is null or base !~ '^https://[^/?#[:space:]]+(/[^?#[:space:]]*)?$'
     or octet_length(base) > 512 or base ~ '[()<>]' or position(chr(92) in base) > 0 then
    base := 'https://kekits.com/equipment/';
  end if;
  link := base || '?code=' || code_url || case when wo <> '' then '&wo=' || wo_url else '' end;
  -- 异常超长旧标识也不能撑爆机器人消息;正常设备/工单始终保留完整直达链接。
  if octet_length(link) > 1024 then link := base || '?code=' || code_url; end if;
  if octet_length(link) > 1024 then link := base; end if;

  fields := array[left(coalesce(nullif(wo, ''), nullif(public._equip_label(d), ''), p_code), 64),
    left(coalesce(nullif(public._equip_label(d), ''), p_code), 100),
    left(coalesce(rec->>'devName', ''), 80), left(coalesce(rec->>'place', ''), 80),
    text_txt, left(entry->>'by', 40)];
  for i in 1..array_length(fields, 1) loop
    -- 用户文字只作为当前行的文字,不能伪装通知标题/链接或群内 mention。
    fields[i] := replace(replace(replace(replace(replace(coalesce(fields[i], ''), E'\r', ' '), E'\n', ' '),
      E'\t', ' '), U&'\2028', ' '), U&'\2029', ' ');
    fields[i] := replace(replace(replace(fields[i], '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
    fields[i] := replace(fields[i], chr(92), chr(92) || chr(92));
    foreach mark in array array['`', '*', '_', '[', ']'] loop
      fields[i] := replace(fields[i], mark, chr(92) || mark);
    end loop;
  end loop;
  heading := '**【报修补充】' || fields[1] || E'**\n'
    || '> 设备:' || fields[2] || E'\n'
    || case when fields[3] <> '' then '> 具体物件:' || fields[3] || E'\n' else '' end
    || case when fields[4] <> '' then '> 位置:' || fields[4] || E'\n' else '' end
    || case when coalesce(rec->>'status', '') = 'done' or coalesce(rec->>'doneAt', '') <> ''
       then E'> 状态:已完成（仅追加说明，不重开工单）\n' else '' end
    || '> 补充:';
  ending := E'\n> 补充人:' || fields[6] || '   ' || at_txt || E'\n[▶ 查看原工单](' || link || ')';
  preview := fields[5]; budget := 4096 - octet_length(heading || ending);
  if octet_length(preview) > budget then
    suffix := '…（内容较长，完整补充请查看原工单）';
    budget := budget - octet_length(suffix); lo := 0; hi := char_length(preview);
    while lo < hi loop
      mid := (lo + hi + 1) / 2;
      if octet_length(left(preview, mid)) <= budget then lo := mid; else hi := mid - 1; end if;
    end loop;
    preview := left(preview, lo) || suffix;
  end if;
  msg := heading || preview || ending;
  perform public._wx_send(msg);
  return jsonb_build_object('ok', true, 'code', p_code, 'no', coalesce(rec->>'no', ''),
    'equipment', case when role = 'reporter' then public._mask_equip_report(d) else d end);
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

  select e.data into old_data from public.equipments e where e.code = p_code for update;
  -- 已更正过的设备拒绝旧整包,避免移动的单被旧编辑页写回原设备。
  if coalesce(old_data->>'_recordsRev', '') <> ''
     and coalesce(p_data->>'_recordsRev', '') <> old_data->>'_recordsRev' then
    return jsonb_build_object('ok', false, 'msg', '设备履历已更新，请刷新后重试');
  end if;
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

  -- 留存的补充说明不可经整包保存改删/伪造;删除整条工单仍走原回收站规则。
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_data->'records', '[]'::jsonb)) n
    left join jsonb_array_elements(coalesce(old_data->'records', '[]'::jsonb)) o on o->>'id' = n->>'id'
    where coalesce(n->'_supplements', '[]'::jsonb) is distinct from coalesce(o->'_supplements', '[]'::jsonb)
  ) then
    return jsonb_build_object('ok', false, 'msg', '补充说明只能追加，请刷新后重试');
  end if;

  -- 乐观版本只由服务端签发;已启用版本的设备每次写入都刷新。
  if coalesce(old_data->>'_recordsRev', '') <> '' then
    p_data := p_data || jsonb_build_object('_recordsRev', gen_random_uuid()::text);
  else p_data := p_data - '_recordsRev';
  end if;

  -- 回收站:对比新旧 records,把「这次被删掉的」逐个存快照(前端删单条记录就是少传一条)
  if old_data is not null then
    for oldr in
      select o from jsonb_array_elements(coalesce(old_data->'records', '[]'::jsonb)) o
      where not exists (
        select 1 from jsonb_array_elements(coalesce(p_data->'records', '[]'::jsonb)) n
        where n->>'id' = o->>'id')
    loop
      perform public._trash_push('record', p_code,
        left(coalesce(nullif(oldr->>'no', ''), '工单') || ' · ' || coalesce(oldr->>'symptom', ''), 60),
        oldr, cu.account, cu.name);
    end loop;
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
          || case when wo <> '' then ('> 设备:' || public._equip_label(p_data) || E'\n') else '' end
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

  return jsonb_build_object('ok', true, 'recordsRev', p_data->>'_recordsRev');
end $$;

-- 报修:三种角色均可;预计完成由设备管理员后续设置(此处不写入)
-- 签名保留 6 参,p_place 设备位置必填;移除历史 5 参重载以避免绕过校验
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
  -- 与客户端 trim 一致,拒绝缺失或全空白位置;在分配工单号/写入/推送前校验。
  place_txt := btrim(coalesce(p_place, ''), U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
  if place_txt = '' then return jsonb_build_object('ok', false, 'msg', '请填写设备位置'); end if;
  select e.data into d from public.equipments e where e.code = p_code for update;
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
  if coalesce(d->>'_recordsRev', '') <> '' then d := d || jsonb_build_object('_recordsRev', gen_random_uuid()::text); end if;
  update public.equipments set data = d, saved_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), updated_by = cu.account where code = p_code;
  insert into public.equip_audit (at, account, name, code, action, summary)
  values (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), cu.account, cu.name, p_code, 'report', '报修:' || left(p_symptom, 30));

  base := coalesce(public._get_config('site_url'), 'https://kekits.com/equipment/');
  link := base || '?code=' || p_code || case when wo <> '' then ('&wo=' || wo) else '' end;
  nm := coalesce(d->>'name', p_code);
  ln := coalesce(d->>'line', '');
  num := coalesce(nullif(d->>'number',''), p_code);
  msg := '**【新报修】' || wo || E'**\n'
      || '> 设备:' || public._equip_label(d) || E'\n'
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
  select e.data into d from public.equipments e where e.code = p_code for update;
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
  if coalesce(d->>'_recordsRev', '') <> '' then d := d || jsonb_build_object('_recordsRev', gen_random_uuid()::text); end if;

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
  msg := '**【进度】' || case when coalesce(wo,'') <> '' then wo else public._equip_label(d) end || E'**\n'
      || '> 设备:' || public._equip_label(d) || E'\n'
      || '> 说明:' || replace(trim(p_text), E'\n', ' ') || E'\n'
      || '> 回复人:' || cu.name || '   ' || to_char(now(), 'MM-DD HH24:MI') || E'\n'
      || '[▶ 查看设备](' || link || ')';
  perform public._wx_send(msg);

  return jsonb_build_object('ok', true, 'update', upd);
end $$;

-- ============================================================
-- 每日待办(逾期 / 今天到期):每天早上 08:00 推群
-- 规则:只推「已逾期」和「今天到期」;没有就不推;周末不推;最多列 5 条
-- 由 pg_cron 调用 equip_daily_push()(见 supabase/daily_todo_cron.sql)
-- ============================================================
create or replace function public._equip_todo_msg(p_test boolean default false)
returns jsonb language plpgsql security definer as $$
declare
  d date := current_date;
  rec record; ups jsonb; t text; tag text; one text;
  overdue int := 0; due_today int := 0; total int := 0; shown int := 0;
  lines text := ''; msg text; base text; link text; head text;
  sampled boolean := false;
begin
  for rec in
    select e.code, e.data, r
      from public.equipments e
      cross join lateral jsonb_array_elements(coalesce(e.data->'records', '[]'::jsonb)) r
     where coalesce(r->>'status', case when coalesce(r->>'doneAt', '') <> '' then 'done' else 'open' end) = 'open'
       and coalesce(r->>'expectedAt', '') <> ''
       and (r->>'expectedAt')::date <= d
     order by (r->>'expectedAt')::date asc, coalesce(r->>'no', '')
  loop
    total := total + 1;
    if (d - (rec.r->>'expectedAt')::date) > 0 then
      overdue := overdue + 1;
    else
      due_today := due_today + 1;
    end if;
    if shown < 5 then
      shown := shown + 1;
      -- 有回应时带一个简短状态:等备件 / 等外协 / 待采购 / 等停机窗口
      ups := coalesce(rec.r->'updates', '[]'::jsonb);
      tag := '';
      if jsonb_array_length(ups) > 0 then
        t := trim(coalesce(ups -> (jsonb_array_length(ups) - 1) ->> 'text', ''));
        if t <> '' then
          if position('备件' in t) > 0 then
            tag := '等备件';
          elsif position('外协' in t) > 0 then
            tag := '等外协';
          elsif position('采购' in t) > 0 then
            tag := '待采购';
          elsif position('停机' in t) > 0 or position('窗口' in t) > 0 then
            tag := '等停机窗口';
          else
            tag := left(t, 10) || case when length(t) > 10 then '…' else '' end;
          end if;
        end if;
      end if;
      one := shown || '. ' || coalesce(nullif(rec.r->>'no', ''), '(无单号)') || ' '
             || public._equip_label(rec.data);
      if (d - (rec.r->>'expectedAt')::date) > 0 then
        one := one || ' · 逾期 ' || (d - (rec.r->>'expectedAt')::date) || ' 天';
      else
        one := one || ' · 今天到期';
      end if;
      if tag <> '' then one := one || ' · ' || tag; end if;
      lines := lines || one || E'\n';
    end if;
  end loop;

  -- 测试发送且当前没有待办时,用样例演示格式
  if total = 0 and p_test then
    sampled := true;
    overdue := 2; due_today := 1; total := 5;
    lines := '1. WO261018-03 双面磨 PS04-70 · 逾期 3 天 · 等备件' || E'\n'
          || '2. WO261016-02 注塑机 PS41-17 · 逾期 5 天' || E'\n'
          || '3. WO261021-01 风扇 · 水磨组 · 今天到期' || E'\n';
  end if;

  base := coalesce(public._get_config('site_url'), 'https://kekits.com/equipment/');
  link := base || '?todo=1';
  head := case when p_test then '【测试】' else '' end
          || '【今日待办】' || to_char(d, 'MM-DD') || ' 周'
          || (array['日','一','二','三','四','五','六'])[extract(dow from d)::int + 1];
  msg := head || E'\n'
      || '逾期 ' || overdue || ' 单 · 今天到期 ' || due_today || ' 单' || E'\n\n'
      || lines
      || E'\n[▶ 查看全部 ' || total || ' 单](' || link || ')';
  if sampled then
    msg := msg || E'\n\n> 以上为测试样例(当前没有逾期或今天到期的工单)';
  end if;
  return jsonb_build_object('msg', msg, 'total', total, 'overdue', overdue, 'due_today', due_today);
end $$;

-- 每天定时调用:周末/无待办时不发
create or replace function public.equip_daily_push()
returns jsonb language plpgsql security definer as $$
declare r jsonb;
begin
  if extract(dow from current_date)::int in (0, 6) then
    return jsonb_build_object('ok', true, 'skipped', 'weekend');
  end if;
  r := public._equip_todo_msg(false);
  if coalesce((r->>'total')::int, 0) = 0 then
    return jsonb_build_object('ok', true, 'skipped', 'empty');
  end if;
  perform public._wx_send(r->>'msg');
  return jsonb_build_object('ok', true, 'sent', true, 'total', (r->>'total')::int);
end $$;

-- 管理员手动测试:发一条带【测试】的消息,并把内容回给前端预览
create or replace function public.equip_daily_test(p_token text)
returns jsonb language plpgsql security definer as $$
declare cu public.users%rowtype; r jsonb;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if public._equip_role(p_token) <> 'admin' then
    return jsonb_build_object('ok', false, 'msg', '仅设备管理员可测试');
  end if;
  r := public._equip_todo_msg(true);
  perform public._wx_send(r->>'msg');
  return jsonb_build_object('ok', true, 'preview', r->>'msg', 'total', (r->>'total')::int);
end $$;

-- 删除设备:仅设备管理员
create or replace function public.equipment_delete(p_token text, p_code text)
returns jsonb language plpgsql security definer as $$
declare cu public.users%rowtype; d jsonb;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if public._equip_role(p_token) <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅设备管理员可删除设备'); end if;
  -- 删前存快照,可在回收站恢复(工单随设备一起进快照,不单独再存)
  select e.data into d from public.equipments e where e.code = p_code for update;
  if d is not null then
    perform public._trash_push('equipment', p_code, public._equip_label(d), d, cu.account, cu.name);
  end if;
  delete from public.equipments where code = p_code;
  insert into public.equip_audit (at, account, name, code, action, summary)
  values (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), cu.account, cu.name, p_code, 'delete', '删除设备');
  return jsonb_build_object('ok', true);
end $$;

-- ============================================================
-- 9) 备份 / 恢复(仅 1 级 admin;恢复=全量覆盖,前端会先自动导出一份当前数据)
-- ============================================================

-- 9.1) 全量导出:设备(含全部工单履历)+ 账号(含密码哈希)+ 工单号流水 + 配置 + ROI 项目库 + 操作留痕
create or replace function public.admin_backup(p_token text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; v_eq jsonb; v_us jsonb; v_sq jsonb; v_cf jsonb; v_pj jsonb; v_au jsonb; v_rb jsonb;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  -- 账户管理/全量备份恢复只属于固定 admin 账号,与 ROI 等级无关。
  if u.account <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅 admin 账号可操作'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('code', code, 'data', data, 'saved_at', saved_at, 'updated_by', updated_by)), '[]'::jsonb)
    into v_eq from public.equipments;
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_us from public.users x;
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_sq from public.equip_seq x;
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_cf from public.app_config x;
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_pj from public.projects x;
  select coalesce(jsonb_agg(to_jsonb(x) - 'id' order by x.id), '[]'::jsonb) into v_au from public.equip_audit x;
  select coalesce(jsonb_agg(to_jsonb(x) - 'id' order by x.id), '[]'::jsonb) into v_rb from public.recycle_bin x;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'version', 3,
    'at', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
    'equipments', v_eq,
    'users', v_us,
    'equip_seq', v_sq,
    'app_config', v_cf,
    'projects', v_pj,
    'equip_audit', v_au,
    'recycle_bin', v_rb));
end $$;

-- 9.2) 清空设备表(恢复前调用;p_confirm 必须为 RESTORE)
create or replace function public.admin_restore_clear(p_token text, p_confirm text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; n int;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  -- 账户管理/全量备份恢复只属于固定 admin 账号,与 ROI 等级无关。
  if u.account <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅 admin 账号可操作'); end if;
  if coalesce(p_confirm, '') <> 'RESTORE' then return jsonb_build_object('ok', false, 'msg', '确认字不正确'); end if;
  delete from public.equipments;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'n', n);
end $$;

-- 9.3) 恢复单台设备(整体覆盖该设备的档案 + 履历;saved_at 缺省才用当前时间)
drop function if exists public.admin_restore_device(text, text, jsonb);
create or replace function public.admin_restore_device(p_token text, p_code text, p_data jsonb, p_saved_at text default null)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  -- 账户管理/全量备份恢复只属于固定 admin 账号,与 ROI 等级无关。
  if u.account <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅 admin 账号可操作'); end if;
  if coalesce(trim(p_code), '') = '' or p_data is null then return jsonb_build_object('ok', false, 'msg', '参数不完整'); end if;
  insert into public.equipments(code, data, saved_at, updated_by)
  values (trim(p_code), p_data, coalesce(nullif(p_saved_at, ''), to_char(now(), 'YYYY-MM-DD HH24:MI:SS')), u.account)
  on conflict (code) do update set data = excluded.data, saved_at = excluded.saved_at, updated_by = excluded.updated_by;
  return jsonb_build_object('ok', true);
end $$;

-- 9.4) 恢复账号(整体覆盖;备份里没有 admin 则中止,防止把自己锁在外面)
create or replace function public.admin_restore_users(p_token text, p_users jsonb)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; n int;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  -- 账户管理/全量备份恢复只属于固定 admin 账号,与 ROI 等级无关。
  if u.account <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅 admin 账号可操作'); end if;
  if p_users is null or jsonb_typeof(p_users) <> 'array' or jsonb_array_length(p_users) = 0 then
    return jsonb_build_object('ok', false, 'msg', '账号数据为空');
  end if;
  -- 恢复后仍须有唯一可登录的内置管理员,否则会永久失去管理入口。
  if (select count(*) from jsonb_array_elements(p_users) x where x->>'account' = 'admin') <> 1 then
    return jsonb_build_object('ok', false, 'msg', '备份必须包含唯一 admin 账号,已中止恢复');
  end if;
  if not exists (select 1 from jsonb_array_elements(p_users) x
                 where x->>'account' = 'admin'
                   and coalesce(nullif(x->>'status', ''), 'active') = 'active'
                   and x->>'level' = '1'
                   and trim(coalesce(x->>'pwd', '')) <> '') then
    return jsonb_build_object('ok', false, 'msg', '备份中的 admin 必须为正常1级账号且保留密码,已中止恢复');
  end if;
  delete from public.users where account not in (select x->>'account' from jsonb_array_elements(p_users) x);
  insert into public.users as t(account, name, pwd, level, status, reg_time, tools, dept, must_change_pwd)
  select x->>'account',
         coalesce(nullif(x->>'name', ''), x->>'account'),
         coalesce(x->>'pwd', ''),
         coalesce((x->>'level')::int, 2),
         coalesce(nullif(x->>'status', ''), 'active'),
         coalesce(x->>'reg_time', ''),
         coalesce(x->'tools', '["roi"]'::jsonb),
         coalesce(x->>'dept', ''),
         coalesce((x->>'must_change_pwd')::boolean, false)
  from jsonb_array_elements(p_users) x
  where coalesce(x->>'account', '') <> ''
  on conflict (account) do update set
    name = excluded.name,
    pwd = coalesce(nullif(excluded.pwd, ''), t.pwd),
    level = excluded.level,
    status = excluded.status,
    reg_time = excluded.reg_time,
    tools = excluded.tools,
    dept = excluded.dept,
    must_change_pwd = excluded.must_change_pwd;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'n', n);
end $$;

-- 9.5) 恢复工单号流水 + 配置
create or replace function public.admin_restore_meta(p_token text, p_meta jsonb)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  -- 账户管理/全量备份恢复只属于固定 admin 账号,与 ROI 等级无关。
  if u.account <> 'admin' then return jsonb_build_object('ok', false, 'msg', '仅 admin 账号可操作'); end if;
  if p_meta is null or jsonb_typeof(p_meta) <> 'object' then return jsonb_build_object('ok', false, 'msg', '参数不完整'); end if;
  -- 工单号流水
  if jsonb_typeof(p_meta->'equip_seq') = 'array' then
    delete from public.equip_seq where day not in (select x->>'day' from jsonb_array_elements(p_meta->'equip_seq') x);
    insert into public.equip_seq(day, n)
    select x->>'day', coalesce((x->>'n')::int, 0)
    from jsonb_array_elements(p_meta->'equip_seq') x
    where coalesce(x->>'day', '') <> ''
    on conflict (day) do update set n = excluded.n;
  end if;
  -- 配置(只覆盖备份里有的键,不动其它)
  if jsonb_typeof(p_meta->'app_config') = 'array' then
    insert into public.app_config(key, value, updated_at)
    select x->>'key', x->>'value', coalesce(x->>'updated_at', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
    from jsonb_array_elements(p_meta->'app_config') x
    where coalesce(x->>'key', '') <> ''
    on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
  end if;
  -- ROI 项目库(整体覆盖;老备份里没有这个键就保持原样,不动)
  if jsonb_typeof(p_meta->'projects') = 'array' then
    delete from public.projects;
    insert into public.projects(name, data, saved_at)
    select x->>'name', coalesce(x->'data', '{}'::jsonb), coalesce(x->>'saved_at', '')
    from jsonb_array_elements(p_meta->'projects') x
    where coalesce(x->>'name', '') <> '';
  end if;
  -- 操作留痕(整体覆盖;id 由序列重新分配,老备份没有就保持原样)
  if jsonb_typeof(p_meta->'equip_audit') = 'array' then
    delete from public.equip_audit;
    insert into public.equip_audit(at, account, name, code, action, summary)
    select coalesce(x->>'at', ''), coalesce(x->>'account', ''), x->>'name',
           coalesce(x->>'code', ''), coalesce(x->>'action', ''), x->>'summary'
    from jsonb_array_elements(p_meta->'equip_audit') x;
  end if;
  -- 回收站(整体覆盖;id 由序列重新分配,老备份没有就保持原样)
  if jsonb_typeof(p_meta->'recycle_bin') = 'array' then
    delete from public.recycle_bin;
    insert into public.recycle_bin(kind, ref_key, label, snapshot, deleted_at, deleted_by, deleted_by_name, purge_at)
    select coalesce(x->>'kind', ''), coalesce(x->>'ref_key', ''), coalesce(x->>'label', ''),
           coalesce(x->'snapshot', '{}'::jsonb), coalesce(x->>'deleted_at', ''),
           coalesce(x->>'deleted_by', ''), coalesce(x->>'deleted_by_name', ''),
           coalesce(x->>'purge_at', '')
    from jsonb_array_elements(p_meta->'recycle_bin') x
    where coalesce(x->>'kind', '') <> '';
  end if;
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
grant execute on function public.equipment_report_correct(text, text, text, text, text, text, text, jsonb) to anon;
grant execute on function public.equipment_report_supplement(text, text, text, text) to anon;
grant execute on function public.equipment_delete(text, text) to anon;
grant execute on function public.equipment_audit_list(text, text) to anon;
grant execute on function public.equip_daily_test(text) to anon;
grant execute on function public.admin_set_tools(text, text, jsonb) to anon;
grant execute on function public.admin_set_config(text, text, text) to anon;
grant execute on function public.admin_get_config(text) to anon;
grant execute on function public.admin_backup(text) to anon;
grant execute on function public.admin_restore_clear(text, text) to anon;
grant execute on function public.admin_restore_device(text, text, jsonb, text) to anon;
grant execute on function public.admin_restore_users(text, jsonb) to anon;
grant execute on function public.admin_restore_meta(text, jsonb) to anon;

-- ============================================================
-- 10) 回收站(2026-10-22):设备 / 工单记录 / ROI 项目
--     删除时存快照,30 天后自动清理(打开列表时顺带清,不依赖 pg_cron)
--     权限:履历卡=设备管理员(_equip_role='admin');ROI=1 级全部 / 2 级仅本人删的
-- ============================================================

-- 10.1) 写入一条回收站记录(30 天后到期)
create or replace function public._trash_push(p_kind text, p_ref text, p_label text,
                                              p_snap jsonb, p_acc text, p_name text)
returns void language sql security definer as $$
  insert into public.recycle_bin (kind, ref_key, label, snapshot, deleted_at, deleted_by, deleted_by_name, purge_at)
  values (p_kind, coalesce(p_ref, ''), coalesce(p_label, ''), p_snap,
          to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), coalesce(p_acc, ''), coalesce(p_name, ''),
          to_char(now() + interval '30 days', 'YYYY-MM-DD HH24:MI:SS'));
$$;

-- 10.2) 清掉已过 30 天的(幂等,可在任何入口顺手调用)
create or replace function public._trash_purge_expired()
returns void language sql security definer as $$
  delete from public.recycle_bin
   where coalesce(purge_at, '') <> ''
     and purge_at < to_char(now(), 'YYYY-MM-DD HH24:MI:SS');
$$;

-- 10.3) 履历卡回收站:列表(仅设备管理员)
create or replace function public.equip_trash_list(p_token text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; items jsonb;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if public._equip_role(p_token) <> 'admin' then
    return jsonb_build_object('ok', false, 'msg', '仅设备管理员可查看回收站');
  end if;
  perform public._trash_purge_expired();
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'kind', r.kind, 'ref_key', r.ref_key, 'label', r.label,
           'deleted_at', r.deleted_at, 'deleted_by_name', r.deleted_by_name,
           'days_left', greatest(0, (r.purge_at)::timestamp::date - current_date),
           'snapshot', r.snapshot) order by r.deleted_at desc, r.id desc), '[]'::jsonb)
    into items
    from public.recycle_bin r
   where r.kind in ('equipment', 'record');
  return jsonb_build_object('ok', true, 'items', items);
end $$;

-- 10.4) 履历卡回收站:恢复(p_mode='skip' 冲突跳过 / 'overwrite' 覆盖)
create or replace function public.equip_trash_restore(p_token text, p_id bigint, p_mode text default 'skip')
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; r public.recycle_bin%rowtype; d jsonb; recs jsonb;
        rid text; has boolean; mode text;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if public._equip_role(p_token) <> 'admin' then
    return jsonb_build_object('ok', false, 'msg', '仅设备管理员可恢复');
  end if;
  mode := case when p_mode = 'overwrite' then 'overwrite' else 'skip' end;
  select * into r from public.recycle_bin where id = p_id for update;
  if r.id is null then return jsonb_build_object('ok', false, 'msg', '回收站里没有这条'); end if;
  perform e.code from public.equipments e where e.code = r.ref_key for update;
  -- 旧快照不能把已移动到其它设备的同一工单复制回原设备。
  if r.kind in ('equipment', 'record') and exists (
    select 1 from public.equipments e
      cross join lateral jsonb_array_elements(coalesce(e.data->'records', '[]'::jsonb)) live
      cross join lateral jsonb_array_elements(case when r.kind = 'record'
        then jsonb_build_array(r.snapshot) else coalesce(r.snapshot->'records', '[]'::jsonb) end) snap
    where e.code <> r.ref_key and (
      (coalesce(snap->>'id', '') <> '' and live->>'id' = snap->>'id')
      or (coalesce(snap->>'no', '') <> '' and live->>'no' = snap->>'no'))
  ) then return jsonb_build_object('ok', false, 'msg', '工单已存在于其他设备，未恢复，请先核对归属'); end if;

  if r.kind = 'equipment' then
    select e.data into d from public.equipments e where e.code = r.ref_key;
    if d is not null and mode = 'skip' then
      return jsonb_build_object('ok', false, 'msg', '设备 ' || r.ref_key || ' 已存在,已跳过');
    end if;
    insert into public.equipments (code, data, saved_at, updated_by)
    values (r.ref_key, r.snapshot || jsonb_build_object('_recordsRev', gen_random_uuid()::text), to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), u.account)
    on conflict (code) do update
       set data = excluded.data, saved_at = excluded.saved_at, updated_by = excluded.updated_by;
    insert into public.equip_audit (at, account, name, code, action, summary)
    values (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), u.account, u.name, r.ref_key, 'restore',
            '从回收站恢复设备' || case when mode = 'overwrite' then '(覆盖)' else '' end);
  elsif r.kind = 'record' then
    select e.data into d from public.equipments e where e.code = r.ref_key;
    if d is null then
      return jsonb_build_object('ok', false, 'msg', '请先恢复设备 ' || r.ref_key);
    end if;
    rid := coalesce(r.snapshot->>'id', '');
    select exists (select 1 from jsonb_array_elements(coalesce(d->'records', '[]'::jsonb)) x
                    where x->>'id' = rid) into has;
    if has and rid <> '' and mode = 'skip' then
      return jsonb_build_object('ok', false, 'msg', '该工单已存在,已跳过');
    end if;
    if has and rid <> '' then
      select coalesce(jsonb_agg(case when x->>'id' = rid then r.snapshot else x end order by ord), '[]'::jsonb)
        into recs
        from jsonb_array_elements(coalesce(d->'records', '[]'::jsonb)) with ordinality t(x, ord);
    else
      recs := coalesce(d->'records', '[]'::jsonb) || jsonb_build_array(r.snapshot);
    end if;
    if coalesce(d->>'_recordsRev', '') <> '' then d := d || jsonb_build_object('_recordsRev', gen_random_uuid()::text); end if;
    update public.equipments
       set data = jsonb_set(d, '{records}', recs),
           saved_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
           updated_by = u.account
     where code = r.ref_key;
    insert into public.equip_audit (at, account, name, code, action, summary)
    values (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), u.account, u.name, r.ref_key, 'restore',
            '从回收站恢复工单' || case when coalesce(r.snapshot->>'no', '') <> ''
                                     then ' ' || (r.snapshot->>'no') else '' end);
  else
    return jsonb_build_object('ok', false, 'msg', '这条不属于设备回收站');
  end if;

  delete from public.recycle_bin where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- 10.5) 履历卡回收站:彻底删除(p_id 为空 = 清空)
create or replace function public.equip_trash_purge(p_token text, p_id bigint default null)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; n int;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if public._equip_role(p_token) <> 'admin' then
    return jsonb_build_object('ok', false, 'msg', '仅设备管理员可清理回收站');
  end if;
  if p_id is null then
    delete from public.recycle_bin where kind in ('equipment', 'record');
  else
    delete from public.recycle_bin where id = p_id and kind in ('equipment', 'record');
  end if;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'n', n);
end $$;

-- 10.6) ROI 回收站:列表(1 级全部 / 2 级仅本人删的)
create or replace function public.project_trash_list(p_token text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; items jsonb;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if public._roi_role(p_token) = 'none' then
    return jsonb_build_object('ok', false, 'msg', '无 ROI 权限,请联系管理员开通'); end if;
  perform public._trash_purge_expired();
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'ref_key', r.ref_key, 'label', r.label,
           'deleted_at', r.deleted_at, 'deleted_by_name', r.deleted_by_name,
           'days_left', greatest(0, (r.purge_at)::timestamp::date - current_date),
           'snapshot', r.snapshot) order by r.deleted_at desc, r.id desc), '[]'::jsonb)
    into items
    from public.recycle_bin r
   where r.kind = 'project'
     and (u.level = 1 or r.deleted_by = u.account);
  return jsonb_build_object('ok', true, 'items', items);
end $$;

-- 10.7) ROI 回收站:恢复(1 级任意 / 2 级仅本人的)
create or replace function public.project_trash_restore(p_token text, p_id bigint, p_mode text default 'skip')
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; r public.recycle_bin%rowtype; has_p boolean; mode text; nm text;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if public._roi_role(p_token) = 'none' then
    return jsonb_build_object('ok', false, 'msg', '无 ROI 权限,请联系管理员开通'); end if;
  mode := case when p_mode = 'overwrite' then 'overwrite' else 'skip' end;
  select * into r from public.recycle_bin where id = p_id and kind = 'project';
  if r.id is null then return jsonb_build_object('ok', false, 'msg', '回收站里没有这条'); end if;
  if u.level <> 1 and r.deleted_by <> u.account then
    return jsonb_build_object('ok', false, 'msg', '只能恢复自己删除的项目');
  end if;
  nm := coalesce(nullif(r.snapshot->>'name', ''), r.ref_key);
  select exists (select 1 from public.projects p where p.name = nm) into has_p;
  if has_p and mode = 'skip' then
    return jsonb_build_object('ok', false, 'msg', '项目「' || nm || '」已存在,已跳过');
  end if;
  insert into public.projects (name, data, saved_at)
  values (nm, coalesce(r.snapshot->'data', '{}'::jsonb), coalesce(r.snapshot->>'saved_at', ''))
  on conflict (name) do update set data = excluded.data, saved_at = excluded.saved_at;
  delete from public.recycle_bin where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- 10.8) ROI 回收站:彻底删除(p_id 为空 = 清空可见的)
create or replace function public.project_trash_purge(p_token text, p_id bigint default null)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; n int;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if public._roi_role(p_token) = 'none' then
    return jsonb_build_object('ok', false, 'msg', '无 ROI 权限,请联系管理员开通'); end if;
  if p_id is null then
    delete from public.recycle_bin r
     where r.kind = 'project' and (u.level = 1 or r.deleted_by = u.account);
  else
    delete from public.recycle_bin r
     where r.id = p_id and r.kind = 'project' and (u.level = 1 or r.deleted_by = u.account);
  end if;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'n', n);
end $$;

grant execute on function public.equip_trash_list(text) to anon;
grant execute on function public.equip_trash_restore(text, bigint, text) to anon;
grant execute on function public.equip_trash_purge(text, bigint) to anon;
grant execute on function public.project_trash_list(text) to anon;
grant execute on function public.project_trash_restore(text, bigint, text) to anon;
grant execute on function public.project_trash_purge(text, bigint) to anon;
