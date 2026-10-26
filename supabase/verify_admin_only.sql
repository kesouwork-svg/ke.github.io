-- 只读核对:在 delta_admin_only.sql 执行后运行,不读密码/会话、不修改数据。
-- 第一段应返回16行,每行 admin_only=true；第二段应为 true。
with expected(name) as (
  values ('admin_users'), ('admin_audit'), ('admin_reject'), ('admin_level'),
         ('admin_toggle'), ('admin_resetpwd'), ('admin_create_user'), ('admin_set_dept'),
         ('admin_update_user'), ('admin_delete_user'), ('admin_set_tools'),
         ('admin_backup'), ('admin_restore_clear'), ('admin_restore_device'),
         ('admin_restore_users'), ('admin_restore_meta')
)
select e.name as rpc,
       count(p.oid) as function_count,
       coalesce(bool_and(position('if u.account <> ''admin'' then' in pg_get_functiondef(p.oid)) > 0), false) as admin_only
from expected e
left join pg_namespace n on n.nspname = 'public'
left join pg_proc p on p.pronamespace = n.oid and p.proname = e.name and p.prokind = 'f'
group by e.name
order by e.name;

select exists (
  select 1 from public.users where account = 'admin' and status = 'active'
) as active_admin_exists;
