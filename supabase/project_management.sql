-- Install in the existing site's Supabase SQL Editor after users and sessions.
begin;

create table if not exists public.pm_projects (
  id uuid primary key,
  owner_account text references public.users(account) on update cascade on delete set null,
  status text not null default 'planned' check (status in ('planned','active','done','paused')),
  plan jsonb not null,
  progress jsonb not null default '[]',
  annual jsonb not null default '{}',
  revision integer not null default 1,
  updated_at timestamptz not null default now()
);

-- Preserve any records from an installation of the initial local prototype.
do $$
begin
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='pm_projects' and column_name='status') then
    alter table public.pm_projects add column status text not null default 'planned'
      check (status in ('planned','active','done','paused'));
    alter table public.pm_projects add column progress jsonb not null default '[]';
    update public.pm_projects p set
      status = case p.stage when 'implementation' then 'active' when 'accepted' then 'done' else 'planned' end,
      progress = coalesce((
        select jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'date',event_day,'note',note) order by event_day, seq)
        from (
          select ((h->>'at')::timestamptz at time zone 'Asia/Shanghai')::date as event_day, ord as seq, h->>'note' as note
          from jsonb_array_elements(p.history) with ordinality as entries(h,ord) where nullif(h->>'note','') is not null
          union all
          select coalesce(nullif(m->>'done',''),m->>'due')::date, ord, concat_ws(' · ',m->>'title',m->>'responsible',case when m->>'done' is null then '计划' else '完成' end)
          from jsonb_array_elements(p.milestones) with ordinality as entries(m,ord)
        ) notes
      ),'[]'::jsonb);
  end if;
end $$;
alter table public.pm_projects drop constraint if exists pm_projects_status_check;
alter table public.pm_projects add constraint pm_projects_status_check
  check (status in ('planned','active','done','paused','terminated'));
alter table public.pm_projects add column if not exists status_history jsonb not null default '[]';
create index if not exists pm_projects_owner on public.pm_projects(owner_account);
alter table public.pm_projects add column if not exists books jsonb not null default '{}';
-- Pin the year of undated legacy values before later edits change the due date.
alter table public.pm_projects add column if not exists legacy_book_year text;
alter table public.pm_projects add column if not exists ledger jsonb not null default '{}';
update public.pm_projects p set legacy_book_year=coalesce(
  (select min(y) from jsonb_object_keys(p.annual || p.books) y where y ~ '^(20|21)[0-9]{2}$'),
  case when left(p.plan->>'due',4) ~ '^(20|21)[0-9]{2}$' then left(p.plan->>'due',4) end,
  to_char(p.updated_at at time zone 'Asia/Shanghai','YYYY'))
where legacy_book_year is null and (books ? 'plan' or plan ?| array['investment','benefit','cost','people']);
alter table public.pm_projects enable row level security;
revoke all on public.pm_projects from public, anon, authenticated;

create or replace function public.pm_list(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u public.users%rowtype;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then raise exception '登录已过期，请重新登录'; end if;
  if u.must_change_pwd then raise exception '请先修改密码'; end if;
  if u.level=0 then raise exception '当前账号无项目台账权限'; end if;
  return coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object(
      'owner_name', owner.name, 'can_view_all', u.level=1) order by p.updated_at desc, p.id)
    from public.pm_projects p left join public.users owner on owner.account=p.owner_account
    where u.level=1 or p.owner_account=u.account), '[]'::jsonb);
end $$;

