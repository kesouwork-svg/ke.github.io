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
    jsonb_build_object('token', tk, 'user', jsonb_build_object('account', u.account, 'name', u.name, 'level', u.level, 'tools', coalesce(u.tools, '["roi"]'::jsonb))));
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
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('user', jsonb_build_object('account', u.account, 'name', u.name, 'level', u.level, 'tools', coalesce(u.tools, '["roi"]'::jsonb))));
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
    coalesce((select jsonb_object_agg(x.account, jsonb_build_object('account', x.account, 'name', x.name, 'level', x.level, 'status', x.status, 'reg_time', x.reg_time, 'tools', coalesce(x.tools, '["roi"]'::jsonb))) from public.users x), '{}'::jsonb)));
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

-- 4) 是否有设备履历编辑权(与 ROI 等级无关)
create or replace function public._can_edit_equipment(p_token text)
returns boolean language sql security definer stable as $$
  select coalesce((
    select (u.tools ? 'equipment')
    from public.users u
    where u.account = (select s.account from public.sessions s
                       where s.token = p_token and s.exp > (extract(epoch from now()) * 1000)::bigint limit 1)
    limit 1), false);
$$;

-- 5) 只读脱敏:剥离备件单价与人工/外委费用(只读用户拿不到金额)
create or replace function public._mask_equip(p_data jsonb)
returns jsonb language plpgsql immutable as $$
declare
  base jsonb; recs jsonb; out_recs jsonb := '[]'::jsonb; r jsonb; parts jsonb := '[]'::jsonb; out_parts jsonb := '[]'::jsonb; p jsonb;
begin
  base := p_data - 'records';
  for r in select * from jsonb_array_elements(coalesce(p_data->'records', '[]'::jsonb)) loop
    out_parts := '[]'::jsonb;
    for p in select * from jsonb_array_elements(coalesce(r->'parts', '[]'::jsonb)) loop
      out_parts := out_parts || jsonb_build_array(p - 'price');
    end loop;
    out_recs := out_recs || jsonb_build_array((r - 'laborFee' - 'outsourceFee') || jsonb_build_object('parts', out_parts));
  end loop;
  return base || jsonb_build_object('records', out_recs);
end $$;

-- 6) 列表
create or replace function public.equipment_list(p_token text)
returns jsonb language plpgsql security definer as $$
declare cu public.users%rowtype; ce boolean;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录'); end if;
  ce := public._can_edit_equipment(p_token);
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'canEdit', ce,
    'equipments', coalesce((
      select jsonb_object_agg(e.code, case when ce then e.data else public._mask_equip(e.data) end)
      from public.equipments e), '{}'::jsonb)));
end $$;

-- 7) 单台查询
create or replace function public.equipment_get(p_token text, p_code text)
returns jsonb language plpgsql security definer as $$
declare cu public.users%rowtype; ce boolean; d jsonb;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录'); end if;
  ce := public._can_edit_equipment(p_token);
  select e.data into d from public.equipments e where e.code = p_code;
  if d is null then return jsonb_build_object('ok', false, 'msg', '设备不存在'); end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'canEdit', ce, 'equipment', case when ce then d else public._mask_equip(d) end));
end $$;

-- 8) 保存(需编辑权;自动留痕)
create or replace function public.equipment_save(p_token text, p_code text, p_data jsonb, p_summary text)
returns jsonb language plpgsql security definer as $$
declare cu public.users%rowtype;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if not public._can_edit_equipment(p_token) then return jsonb_build_object('ok', false, 'msg', '无设备履历编辑权限'); end if;
  insert into public.equipments (code, data, saved_at, updated_by)
  values (p_code, p_data, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), cu.account)
  on conflict (code) do update set data = excluded.data, saved_at = excluded.saved_at, updated_by = excluded.updated_by;
  insert into public.equip_audit (at, account, name, code, action, summary)
  values (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), cu.account, cu.name, p_code, 'save', coalesce(p_summary, ''));
  return jsonb_build_object('ok', true);
end $$;

-- 9) 删除设备(需编辑权;自动留痕)
create or replace function public.equipment_delete(p_token text, p_code text)
returns jsonb language plpgsql security definer as $$
declare cu public.users%rowtype;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if not public._can_edit_equipment(p_token) then return jsonb_build_object('ok', false, 'msg', '无设备履历编辑权限'); end if;
  delete from public.equipments where code = p_code;
  insert into public.equip_audit (at, account, name, code, action, summary)
  values (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), cu.account, cu.name, p_code, 'delete', '删除设备');
  return jsonb_build_object('ok', true);
end $$;

-- 10) 查看编辑留痕(需登录)
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

-- 11) 授予/取消工具权限(仅1级)
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

grant execute on function public.equipment_list(text) to anon;
grant execute on function public.equipment_get(text, text) to anon;
grant execute on function public.equipment_save(text, text, jsonb, text) to anon;
grant execute on function public.equipment_delete(text, text) to anon;
grant execute on function public.equipment_audit_list(text, text) to anon;
grant execute on function public.admin_set_tools(text, text, jsonb) to anon;
