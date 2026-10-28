-- 报修补充：成功追加后推送一条【报修补充】，不新建工单。
-- 前置：已执行 delta_report_supplement.sql（追加、脱敏、保存保护）。
-- 在 Supabase SQL Editor 整体执行本文件；可重复，不批量改历史工单。
-- 仅替换同签名 RPC；沿用现有 _wx_send / wx_webhook，异步投递失败不回滚已保存的说明。
-- 群消息最长4096 UTF-8字节，超长说明仅截消息摘要，数据库保存完整2000码点正文。
-- 执行此文件本身不发送任何消息；不要运行旧 _run_all.sql 或再用旧补充增量覆盖本函数。

begin;

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

grant execute on function public.equipment_report_supplement(text,text,text,text) to anon;

commit;
