-- 账户管理、全量备份/恢复仅固定 admin 账号可操作。
-- 在 Supabase SQL Editor 整份执行;可重复执行,不修改账号/项目/设备数据。
-- 其它 ROI 1级账号的全量项目权限不变;设备角色与单条回收站权限不变。
-- 管理员登录账号固定为 admin,姓名/密码仍可修改;防止改名/停用/降级锁死管理入口。
begin;

-- 若内置管理员曾被改名/停用,先中止而不是收紧后把管理入口锁死。
do $preflight$
begin
  if not exists (select 1 from public.users where account = 'admin' and status = 'active') then
    raise exception '未找到正常启用的 admin 账号,本次权限收紧已中止。请先在 SQL Editor 核对管理员账号,不要直接重复执行。';
  end if;
end $preflight$;

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

commit;
