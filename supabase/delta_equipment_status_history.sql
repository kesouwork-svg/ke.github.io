-- 设备状态变更时间与历史：在现有报修防重版本基础上安装，本文件完整执行一次即可。
-- 仅安装函数；不回填、不修改现有设备数据，不发送群消息、不改定时任务。
-- 先安装本增量，再发布前端；不要重跑旧增量或全量 schema。
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

create or replace function public.equipment_save(p_token text, p_code text, p_data jsonb, p_summary text)
returns jsonb language plpgsql security definer as $$
declare cu public.users%rowtype; old_data jsonb; role text; nr jsonb; oldr jsonb;
        msg text := ''; line_txt text; base text; link text; nm text; num text; ln text;
        d_done text; d_rep text; late int; who text; wo text; open_left int;
        status_history jsonb; status_request jsonb; status_from text; status_to text;
        status_effective text; status_now text; status_reason text;
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

  -- 状态历史只由服务端追加；旧页面也不能整包覆盖或删除已登记历史。
  status_history := coalesce(old_data->'_statusHistory', '[]'::jsonb);
  if coalesce(p_data->'_statusHistory', '[]'::jsonb) is distinct from status_history then
    return jsonb_build_object('ok', false, 'msg', '状态变更记录不能修改或删除，请刷新后重试');
  end if;
  status_from := coalesce(nullif(old_data->>'status', ''), 'active');
  status_to := coalesce(nullif(p_data->>'status', ''), 'active');
  if (old_data is null or status_from <> status_to) and status_to not in ('active', 'idle', 'scrapped') then
    return jsonb_build_object('ok', false, 'msg', '设备状态无效');
  end if;
  if old_data is not null and status_from <> status_to then
    if jsonb_typeof(status_history) is distinct from 'array' then
      return jsonb_build_object('ok', false, 'msg', '状态历史格式异常，请联系管理员核对');
    end if;
    status_request := coalesce(p_data->'_statusChange', '{}'::jsonb);
    if jsonb_typeof(status_request) is distinct from 'object' then
      return jsonb_build_object('ok', false, 'msg', '状态变更参数无效');
    end if;
    status_now := to_char(clock_timestamp() at time zone 'Asia/Shanghai', 'YYYY-MM-DD"T"HH24:MI');
    if status_request ? 'effectiveAt' and jsonb_typeof(status_request->'effectiveAt') is distinct from 'string' then
      return jsonb_build_object('ok', false, 'msg', '状态生效时间格式无效');
    end if;
    status_effective := coalesce(nullif(status_request->>'effectiveAt', ''), status_now);
    if length(status_effective) <> 16 or public._equip_expected_at(status_effective) is null
       or status_effective > status_now
       or (jsonb_array_length(status_history) > 0 and status_effective < status_history->-1->>'effectiveAt') then
      return jsonb_build_object('ok', false, 'msg', '请填写有效的北京时间，不能晚于当前时间或早于上次状态变更');
    end if;
    if status_request ? 'reason' and jsonb_typeof(status_request->'reason') is distinct from 'string' then
      return jsonb_build_object('ok', false, 'msg', '状态变更原因格式无效');
    end if;
    status_reason := trim(coalesce(status_request->>'reason', ''));
    if length(status_reason) > 500 then return jsonb_build_object('ok', false, 'msg', '变更原因不能超过500字'); end if;
    p_data := p_data || jsonb_build_object('_statusHistory', status_history || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text, 'from', status_from, 'to', status_to, 'effectiveAt', status_effective,
      'recordedAt', to_char(clock_timestamp() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'),
      'account', cu.account, 'name', cu.name, 'reason', status_reason)));
    -- 首次状态变更即启用已有乐观锁机制，阻止旧页面覆盖新历史。
    p_data := p_data || jsonb_build_object('_recordsRev', gen_random_uuid()::text);
    p_summary := coalesce(p_summary, '') || '；状态 ' || status_from || ' → ' || status_to || '，生效 ' || status_effective || '（北京时间）';
  end if;
  p_data := p_data - '_statusChange';

  -- 乐观版本只由服务端签发;已启用版本的设备每次写入都刷新。
  if coalesce(old_data->>'_recordsRev', '') <> '' then
    p_data := p_data || jsonb_build_object('_recordsRev', gen_random_uuid()::text);
  elsif old_data is null or status_from = status_to then p_data := p_data - '_recordsRev';
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

  return jsonb_build_object('ok', true, 'recordsRev', p_data->>'_recordsRev', 'statusHistory', coalesce(p_data->'_statusHistory', '[]'::jsonb));
end $$;

create or replace function public.equipment_archive_save(p_token text, p_code text, p_data jsonb, p_summary text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare cu public.users%rowtype; current_data jsonb; archive_patch jsonb;
begin
  select * into cu from public._get_user_by_token(p_token);
  if cu.account is null or public._equip_role(p_token) <> 'admin' then
    return jsonb_build_object('ok', false, 'msg', '仅设备管理员可修改设备档案');
  end if;
  if jsonb_typeof(p_data) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'msg', '设备档案格式错误');
  end if;
  select data into current_data from public.equipments where code = p_code for update;
  if current_data is not null then
    -- 仅合并档案可编辑字段；并发新增的工单、照片及未知扩展字段不能被旧表单覆盖。
    select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into archive_patch
    from jsonb_each(p_data) where key = any(array['name', 'number', 'line', 'family', 'category', 'owner',
      'model', 'vendor', 'installDate', 'status', 'remark', '_recordsRev', '_statusHistory', '_statusChange']);
    p_data := (current_data - '_recordsRev' - '_statusHistory') || archive_patch;
  end if;
  return public.equipment_save(p_token, p_code, p_data, p_summary);
end;
$$;

revoke all on function public.equipment_archive_save(text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.equipment_archive_save(text, text, jsonb, text) to anon;

commit;
