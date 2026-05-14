-- DebtYa V113 — Supabase Security Advisor hardening (RLS + least privilege).
--
-- Objetivo:
-- - Reducir "RLS disabled in public" y "sensitive columns exposed" endureciendo acceso
--   directo vía PostgREST (roles anon / authenticated) sin depender de políticas amplias.
-- - Mantener el backend Node (service_role): en Supabase, service_role BYPASSRLS.
--
-- Ejecutar en Supabase → SQL Editor (una sola vez o re-ejecutar; idempotente).
-- Revisar comentarios al final sobre tablas que dejan de exponerse a authenticated.

begin;

-- ---------------------------------------------------------------------------
-- Helpers (funciones temporales, se eliminan al final del script)
-- ---------------------------------------------------------------------------

create or replace function debtya_v113_tmp_drop_all_policies(p_schema text, p_table text)
returns void
language plpgsql
as $$
declare
  r record;
begin
  for r in
    select policyname
    from pg_policies
    where schemaname = p_schema
      and tablename = p_table
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, p_schema, p_table);
  end loop;
end;
$$;

create or replace function debtya_v113_tmp_lockdown_server_only(p_schema text, p_table text)
returns void
language plpgsql
as $$
begin
  if to_regclass(format('%I.%I', p_schema, p_table)) is null then
    return;
  end if;

  execute format('alter table %I.%I enable row level security', p_schema, p_table);
  perform debtya_v113_tmp_drop_all_policies(p_schema, p_table);

  execute format('revoke all on table %I.%I from PUBLIC', p_schema, p_table);
  execute format('revoke all on table %I.%I from anon', p_schema, p_table);
  execute format('revoke all on table %I.%I from authenticated', p_schema, p_table);

  execute format('grant all on table %I.%I to service_role', p_schema, p_table);
end;
$$;

create or replace function debtya_v113_tmp_owner_all_policies(
  p_schema text,
  p_table text,
  p_owner_column text,
  p_policy_basename text
)
returns void
language plpgsql
as $$
declare
  has_col boolean;
begin
  if to_regclass(format('%I.%I', p_schema, p_table)) is null then
    return;
  end if;

  select exists (
    select 1
    from information_schema.columns c
    where c.table_schema = p_schema
      and c.table_name = p_table
      and c.column_name = p_owner_column
  )
  into has_col;

  if not has_col then
    raise notice 'debtya_v113: skip owner policies for %.% (missing column %)', p_schema, p_table, p_owner_column;
    return;
  end if;

  execute format('alter table %I.%I enable row level security', p_schema, p_table);
  perform debtya_v113_tmp_drop_all_policies(p_schema, p_table);

  execute format('revoke all on table %I.%I from PUBLIC', p_schema, p_table);
  execute format('revoke all on table %I.%I from anon', p_schema, p_table);
  execute format('revoke all on table %I.%I from authenticated', p_schema, p_table);

  execute format(
    'grant select, insert, update, delete on table %I.%I to authenticated',
    p_schema,
    p_table
  );

  execute format(
    'create policy %I on %I.%I for all to authenticated using (%I = (select auth.uid())) with check (%I = (select auth.uid()))',
    p_policy_basename || '_authenticated_all',
    p_schema,
    p_table,
    p_owner_column,
    p_owner_column
  );

  execute format('grant all on table %I.%I to service_role', p_schema, p_table);
end;
$$;

-- ---------------------------------------------------------------------------
-- A) Tablas server-only sensibles (RLS ON, sin políticas para anon/auth)
-- ---------------------------------------------------------------------------

select debtya_v113_tmp_lockdown_server_only('public', 'plaid_items');
select debtya_v113_tmp_lockdown_server_only('public', 'transactions_raw');
select debtya_v113_tmp_lockdown_server_only('public', 'spinwheel_users');
select debtya_v113_tmp_lockdown_server_only('public', 'method_entities');
select debtya_v113_tmp_lockdown_server_only('public', 'method_accounts');
select debtya_v113_tmp_lockdown_server_only('public', 'method_connect_sessions');
select debtya_v113_tmp_lockdown_server_only('public', 'method_payments');
select debtya_v113_tmp_lockdown_server_only('public', 'billing_subscriptions');
select debtya_v113_tmp_lockdown_server_only('public', 'notification_events');
select debtya_v113_tmp_lockdown_server_only('public', 'debug_pings');
select debtya_v113_tmp_lockdown_server_only('public', 'password_reset_shortlinks');
select debtya_v113_tmp_lockdown_server_only('public', 'password_reset_finish');
select debtya_v113_tmp_lockdown_server_only('public', 'signup_verification_codes');
select debtya_v113_tmp_lockdown_server_only('public', 'payment_intent_allocations_duplicates_backup');

-- Tabla principal de allocations (si existe en el proyecto)
select debtya_v113_tmp_lockdown_server_only('public', 'payment_intent_allocations');

-- Preferencias y eventos: la API DebtYa usa service_role; quitar acceso directo authenticated
-- evita exponer phone_number / metadata vía PostgREST con el JWT de sesión.
select debtya_v113_tmp_lockdown_server_only('public', 'notification_preferences');

-- ---------------------------------------------------------------------------
-- B) Tablas de datos de usuario: RLS + owner (authenticated) + service_role
-- ---------------------------------------------------------------------------

select debtya_v113_tmp_owner_all_policies('public', 'profiles', 'id', 'debtya_v113_profiles');
select debtya_v113_tmp_owner_all_policies('public', 'debts', 'user_id', 'debtya_v113_debts');
select debtya_v113_tmp_owner_all_policies('public', 'payment_plans', 'user_id', 'debtya_v113_payment_plans');
select debtya_v113_tmp_owner_all_policies('public', 'payment_intents', 'user_id', 'debtya_v113_payment_intents');
select debtya_v113_tmp_owner_all_policies('public', 'payment_executions', 'user_id', 'debtya_v113_payment_executions');
select debtya_v113_tmp_owner_all_policies('public', 'accounts', 'user_id', 'debtya_v113_accounts');
select debtya_v113_tmp_owner_all_policies('public', 'micro_rules', 'user_id', 'debtya_v113_micro_rules');

-- ---------------------------------------------------------------------------
-- C) Vista conocida: invoker + sin grants a anon/authenticated
-- ---------------------------------------------------------------------------

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
    execute 'revoke all on table public.v_payment_trace from PUBLIC';
    execute 'revoke all on table public.v_payment_trace from anon';
    execute 'revoke all on table public.v_payment_trace from authenticated';
    execute 'grant select on table public.v_payment_trace to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Limpieza de helpers temporales
-- ---------------------------------------------------------------------------

drop function if exists debtya_v113_tmp_owner_all_policies(text, text, text, text);
drop function if exists debtya_v113_tmp_lockdown_server_only(text, text);
drop function if exists debtya_v113_tmp_drop_all_policies(text, text);

commit;
