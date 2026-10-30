-- 每日维修推送“全部未完成”只读核验（2026-10-30）
-- 先执行 delta_daily_todo_all_open.sql，再在 SQL Editor 执行本文件。
-- 只读取新函数生成的草稿与任务配置；不调用发送/测试发送，不改工单。
-- 数量是执行此刻的未完成数，不要求与早上08:00相同。

select
  position('当前未完成' in pg_get_functiondef('public._equip_todo_msg(boolean)'::regprocedure)) > 0 as all_open_text_installed,
  position('unscheduled' in pg_get_functiondef('public._equip_todo_msg(boolean)'::regprocedure)) > 0 as unscheduled_count_installed,
  position('Asia/Shanghai' in pg_get_functiondef('public.equip_daily_push()'::regprocedure)) > 0 as shanghai_day_installed;

with draft as (
  select public._equip_todo_msg(false) as r
)
select
  (r->>'total')::int as total_unfinished,
  (r->>'overdue')::int as overdue,
  (r->>'due_today')::int as due_today,
  (r->>'unscheduled')::int as unscheduled,
  (r->>'upcoming')::int as future_due,
  (r->>'date_unknown')::int as expected_date_needs_check,
  (r->>'shown')::int as shown,
  (r->>'total')::int = (r->>'overdue')::int + (r->>'due_today')::int
    + (r->>'unscheduled')::int + (r->>'upcoming')::int + (r->>'date_unknown')::int as counts_match,
  r->>'msg' as message_draft_not_sent
from draft;

-- 原任务应仍为工作日UTC00:00（北京时间08:00），command为调用原equip_daily_push。
select jobid, jobname, schedule, command, active
from cron.job where jobname = 'equip-daily-todo';
