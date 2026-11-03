-- Expected completion +24h / Beijing minute precision. No data backfill, ACL reset or cron changes.
-- Function definitions below are extracted verbatim from supabase/schema.sql.
begin;

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

create or replace function public.equipment_report(p_token text, p_code text, p_symptom text, p_expected text, p_reportby text, p_place text)
returns jsonb language plpgsql security definer as $$
declare cu public.users%rowtype; role text; d jsonb; recs jsonb; rec jsonb;
        base text; link text; msg text; nm text; ln text; num text; byname text; wo text; place_txt text;
        report_minute timestamptz; at_txt text;
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

  if jsonb_typeof(d->'records') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'msg', '设备工单数据异常，请联系设备管理员');
  end if;
  report_minute := date_trunc('minute', clock_timestamp());
  at_txt := to_char(report_minute at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS');
  byname := coalesce(nullif(trim(p_reportby), ''), cu.name);
  wo := public._equip_next_no();
  rec := jsonb_build_object(
    'id', 'r' || (extract(epoch from clock_timestamp()) * 1000)::bigint,
    'no', wo,
    'type', 'fault', 'status', 'open',
    'reportAt', to_char(report_minute at time zone 'Asia/Shanghai', 'YYYY-MM-DD'),
    'reportBy', byname,
    'place', place_txt,
    'expectedAt', to_char((report_minute + interval '24 hours') at time zone 'Asia/Shanghai', 'YYYY-MM-DD"T"HH24:MI'),
    'doneAt', '', 'handler', '',
    'symptom', p_symptom,
    'cause1', '', 'cause2', '', 'cause3', '', 'cause', '', 'action', '', 'handleType', '',
    'repairMode', 'inner', 'supplier', '', 'parts', '[]'::jsonb, 'cost', 0,
    'delayReason', '', 'remark', '', 'photos', '[]'::jsonb,
    'createdAt', at_txt, 'createdBy', cu.name);
  recs := d->'records' || jsonb_build_array(rec);
  d := jsonb_set(d, '{records}', recs);
  if coalesce(d->>'_recordsRev', '') <> '' then d := d || jsonb_build_object('_recordsRev', gen_random_uuid()::text); end if;
  update public.equipments set data = d, saved_at = at_txt, updated_by = cu.account where code = p_code;
  insert into public.equip_audit (at, account, name, code, action, summary)
  values (at_txt, cu.account, cu.name, p_code, 'report', '报修:' || left(p_symptom, 30));

  base := coalesce(public._get_config('site_url'), 'https://kekits.com/equipment/');
  link := base || '?code=' || p_code || case when wo <> '' then ('&wo=' || wo) else '' end;
  nm := coalesce(d->>'name', p_code);
  ln := coalesce(d->>'line', '');
  num := coalesce(nullif(d->>'number',''), p_code);
  msg := '**【新报修】' || wo || E'**\n'
      || '> 设备:' || public._equip_label(d) || E'\n'
      || case when place_txt <> '' then ('> 位置:' || replace(place_txt, E'\n', ' ') || E'\n') else '' end
      || '> 现象:' || replace(p_symptom, E'\n', ' ') || E'\n'
      || '> 报修人:' || byname || '   ' || to_char(report_minute at time zone 'Asia/Shanghai', 'MM-DD HH24:MI') || E'\n'
      || '[▶ 去处理](' || link || ')';
  perform public._wx_send(msg);

  return jsonb_build_object('ok', true, 'no', wo);
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

grant execute on function public.equipment_set_expected(text, text, text, text) to anon;

commit;
