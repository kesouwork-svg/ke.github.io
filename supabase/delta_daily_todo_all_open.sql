-- 每日维修提醒改为全部未完成（2026-10-30）
-- 只替换原有2个函数；不改工单/预计日期/权限/cron，不调用发送函数。
-- Supabase SQL Editor 整份执行；原工作日北京时间08:00任务保持不变。
-- 执行后可另行只读核对：select public._equip_todo_msg(false);
-- 上述只生成内容，不发送；不要调用 equip_daily_push/equip_daily_test 补测真实群。
begin;

create or replace function public._equip_todo_msg(p_test boolean default false)
returns jsonb language plpgsql security definer as $$
declare
  d date := (now() at time zone 'Asia/Shanghai')::date;
  rec record; pick jsonb; picks jsonb := '[]'::jsonb;
  sv jsonb; dv jsonb; done boolean; exp date; raw_date text;
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
    exp := null;
    if raw_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      begin
        exp := raw_date::date;
      exception when invalid_datetime_format or datetime_field_overflow then
        exp := null;
      end;
    end if;
    if raw_date = '' then
      unscheduled := unscheduled + 1; kind_rank := 2;
      one := '未排期（未设置预计日期）';
    elsif exp is null then
      date_unknown := date_unknown + 1; kind_rank := 3;
      one := '预计日期待核';
    elsif exp < d then
      overdue := overdue + 1; kind_rank := 0;
      one := '逾期 ' || (d - exp) || ' 天';
    elsif exp = d then
      due_today := due_today + 1; kind_rank := 1;
      one := '今天到期';
    else
      upcoming := upcoming + 1; kind_rank := 4;
      one := '未到期 · 预计 ' || to_char(exp, 'YYYY-MM-DD');
    end if;
    date_rank := case when exp is null then '' else to_char(exp, 'YYYY-MM-DD') end;

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

-- 仍只由原工作日08:00任务调用；北京时间与消息的“今天”一致。
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

commit;
