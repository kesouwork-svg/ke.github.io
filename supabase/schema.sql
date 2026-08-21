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
  reg_time text default ''
);
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
  insert into public.sessions (token, account, exp) values (tk, u.account, (extract(epoch from now()) * 1000)::bigint + 604800000);
  return jsonb_build_object('ok', true, 'data',
    jsonb_build_object('token', tk, 'user', jsonb_build_object('account', u.account, 'name', u.name, 'level', u.level)));
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
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('user', jsonb_build_object('account', u.account, 'name', u.name, 'level', u.level)));
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
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('users',
    coalesce((select jsonb_object_agg(x.account, jsonb_build_object('account', x.account, 'name', x.name, 'level', x.level, 'status', x.status, 'reg_time', x.reg_time)) from public.users x), '{}'::jsonb)));
end $$;

create or replace function public.admin_audit(p_token text, p_account text, p_level int)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  update public.users set status = 'active', level = case when p_level = 1 then 1 else 2 end where account = p_account;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_reject(p_token text, p_account text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  delete from public.users where account = p_account;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_level(p_token text, p_account text, p_level int)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  update public.users set level = case when p_level = 1 then 1 else 2 end where account = p_account;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_toggle(p_token text, p_account text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype; t public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  select * into t from public.users where account = p_account;
  if t.account is not null then
    update public.users set status = case when t.status = 'active' then 'disabled' else 'active' end where account = p_account;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_resetpwd(p_token text, p_account text, p_newpwd text)
returns jsonb language plpgsql security definer as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.level <> 1 then return jsonb_build_object('ok', false, 'msg', '无权限'); end if;
  if p_newpwd is null or length(p_newpwd) < 6 then return jsonb_build_object('ok', false, 'msg', '新密码至少 6 位'); end if;
  update public.users set pwd = crypt(p_newpwd, gen_salt('bf')) where account = p_account;
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
grant execute on function public.projects_list(text) to anon;
grant execute on function public.project_get(text, text) to anon;
grant execute on function public.project_save(text, text, jsonb) to anon;
grant execute on function public.project_delete(text, text) to anon;
