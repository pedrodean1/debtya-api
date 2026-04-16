-- Rollback conservador del hardening aplicado en:
-- sql/2026-04-15_supabase_hardening_backup_table_and_payment_trace_view.sql
--
-- Objetivo:
-- - Recuperar acceso de anon/authenticated en caso de emergencia operativa.
-- - Revertir security_invoker en la vista.
-- - Mantener IF EXISTS para no fallar si faltan objetos.
--
-- Importante:
-- - Este rollback prioriza continuidad del servicio.
-- - Si tu politica de seguridad exige cierre estricto, usar solo bajo incidente.

begin;

-- =========================================
-- PRE-CHECKS (solo lectura)
-- =========================================
select
  n.nspname as schema_name,
  c.relname as object_name,
  c.relkind as kind,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'payment_intent_allocations_duplicates_backup';

select
  c.relname as view_name,
  c.reloptions
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'v_payment_trace'
  and c.relkind = 'v';

-- =========================================
-- ROLLBACK #1: tabla backup
-- =========================================
do $$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'payment_intent_allocations_duplicates_backup'
      and c.relkind = 'r'
  ) then
    execute 'alter table public.payment_intent_allocations_duplicates_backup no force row level security';
    execute 'alter table public.payment_intent_allocations_duplicates_backup disable row level security';

    -- Reponer permisos cliente para continuidad operativa.
    execute 'grant select, insert, update, delete on table public.payment_intent_allocations_duplicates_backup to anon, authenticated';
  end if;
end $$;

-- =========================================
-- ROLLBACK #2: vista payment trace
-- =========================================
do $$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'v_payment_trace'
      and c.relkind = 'v'
  ) then
    execute 'alter view public.v_payment_trace reset (security_invoker)';

    -- Reponer lectura cliente para continuidad operativa.
    execute 'grant select on public.v_payment_trace to anon, authenticated';
  end if;
end $$;

-- =========================================
-- POST-CHECKS (solo lectura)
-- =========================================
select
  n.nspname as schema_name,
  c.relname as object_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'payment_intent_allocations_duplicates_backup';

select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'payment_intent_allocations_duplicates_backup'
order by grantee, privilege_type;

select
  c.relname as view_name,
  c.reloptions
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'v_payment_trace'
  and c.relkind = 'v';

select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'v_payment_trace'
order by grantee, privilege_type;

commit;
