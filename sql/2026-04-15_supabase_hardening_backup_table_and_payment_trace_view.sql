-- Hardening conservador para warnings de Supabase Advisor:
-- 1) RLS Disabled in Public: public.payment_intent_allocations_duplicates_backup
-- 2) Security Definer View: public.v_payment_trace
--
-- Enfoque:
-- - No asumir existencia de objetos (checks con IF EXISTS dentro de DO $$ ... $$).
-- - Minimizar riesgo operativo (solo seguridad/permisos de objetos puntuales).
-- - Mantener script listo para ejecutar en SQL Editor.

begin;

-- =========================================
-- PRE-CHECKS (solo lectura)
-- =========================================

-- Estado de RLS en la tabla backup
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

-- Grants actuales de la tabla backup
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'payment_intent_allocations_duplicates_backup'
order by grantee, privilege_type;

-- Definicion actual de la vista (si existe)
select pg_get_viewdef('public.v_payment_trace'::regclass, true) as view_sql
where exists (
  select 1
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'v_payment_trace'
    and c.relkind = 'v'
);

-- Owner y reloptions de la vista
select
  c.relname as view_name,
  pg_get_userbyid(c.relowner) as owner,
  c.reloptions
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'v_payment_trace'
  and c.relkind = 'v';

-- Grants actuales de la vista
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'v_payment_trace'
order by grantee, privilege_type;

-- =========================================
-- FIX #1: RLS en tabla backup
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
    execute 'alter table public.payment_intent_allocations_duplicates_backup enable row level security';
    execute 'alter table public.payment_intent_allocations_duplicates_backup force row level security';
    execute 'revoke all on table public.payment_intent_allocations_duplicates_backup from anon, authenticated';
    execute 'revoke all on table public.payment_intent_allocations_duplicates_backup from public';
  end if;
end $$;

-- =========================================
-- FIX #2: Security definer view hardening
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
    execute 'alter view public.v_payment_trace set (security_invoker = true)';
    execute 'revoke all on public.v_payment_trace from anon, authenticated';
    execute 'revoke all on public.v_payment_trace from public';
  end if;
end $$;

-- =========================================
-- POST-CHECKS (solo lectura)
-- =========================================

-- Estado final de RLS en la tabla backup
select
  n.nspname as schema_name,
  c.relname as object_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'payment_intent_allocations_duplicates_backup';

-- Grants finales de la tabla backup
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'payment_intent_allocations_duplicates_backup'
order by grantee, privilege_type;

-- reloptions final de la vista
select
  c.relname as view_name,
  c.reloptions
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'v_payment_trace'
  and c.relkind = 'v';

-- Grants finales de la vista
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'v_payment_trace'
order by grantee, privilege_type;

commit;
