-- Cumulative report-idempotency + 24h/Beijing-time installer: install this file alone.
-- Canonical 16 prior definitions + equipment_report_once; no backfill, notifications, retention, global ACL/TimeZone or cron changes.
-- Permanent minimal ledger is independent of device JSON; no pending receipt and no token/password storage.
begin;

create table if not exists public.equipment_report_requests (
  account text not null,
  operation text not null check (operation = 'equipment_report'),
  request_id uuid not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  receipt jsonb not null check (jsonb_typeof(receipt) = 'object'
    and receipt ?& array['ok', 'code', 'recordId', 'no', 'expectedAt', 'replayed']
    and receipt->'ok' = 'true'::jsonb and receipt->'replayed' = 'false'::jsonb
    and coalesce(receipt->>'code', '') <> '' and coalesce(receipt->>'recordId', '') <> ''
    and coalesce(receipt->>'no', '') <> '' and coalesce(receipt->>'expectedAt', '') <> ''),
  primary key (account, operation, request_id)
);
alter table public.equipment_report_requests enable row level security;
revoke all on public.equipment_report_requests from public, anon, authenticated;

drop function if exists public.equipment_report(text, text, text, text, text);

create or replace function public._equip_expected_at(p_value text)
returns timestamptz language plpgsql immutable set search_path = pg_catalog as $$
declare local_at timestamp; hh int := 0; mi int := 0;
begin
  if p_value is null or p_value = '' then return null; end if;
  if not ((length(p_value) = 10 and p_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
    or (length(p_value) = 16 and p_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$')) then
    return null;
  end if;
  if length(p_value) = 16 then
    hh := substring(p_value from 12 for 2)::int;
    mi := substring(p_value from 15 for 2)::int;
    if hh > 23 or mi > 59 then return null; end if;
  end if;
  local_at := make_timestamp(substring(p_value from 1 for 4)::int,
    substring(p_value from 6 for 2)::int, substring(p_value from 9 for 2)::int, hh, mi, 0);
  if length(p_value) = 10 then
    local_at := local_at + interval '1 day' - interval '1 millisecond';
  end if;
  return local_at at time zone 'Etc/GMT-8';
exception when invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
  return null;
end $$;

create or replace function public._equip_next_no()
returns text language plpgsql security definer as $$
declare
  v_day text;
  v_n int;
begin
  v_day := to_char(now() at time zone 'Asia/Shanghai', 'YYMMDD');
  insert into public.equip_seq as s (day, n) values (v_day, 1)
  on conflict (day) do update set n = s.n + 1
  returning s.n into v_n;
  return 'WO' || v_day || '-' || lpad(v_n::text, greatest(2, length(v_n::text)), '0');
end $$;

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
  values (cd, dat, to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'), 'system')
  on conflict (code) do nothing;
  return cd;
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
  values ('equip_group_order', obj::text, to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'))
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
  return jsonb_build_object('ok', true, 'n', (select count(*) from jsonb_object_keys(obj)));
end $$;

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
  select to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'), u.account, u.name, e.code, 'save',
         '设备类别改名：' || o || ' → ' || nn
    from public.equipments e
   where coalesce(e.data->>'family', '') = o;

  -- 2) 改档案(只动 family,履历原样保留)
  update public.equipments e
     set data = jsonb_set(e.data, '{family}', to_jsonb(nn), true),
         saved_at = to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'),
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
      values ('equip_group_order', obj::text, to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'))
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'n', n, 'merged', hit > 0, 'merged_n', hit);
end $$;

create or replace function public.equipment_set_expected(p_token text, p_code text, p_record_id text, p_expected text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare cu public.users%rowtype; d jsonb; rec jsonb; changed jsonb; recs jsonb;
        matches int; expected_txt text := coalesce(p_expected, ''); at_txt text;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if public._equip_role(p_token) not in ('admin', 'repairer') then
    return jsonb_build_object('ok', false, 'msg', '无预计完成调整权限');
  end if;
  if coalesce(p_code, '') = '' or coalesce(p_record_id, '') = '' then
    return jsonb_build_object('ok', false, 'msg', '请选择设备和工单');
  end if;
  if expected_txt <> '' and public._equip_expected_at(expected_txt) is null then
    return jsonb_build_object('ok', false, 'msg', '预计完成格式错误，请使用北京时间日期或日期T时分');
  end if;
  select e.data into d from public.equipments e where e.code = p_code for update;
  if d is null then return jsonb_build_object('ok', false, 'msg', '设备不存在，请刷新'); end if;
  if jsonb_typeof(d->'records') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'msg', '设备工单数据异常，请联系设备管理员');
  end if;
  select count(*) into matches from jsonb_array_elements(d->'records') as rr(item) where rr.item->>'id' = p_record_id;
  if matches <> 1 then return jsonb_build_object('ok', false, 'msg', '工单不存在、已移动或编号重复，请刷新'); end if;
  select r into rec from jsonb_array_elements(d->'records') r where r->>'id' = p_record_id;
  at_txt := to_char(clock_timestamp() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS');
  changed := rec || jsonb_build_object('expectedAt', expected_txt, 'updatedAt', at_txt,
    'updatedBy', coalesce(nullif(cu.name, ''), cu.account));
  select jsonb_agg(case when r->>'id' = p_record_id then changed else r end order by ord) into recs
    from jsonb_array_elements(d->'records') with ordinality a(r, ord);
  d := jsonb_set(d, '{records}', recs) || jsonb_build_object('_recordsRev', gen_random_uuid()::text);
  update public.equipments set data = d, saved_at = at_txt, updated_by = cu.account where code = p_code;
  insert into public.equip_audit(at, account, name, code, action, summary)
    values (at_txt, cu.account, cu.name, p_code, 'expected',
      '调整预计完成 ' || coalesce(nullif(rec->>'no', ''), p_record_id) || '：'
      || coalesce(rec->>'expectedAt', '') || ' → ' || case when expected_txt = '' then '未排期' else expected_txt end);
  return jsonb_build_object('ok', true, 'code', p_code, 'equipment', d, 'expectedAt', expected_txt);
end $$;

create or replace function public.equipment_report(p_token text, p_code text, p_symptom text, p_expected text, p_reportby text, p_place text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare cu public.users%rowtype;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  if public._equip_role(p_token) not in ('admin', 'repairer', 'reporter') then
    return jsonb_build_object('ok', false, 'msg', '无报修权限');
  end if;
  return jsonb_build_object('ok', false, 'code', 'PAGE_UPGRADE_REQUIRED', 'msg', '报修页面已升级，请刷新页面后重试');
end $$;

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

  at_txt := to_char(clock_timestamp() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS');
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
  at_txt := to_char(clock_timestamp() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS');
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

  -- 只校验这次有意改变的预计值;原样保留的坏历史不阻止其他字段保存,也不自动回填。
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_data->'records', '[]'::jsonb)) n
    left join jsonb_array_elements(coalesce(old_data->'records', '[]'::jsonb)) o on o->>'id' = n->>'id'
    where n->'expectedAt' is distinct from o->'expectedAt'
      and coalesce(n->>'expectedAt', '') <> ''
      and (jsonb_typeof(n->'expectedAt') is distinct from 'string'
        or public._equip_expected_at(n->>'expectedAt') is null)
  ) then
    return jsonb_build_object('ok', false, 'msg', '预计完成格式错误，请使用北京时间日期或日期T时分');
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
  values (p_code, p_data, to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'), cu.account)
  on conflict (code) do update set data = excluded.data, saved_at = excluded.saved_at, updated_by = excluded.updated_by;

  insert into public.equip_audit (at, account, name, code, action, summary)
  values (to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'), cu.account, cu.name, p_code, 'save', coalesce(p_summary, ''));

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
        -- 完成只登记了日期,只能按预计的北京日期部分比较,不虚构小时级完工时刻。
        if d_done ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
           and public._equip_expected_at(d_done) is not null
           and public._equip_expected_at(nr->>'expectedAt') is not null
           and d_done::date > left(nr->>'expectedAt', 10)::date then
          late := d_done::date - left(nr->>'expectedAt', 10)::date;
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

create or replace function public.equipment_reply(p_token text, p_code text, p_record_id text, p_text text, p_expected text)
returns jsonb language plpgsql security definer as $$
declare cu public.users%rowtype; role text; d jsonb; recs jsonb := '[]'::jsonb; r jsonb;
        hit boolean := false; base text; link text; msg text; nm text; num text; ln text;
        wo text; at_txt text; upd jsonb; matches int; sv jsonb; dv jsonb; done boolean;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  role := public._equip_role(p_token);
  if role not in ('admin', 'repairer') then return jsonb_build_object('ok', false, 'msg', '无回应权限'); end if;
  if coalesce(trim(p_text), '') = '' then return jsonb_build_object('ok', false, 'msg', '请填写回应内容'); end if;
  if coalesce(p_expected, '') <> '' and public._equip_expected_at(p_expected) is null then
    return jsonb_build_object('ok', false, 'msg', '预计完成格式错误，请使用北京时间日期或日期T时分');
  end if;
  select e.data into d from public.equipments e where e.code = p_code for update;
  if d is null then return jsonb_build_object('ok', false, 'msg', '设备不存在'); end if;
  if jsonb_typeof(d->'records') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'msg', '设备工单数据异常，请联系设备管理员');
  end if;
  select count(*) into matches from jsonb_array_elements(d->'records') as rr(item) where rr.item->>'id' = p_record_id;
  if matches <> 1 then return jsonb_build_object('ok', false, 'msg', '工单不存在、已移动或编号重复，请刷新'); end if;

  at_txt := to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI');
  upd := jsonb_build_object('at', at_txt, 'by', cu.name, 'text', trim(p_text));

  for r in select * from jsonb_array_elements(coalesce(d->'records', '[]'::jsonb)) loop
    if (r->>'id') = p_record_id then
      -- 与前端 isDone / 每日待办一致:先按JSON真值回退,显式真值状态优先。
      sv := r->'status'; dv := r->'doneAt';
      if sv is null or sv in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb) then
        done := not (dv is null or dv in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb));
      else
        done := sv = '"done"'::jsonb;
      end if;
      if done then
        return jsonb_build_object('ok', false, 'msg', '该工单已完成,无需回应');
      end if;
      if r ? 'updates' and jsonb_typeof(r->'updates') is distinct from 'array' then
        return jsonb_build_object('ok', false, 'msg', '回应记录数据异常，请联系设备管理员');
      end if;
      r := jsonb_set(r, '{updates}', coalesce(r->'updates', '[]'::jsonb) || jsonb_build_array(upd));
      -- 两种处理角色均可设置合法非空预计;空参数仍保留原值,清除走专用RPC。
      if coalesce(p_expected, '') <> '' then
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
         saved_at = to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'),
         updated_by = cu.account
   where code = p_code;
  insert into public.equip_audit (at, account, name, code, action, summary)
  values (to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'), cu.account, cu.name, p_code, 'reply', '回应:' || left(trim(p_text), 30));

  base := coalesce(public._get_config('site_url'), 'https://kekits.com/equipment/');
  nm := coalesce(d->>'name', p_code);
  num := coalesce(nullif(d->>'number',''), p_code);
  ln := coalesce(d->>'line', '');
  select o->>'no' into wo from jsonb_array_elements(recs) o where o->>'id' = p_record_id limit 1;
  link := base || '?code=' || p_code || case when coalesce(wo,'') <> '' then ('&wo=' || wo) else '' end;
  msg := '**【进度】' || case when coalesce(wo,'') <> '' then wo else public._equip_label(d) end || E'**\n'
      || '> 设备:' || public._equip_label(d) || E'\n'
      || '> 说明:' || replace(trim(p_text), E'\n', ' ') || E'\n'
      || '> 回复人:' || cu.name || '   ' || to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI') || E'\n'
      || '[▶ 查看设备](' || link || ')';
  perform public._wx_send(msg);

  return jsonb_build_object('ok', true, 'update', upd);
end $$;

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
  values (to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'), cu.account, cu.name, p_code, 'delete', '删除设备');
  return jsonb_build_object('ok', true);
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
  values (trim(p_code), p_data, coalesce(nullif(p_saved_at, ''), to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')), u.account)
  on conflict (code) do update set data = excluded.data, saved_at = excluded.saved_at, updated_by = excluded.updated_by;
  return jsonb_build_object('ok', true);
end $$;

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
    values (r.ref_key, r.snapshot || jsonb_build_object('_recordsRev', gen_random_uuid()::text), to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'), u.account)
    on conflict (code) do update
       set data = excluded.data, saved_at = excluded.saved_at, updated_by = excluded.updated_by;
    insert into public.equip_audit (at, account, name, code, action, summary)
    values (to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'), u.account, u.name, r.ref_key, 'restore',
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
           saved_at = to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'),
           updated_by = u.account
     where code = r.ref_key;
    insert into public.equip_audit (at, account, name, code, action, summary)
    values (to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'), u.account, u.name, r.ref_key, 'restore',
            '从回收站恢复工单' || case when coalesce(r.snapshot->>'no', '') <> ''
                                     then ' ' || (r.snapshot->>'no') else '' end);
  else
    return jsonb_build_object('ok', false, 'msg', '这条不属于设备回收站');
  end if;

  delete from public.recycle_bin where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public._equip_todo_msg(p_test boolean default false)
returns jsonb language plpgsql security definer as $$
declare
  d date := (now() at time zone 'Asia/Shanghai')::date;
  rec record; pick jsonb; picks jsonb := '[]'::jsonb;
  sv jsonb; dv jsonb; done boolean; exp date; raw_date text;
  absolute_now timestamptz := now(); deadline timestamptz;
  ups jsonb; t text; tag text; one text; kind_rank int; date_rank text;
  overdue int := 0; due_today int := 0; upcoming int := 0;
  unscheduled int := 0; date_unknown int := 0; total int := 0; shown int := 0;
  lines text := ''; msg text; base text; link text; head text;
  sampled boolean := false;
begin
  for rec in
    select e.code, e.data, r, ord
      from public.equipments e
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(e.data->'records') = 'array' then e.data->'records' else '[]'::jsonb end
      ) with ordinality as rr(r, ord)
     where jsonb_typeof(e.data) = 'object' and jsonb_typeof(r) = 'object'
     order by e.code, ord
  loop
    -- 与前端 isDone 的真值/显式状态优先级一致；不按GEN/部门/预计日期排除。
    sv := rec.r->'status'; dv := rec.r->'doneAt';
    if sv is null or sv in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb) then
      done := not (dv is null or dv in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb));
    else
      done := sv = '"done"'::jsonb;
    end if;
    if done then continue; end if;
    total := total + 1;

    raw_date := btrim(coalesce(rec.r->>'expectedAt', ''));
    deadline := public._equip_expected_at(raw_date);
    exp := (deadline at time zone 'Etc/GMT-8')::date;
    if raw_date = '' then
      unscheduled := unscheduled + 1; kind_rank := 2;
      one := '未排期（未设置预计日期）';
    elsif exp is null then
      date_unknown := date_unknown + 1; kind_rank := 3;
      one := '预计日期待核';
    elsif deadline < absolute_now then
      overdue := overdue + 1; kind_rank := 0;
      one := case when exp < d then '逾期 ' || (d - exp) || ' 天'
        else '逾期（预计 ' || replace(raw_date, 'T', ' ') || '）' end;
    elsif exp = d then
      due_today := due_today + 1; kind_rank := 1;
      one := '今天到期';
    else
      upcoming := upcoming + 1; kind_rank := 4;
      one := '未到期 · 预计 ' || to_char(exp, 'YYYY-MM-DD');
    end if;
    date_rank := case when deadline is null then ''
      else to_char(deadline at time zone 'Etc/GMT-8', 'YYYY-MM-DD"T"HH24:MI:SS.MS') end;

    -- 保留原简短进度；坏updates不阻断其他工单的每日提醒。
    tag := ''; ups := rec.r->'updates';
    if jsonb_typeof(ups) = 'array' then
      if jsonb_array_length(ups) > 0 then
        t := btrim(coalesce(ups -> (jsonb_array_length(ups) - 1) ->> 'text', ''));
        t := replace(replace(t, E'\r', ' '), E'\n', ' ');
        if t <> '' then
          if position('备件' in t) > 0 then tag := '等备件';
          elsif position('外协' in t) > 0 then tag := '等外协';
          elsif position('采购' in t) > 0 then tag := '待采购';
          elsif position('停机' in t) > 0 or position('窗口' in t) > 0 then tag := '等停机窗口';
          else tag := left(t, 10) || case when length(t) > 10 then '…' else '' end;
          end if;
        end if;
      end if;
    end if;
    one := coalesce(nullif(rec.r->>'no', ''), '(无单号)') || ' '
           || public._equip_label(rec.data) || ' · ' || one
           || case when tag <> '' then ' · ' || tag else '' end;

    -- 仅在内存保留优先级最高5条，总数始终累计全部；不修改/补齐源记录。
    select coalesce(jsonb_agg(x order by (x->>'rank')::int, x->>'date', x->>'no', x->>'code', x->>'id', (x->>'ord')::bigint), '[]'::jsonb)
      into picks
      from (
        select x from jsonb_array_elements(picks || jsonb_build_array(jsonb_build_object(
          'rank', kind_rank, 'date', date_rank, 'no', coalesce(rec.r->>'no', ''),
          'code', rec.code, 'id', coalesce(rec.r->>'id', ''), 'ord', rec.ord, 'line', one
        ))) x
        order by (x->>'rank')::int, x->>'date', x->>'no', x->>'code', x->>'id', (x->>'ord')::bigint
        limit 5
      ) chosen;
  end loop;

  for pick in select value from jsonb_array_elements(picks) loop
    shown := shown + 1;
    lines := lines || shown || '. ' || (pick->>'line') || E'\n';
  end loop;

  -- 无真实待办时的手动测试样例，数量/分类/展示条数也保持一致。
  if total = 0 and p_test then
    sampled := true; total := 5; shown := 5;
    overdue := 2; due_today := 1; unscheduled := 1; upcoming := 1;
    lines := '1. DEMO-01 示例设备A · 逾期 3 天 · 等备件' || E'\n'
          || '2. DEMO-02 示例设备B · 逾期 1 天' || E'\n'
          || '3. DEMO-03 示例设备C · 今天到期' || E'\n'
          || '4. DEMO-04 通用报修 · 示例车间 · 未排期（未设置预计日期）' || E'\n'
          || '5. DEMO-05 示例设备D · 未到期 · 预计 ' || to_char(d + 1, 'YYYY-MM-DD') || E'\n';
  end if;

  base := coalesce(nullif(btrim(public._get_config('site_url')), ''), 'https://kekits.com/equipment/');
  link := base || '?todo=1';
  head := case when p_test then '【测试】' else '' end
          || '【今日待办】' || to_char(d, 'MM-DD') || ' 周'
          || (array['日','一','二','三','四','五','六'])[extract(dow from d)::int + 1];
  msg := head || E'\n' || '当前未完成 ' || total || ' 单' || E'\n'
      || '逾期 ' || overdue || ' 单 · 今天到期 ' || due_today || ' 单' || E'\n'
      || '未排期 ' || unscheduled || ' 单 · 未到期 ' || upcoming || ' 单'
      || case when date_unknown > 0 then E'\n预计日期待核 ' || date_unknown || ' 单' else '' end
      || E'\n\n' || lines;
  if total > shown then
    msg := msg || '仅列前 ' || shown || ' 单（逾期、今天到期、未排期、日期待核、未到期依次优先）' || E'\n';
  end if;
  msg := msg || E'\n[▶ 查看全部 ' || total || ' 单未完成](' || link || ')';
  if sampled then msg := msg || E'\n\n> 以上为测试样例（当前没有未完成工单）'; end if;
  return jsonb_build_object('msg', msg, 'total', total, 'overdue', overdue, 'due_today', due_today,
    'upcoming', upcoming, 'unscheduled', unscheduled, 'date_unknown', date_unknown, 'shown', shown);
end $$;

create or replace function public.equip_daily_push()
returns jsonb language plpgsql security definer as $$
declare r jsonb;
  d date := (now() at time zone 'Asia/Shanghai')::date;
begin
  if extract(dow from d)::int in (0, 6) then
    return jsonb_build_object('ok', true, 'skipped', 'weekend');
  end if;
  r := public._equip_todo_msg(false);
  if coalesce((r->>'total')::int, 0) = 0 then
    return jsonb_build_object('ok', true, 'skipped', 'empty');
  end if;
  perform public._wx_send(r->>'msg');
  return jsonb_build_object('ok', true, 'sent', true, 'total', (r->>'total')::int);
end $$;

create or replace function public.equipment_report_once(p_token text, p_code text, p_symptom text, p_expected text, p_reportby text, p_place text, p_request_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare cu public.users%rowtype; role text; d jsonb; rec jsonb;
        base text; link text; msg text; byname text; wo text; record_id text;
        report_minute timestamptz; at_txt text; expected_txt text;
        code_txt text; symptom_txt text; place_txt text; reportby_txt text;
        trim_chars constant text := U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
        request_uuid uuid; payload_value jsonb; old_payload jsonb; receipt_value jsonb; old_receipt jsonb;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null then return jsonb_build_object('ok', false, 'msg', '未登录或无权限'); end if;
  role := public._equip_role(p_token);
  if role not in ('admin', 'repairer', 'reporter') then return jsonb_build_object('ok', false, 'msg', '无报修权限'); end if;
  if p_request_id is null or length(p_request_id) <> 36
    or p_request_id !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST_ID', 'msg', '请求编号必须为标准UUID，请刷新页面后重试');
  end if;
  request_uuid := p_request_id::uuid;
  code_txt := coalesce(p_code, '');
  symptom_txt := btrim(coalesce(p_symptom, ''), trim_chars);
  place_txt := btrim(coalesce(p_place, ''), trim_chars);
  reportby_txt := btrim(coalesce(p_reportby, ''), trim_chars);
  payload_value := jsonb_build_object('code', code_txt, 'symptom', symptom_txt, 'place', place_txt, 'reportby', reportby_txt);
  select q.payload, q.receipt into old_payload, old_receipt from public.equipment_report_requests q
    where q.account = cu.account and q.operation = 'equipment_report' and q.request_id = request_uuid;
  if found then
    if old_payload <> payload_value then
      return jsonb_build_object('ok', false, 'code', 'REQUEST_ID_CONFLICT', 'msg', '请求编号已用于其他报修内容');
    end if;
    return old_receipt || jsonb_build_object('replayed', true);
  end if;
  if code_txt = '' then return jsonb_build_object('ok', false, 'msg', '请选择设备'); end if;
  if symptom_txt = '' then return jsonb_build_object('ok', false, 'msg', '请填写故障现象'); end if;
  if place_txt = '' then return jsonb_build_object('ok', false, 'msg', '请填写设备位置'); end if;
  -- code主键保证唯一设备。先锁设备行,再以唯一请求键占用创建权。
  select e.data into d from public.equipments e where e.code = code_txt for update;
  -- 等锁期间其他同key请求可能已完成;必须先重查回执,不依赖原设备/原单仍存在。
  select q.payload, q.receipt into old_payload, old_receipt from public.equipment_report_requests q
    where q.account = cu.account and q.operation = 'equipment_report' and q.request_id = request_uuid;
  if found then
    if old_payload <> payload_value then
      return jsonb_build_object('ok', false, 'code', 'REQUEST_ID_CONFLICT', 'msg', '请求编号已用于其他报修内容');
    end if;
    return old_receipt || jsonb_build_object('replayed', true);
  end if;
  if d is null then return jsonb_build_object('ok', false, 'msg', '设备不存在'); end if;
  if role = 'reporter' then
    if coalesce(trim(cu.dept), '') = '' then
      return jsonb_build_object('ok', false, 'msg', '账号未设置车间,请联系管理员');
    end if;
    if coalesce(d->>'line', '') <> trim(cu.dept) then
      return jsonb_build_object('ok', false, 'msg', '只能报修本车间(' || trim(cu.dept) || ')的设备');
    end if;
  end if;
  if jsonb_typeof(d->'records') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'msg', '设备工单数据异常，请联系设备管理员');
  end if;
  report_minute := date_trunc('minute', clock_timestamp());
  at_txt := to_char(report_minute at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS');
  expected_txt := to_char((report_minute + interval '24 hours') at time zone 'Asia/Shanghai', 'YYYY-MM-DD"T"HH24:MI');
  byname := coalesce(nullif(reportby_txt, ''), cu.name);
  record_id := 'r' || gen_random_uuid()::text;
  begin
    -- 子事务:若另一个设备上的同key请求抢先提交,唯一冲突连同本次流水增量回滚。
    wo := public._equip_next_no();
    receipt_value := jsonb_build_object('ok', true, 'code', code_txt, 'recordId', record_id,
      'no', wo, 'expectedAt', expected_txt, 'replayed', false);
    insert into public.equipment_report_requests(account, operation, request_id, payload, receipt)
      values(cu.account, 'equipment_report', request_uuid, payload_value, receipt_value);
  exception when unique_violation then
    select q.payload, q.receipt into old_payload, old_receipt from public.equipment_report_requests q
      where q.account = cu.account and q.operation = 'equipment_report' and q.request_id = request_uuid;
    if not found then raise; end if;
    if old_payload <> payload_value then
      return jsonb_build_object('ok', false, 'code', 'REQUEST_ID_CONFLICT', 'msg', '请求编号已用于其他报修内容');
    end if;
    return old_receipt || jsonb_build_object('replayed', true);
  end;
  rec := jsonb_build_object(
    'id', record_id, 'no', wo, 'type', 'fault', 'status', 'open',
    'reportAt', to_char(report_minute at time zone 'Asia/Shanghai', 'YYYY-MM-DD'),
    'reportBy', byname, 'place', place_txt, 'expectedAt', expected_txt,
    'doneAt', '', 'handler', '', 'symptom', symptom_txt,
    'cause1', '', 'cause2', '', 'cause3', '', 'cause', '', 'action', '', 'handleType', '',
    'repairMode', 'inner', 'supplier', '', 'parts', '[]'::jsonb, 'cost', 0,
    'delayReason', '', 'remark', '', 'photos', '[]'::jsonb,
    'createdAt', at_txt, 'createdBy', cu.name);
  d := jsonb_set(d, '{records}', d->'records' || jsonb_build_array(rec));
  if coalesce(d->>'_recordsRev', '') <> '' then d := d || jsonb_build_object('_recordsRev', gen_random_uuid()::text); end if;
  update public.equipments set data = d, saved_at = at_txt, updated_by = cu.account where code = code_txt;
  insert into public.equip_audit (at, account, name, code, action, summary)
    values (at_txt, cu.account, cu.name, code_txt, 'report', '报修:' || left(symptom_txt, 30));
  base := coalesce(public._get_config('site_url'), 'https://kekits.com/equipment/');
  link := base || '?code=' || code_txt || '&wo=' || wo;
  msg := '**【新报修】' || wo || E'**\n'
      || '> 设备:' || public._equip_label(d) || E'\n'
      || '> 位置:' || replace(place_txt, E'\n', ' ') || E'\n'
      || '> 现象:' || replace(symptom_txt, E'\n', ' ') || E'\n'
      || '> 报修人:' || byname || '   ' || to_char(report_minute at time zone 'Asia/Shanghai', 'MM-DD HH24:MI') || E'\n'
      || '[▶ 去处理](' || link || ')';
  perform public._wx_send(msg);
  return receipt_value;
end $$;

revoke all on function public.equipment_report_once(text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.equipment_report_once(text, text, text, text, text, text, text) to anon;
grant execute on function public.equipment_report(text, text, text, text, text, text) to anon;
grant execute on function public.equipment_set_expected(text, text, text, text) to anon;

commit;
