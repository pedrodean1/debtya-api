-- DebtYa V113 — Diagnóstico read-only para Supabase Security Advisor.
-- Ejecutar en SQL Editor; no modifica el esquema.
--
-- Secciones:
-- 1) Tablas public sin RLS
-- 2) Políticas RLS en public
-- 3) Privilegios de tablas/vistas para anon y authenticated
-- 4) Columnas con nombres sensibles (heurística)

-- ---------------------------------------------------------------------------
-- 1) Tablas en public con RLS desactivado
-- ---------------------------------------------------------------------------
select
  n.nspname as schema_name,
  c.relname as table_name,
  c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and not c.relrowsecurity
order by c.relname;

-- ---------------------------------------------------------------------------
-- 2) Políticas RLS existentes en public
-- ---------------------------------------------------------------------------
select
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- ---------------------------------------------------------------------------
-- 3) Grants efectivos (tablas y vistas) para anon / authenticated
-- ---------------------------------------------------------------------------
select
  table_schema,
  table_name,
  grantee,
  string_agg(distinct privilege_type, ', ' order by privilege_type) as privileges
from information_schema.table_privileges
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
group by table_schema, table_name, grantee
order by table_name, grantee;

-- ---------------------------------------------------------------------------
-- 4) Columnas sensibles por nombre (heurística)
-- ---------------------------------------------------------------------------
select
  table_schema,
  table_name,
  column_name,
  data_type
from information_schema.columns
where table_schema = 'public'
  and lower(column_name) in (
    'email',
    'phone',
    'phone_number',
    'access_token',
    'refresh_token',
    'public_token',
    'item_id',
    'raw_response',
    'raw_spinwheel',
    'metadata',
    'password',
    'secret'
  )
  or lower(column_name) like '%password%'
  or lower(column_name) like '%secret%'
  or lower(column_name) like '%token%'
order by table_name, column_name;