create or replace function public.pm_apply(p_token text, p_id uuid, p_revision integer, p_action text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  u public.users%rowtype;
  p public.pm_projects%rowtype;
  plan_data jsonb;
  new_status text;
  note text := btrim(coalesce(p_input->>'note',''));
  entry jsonb;
  entry_index integer;
  record_year integer;
  amount_key text;
  card jsonb;
  line jsonb;
  period_key text;
  operated_at timestamptz := statement_timestamp();
  effective_at timestamptz;
begin
  select * into u from public._get_user_by_token(p_token);
  if u.account is null then raise exception '登录已过期，请重新登录'; end if;
  if u.must_change_pwd then raise exception '请先修改密码'; end if;
  if u.level=0 then raise exception '当前账号无项目台账权限'; end if;
  if p_id is null or jsonb_typeof(p_input) is distinct from 'object' or
     length(p_input::text)>(case when p_action='book' then 2000000 else 24000 end) then
    raise exception '记录内容无效或过长';
  end if;
  if p_action='create' then
    if p_revision is distinct from 0 then raise exception '新项目版本无效'; end if;
  else
    select * into p from public.pm_projects where id=p_id and (u.level=1 or owner_account=u.account) for update;
    if not found then raise exception '项目不存在或无访问权限'; end if;
    if p_revision is distinct from p.revision then raise exception '项目已更新，请重新载入后再保存'; end if;
  end if;

  if p_action in ('create','save','status_time') then
    effective_at := coalesce(nullif(p_input->>'effective_at','')::timestamptz,operated_at);
    if not isfinite(effective_at) then raise exception '时间无效'; end if;
  end if;
  if p_action in ('create','save') then
    plan_data := jsonb_strip_nulls(p_input->'plan');
    if jsonb_typeof(plan_data) is distinct from 'object' or nullif(btrim(plan_data->>'title'),'') is null then
      raise exception '请填写项目名称';
    end if;
    new_status := coalesce(p_input->>'status',p.status,'planned');
    if new_status not in ('planned','active','done','paused','terminated') then raise exception '项目状态无效'; end if;
    if nullif(plan_data->>'due','') is not null then perform (plan_data->>'due')::date; end if;
    foreach amount_key in array array['investment','benefit','cost','people','salary','months'] loop
      if plan_data ? amount_key and (jsonb_typeof(plan_data->amount_key) <> 'number' or
        (plan_data->>amount_key)::numeric not between 0 and 999999999) then raise exception '测算数值无效'; end if;
    end loop;
    if (plan_data->>'months')::numeric > 12 then raise exception '年计薪月数不能超过 12'; end if;
    if p_action='create' then
      entry := jsonb_build_object('id',gen_random_uuid(),'kind','created','to',new_status,'at',effective_at,'recorded_at',operated_at);
      insert into public.pm_projects(id,owner_account,plan,status,status_history)
        values(p_id,u.account,plan_data,new_status,jsonb_build_array(entry))
        on conflict (id) do nothing returning * into p;
      if not found then
        select * into p from public.pm_projects where id=p_id and owner_account=u.account;
        if not found or p.revision<>1 or p.plan is distinct from plan_data or p.status<>new_status
          or (nullif(p_input->>'effective_at','') is not null and
              (p.status_history->0->>'at')::timestamptz is distinct from effective_at) then
          raise exception '项目已更新，请重新载入后再保存';
        end if;
      end if;
      return to_jsonb(p);
    end if;
    p.plan := plan_data;
    if p.status<>new_status then
      p.status_history := p.status_history || jsonb_build_object('id',gen_random_uuid(),'kind','status',
        'from',p.status,'to',new_status,'at',effective_at,'recorded_at',operated_at);
    end if;
    p.status := new_status;
  elsif p_action='status_time' then
    if p_input ? 'id' then
      select ord::int-1 into entry_index from jsonb_array_elements(p.status_history) with ordinality as h(item,ord)
        where item->>'id'=p_input->>'id';
      if not found then raise exception '找不到这条状态记录'; end if;
      p.status_history := jsonb_set(p.status_history,array[entry_index::text,'at'],to_jsonb(effective_at));
    elsif p_input->>'missing'='created' and not (p.status_history @> '[{"kind":"created"}]') then
      entry := jsonb_build_object('id',gen_random_uuid(),'kind','created','at',effective_at,'recorded_at',operated_at);
      p.status_history := jsonb_build_array(entry) || p.status_history;
    elsif p_input->>'missing'='status' and not exists(
      select 1 from jsonb_array_elements(p.status_history) h where h ? 'to') then
      p.status_history := p.status_history || jsonb_build_object('id',gen_random_uuid(),'kind','status',
        'to',p.status,'at',effective_at,'recorded_at',operated_at);
    else raise exception '此时间已记录或补录类型无效';
    end if;
  elsif p_action='book' then
    period_key := p_input->>'period';
    if period_key is null or period_key !~ '^(20|21)[0-9]{2}$' or
       jsonb_typeof(p_input->'cards') is distinct from 'array' then raise exception '收支记录格式无效'; end if;
    for card in select value from jsonb_array_elements(p_input->'cards') loop
      if not coalesce(card->>'key' = any(array['equipment','install','fixture','electrical','site','training','trial','mgmt','labor','capacity',
        'yield','overtime','quality','structure','electricity','maintenance','spare','operator','other_invest','other_benefit','other_cost']),false)
        or jsonb_typeof(card->'values') is distinct from 'object' then raise exception '收支科目无效'; end if;
      for line in select value from jsonb_each(card->'values') loop
        if jsonb_typeof(line)<>'number' or line::text::numeric<0 then raise exception '科目数值无效'; end if;
      end loop;
      if card ? 'lines' then
        if jsonb_typeof(card->'lines') <> 'array' then raise exception '逐笔记录格式无效'; end if;
        for line in select value from jsonb_array_elements(card->'lines') loop
          if nullif(btrim(line->>'name'),'') is null or jsonb_typeof(line->'qty') is distinct from 'number'
             or jsonb_typeof(line->'price') is distinct from 'number' or (line->>'qty')::numeric<=0
             or (line->>'price')::numeric<0 then raise exception '请填写明细名称、数量与单价'; end if;
        end loop;
      end if;
    end loop;
    p.ledger := jsonb_set(p.ledger,array[period_key],p_input->'cards');
  elsif p_action='progress' then
    if note='' or nullif(p_input->>'date','') is null then raise exception '请填写记录日期和进展内容'; end if;
    entry := jsonb_build_object('id',coalesce((p_input->>'id')::uuid,gen_random_uuid()),'date',(p_input->>'date')::date,'note',note);
    if p_input->>'id' is null then
      p.progress := p.progress || jsonb_build_array(entry);
    else
      select ord::int-1 into entry_index from jsonb_array_elements(p.progress) with ordinality as entries(item,ord)
        where item->>'id'=entry->>'id';
      if not found then raise exception '找不到这条进展记录'; end if;
      p.progress := jsonb_set(p.progress,array[entry_index::text],entry);
    end if;
  elsif p_action='annual' then
    record_year := (p_input->>'year')::integer;
    if record_year is null or record_year not between 2000 and 2199 then raise exception '年度无效'; end if;
    if p.ledger ? record_year::text or p.books ? record_year::text or
       (p_input ? 'note' and not (p_input ?| array['investment','benefit','cost'])) then
      -- For itemized years the book supplies amounts; the annual form edits only its note.
      entry := coalesce(p.annual->record_year::text,'{}'::jsonb) || jsonb_build_object('note',note);
    else
      entry := jsonb_strip_nulls(jsonb_build_object('investment',p_input->'investment','benefit',p_input->'benefit','cost',p_input->'cost','note',nullif(note,'')));
    end if;
    if entry='{}'::jsonb then raise exception '请至少填写一项实际金额或备注'; end if;
    foreach amount_key in array array['investment','benefit','cost'] loop
      if entry ? amount_key and (jsonb_typeof(entry->amount_key)<>'number' or (entry->>amount_key)::numeric not between 0 and 999999999)
        then raise exception '实际金额无效'; end if;
    end loop;
    p.annual := jsonb_set(p.annual,array[record_year::text],entry);
  else raise exception '未知记录操作';
  end if;

  update public.pm_projects set plan=p.plan,status=p.status,status_history=p.status_history,progress=p.progress,annual=p.annual,ledger=p.ledger,
    revision=revision+1,updated_at=now() where id=p.id returning * into p;
  return to_jsonb(p);
end $$;

revoke all on function public.pm_list(text), public.pm_apply(text,uuid,integer,text,jsonb) from public;
grant execute on function public.pm_list(text), public.pm_apply(text,uuid,integer,text,jsonb) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
