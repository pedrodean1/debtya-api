# DebtYa — Supabase: seguridad, RLS y Data API (grants)

Guía interna para migraciones SQL y cambios de esquema. El backend DebtYa usa principalmente el **cliente admin (`service_role`)**, que **omite RLS**; el endurecimiento protege acceso directo vía **PostgREST / supabase-js / GraphQL** con JWT (`anon` / `authenticated`).

## Cambio de plataforma: exposición al Data API

Supabase comunicó que, a partir de:

- **30 may 2026** — proyectos **nuevos**: las tablas nuevas en `public` **no** quedarán expuestas al Data API de forma automática.
- **30 oct 2026** — proyectos **existentes**: misma regla para tablas nuevas.

Implicación: para que `anon` / `authenticated` puedan usar PostgREST (o clientes que dependan de grants al rol), hará falta **`GRANT` explícito** sobre cada tabla (y, si aplica, sobre vistas/materialized views expuestas). El rol **`service_role`** sigue siendo el adecuado para el servidor Node; conviene **`GRANT ... TO service_role`** de forma explícita cuando se endurece con `REVOKE`.

Referencia de endurecimiento ya aplicado en el repo: `sql/security_rls_hardening_v113.sql` (commit `652936d`). Diagnóstico: `sql/security_advisor_diagnostics_v113.sql`.

---

## Reglas obligatorias para toda tabla nueva en `public`

1. **`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`** — RLS siempre activo desde la creación (o en la misma migración que crea la tabla).
2. **Clasificar** la tabla en uno de los tres modelos siguientes **antes** de mergear la migración.
3. **No** desactivar RLS en tablas productivas.
4. **No** crear políticas del tipo `USING (true)` / `WITH CHECK (true)` para `anon` salvo necesidad documentada y revisión explícita de seguridad.

---

## A) Server-only (recomendado para la mayoría de datos sensibles)

Uso: tokens Plaid/Spinwheel, payloads crudos, billing, eventos de notificación, shortlinks de reset, tablas solo consumidas por la API Node con `service_role`.

Patrón:

- RLS ON.
- Quitar acceso directo de clientes: `REVOKE` desde `PUBLIC`, `anon` y `authenticated`.
- **Sin** políticas que abran filas a `anon` / `authenticated`.
- `GRANT ALL` (o mínimo necesario) a **`service_role`**.

Ejemplo idempotente (sustituir `mi_tabla`):

```sql
alter table public.mi_tabla enable row level security;

-- Eliminar políticas legacy si existieran (ajustar nombres o usar pg_policies en un script).
-- drop policy if exists nombre_legacy on public.mi_tabla;

revoke all on table public.mi_tabla from public;
revoke all on table public.mi_tabla from anon;
revoke all on table public.mi_tabla from authenticated;

grant all on table public.mi_tabla to service_role;
```

---

## B) User-owned vía Data API (lectura/escritura solo del dueño)

Uso: solo si el producto **necesita** acceso PostgREST con el JWT del usuario (poco habitual en DebtYa si todo pasa por la API).

Patrón:

- RLS ON.
- `GRANT SELECT, INSERT, UPDATE, DELETE` a **`authenticated`** (no a `anon` salvo que haya requisito explícito).
- Políticas **owner-only**: `user_id = (select auth.uid())` **o**, en `profiles`, `id = (select auth.uid())`.
- `GRANT` a **`service_role`** para el backend.

Ejemplo (`user_id` como columna de propiedad):

```sql
alter table public.mi_tabla enable row level security;

revoke all on table public.mi_tabla from public;
revoke all on table public.mi_tabla from anon;
revoke all on table public.mi_tabla from authenticated;

grant select, insert, update, delete on table public.mi_tabla to authenticated;
grant all on table public.mi_tabla to service_role;

drop policy if exists mi_tabla_owner_all on public.mi_tabla;

create policy mi_tabla_owner_all
  on public.mi_tabla
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
```

Ejemplo (`profiles`: dueño = `id`):

```sql
alter table public.profiles enable row level security;

revoke all on table public.profiles from public;
revoke all on table public.profiles from anon;
revoke all on table public.profiles from authenticated;

grant select, insert, update, delete on table public.profiles to authenticated;
grant all on table public.profiles to service_role;

drop policy if exists profiles_owner_all on public.profiles;

create policy profiles_owner_all
  on public.profiles
  for all
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
```

---

## C) Lectura pública (solo si alguna vez aplica)

Uso: datos **no sensibles** que deban listarse sin sesión (muy raro en DebtYa).

Patrón:

- RLS ON.
- `GRANT SELECT` a `anon` y/o `authenticated` según necesidad.
- Políticas de **solo lectura** explícitas y acotadas (por ejemplo filas marcadas como públicas). **Nunca** exponer columnas sensibles.

Ejemplo esquemático (ajustar condición real):

```sql
alter table public.mi_catalogo_publico enable row level security;

revoke all on table public.mi_catalogo_publico from public;
revoke insert, update, delete on table public.mi_catalogo_publico from anon;

grant select on table public.mi_catalogo_publico to anon;

drop policy if exists mi_catalogo_publico_select on public.mi_catalogo_publico;

create policy mi_catalogo_publico_select
  on public.mi_catalogo_publico
  for select
  to anon
  using (is_public = true);
```

---

## Advertencia: nunca `GRANT` amplio a `anon` en datos sensibles

No conceder a **`anon`** (ni políticas “abiertas”) acceso a tablas o columnas que contengan o suelen contener:

- `email`, `phone_number`, `access_token`, `refresh_token`, `public_token`, `item_id`
- `raw_response`, `raw_spinwheel`, `metadata` con datos financieros o PII
- tablas de negocio: `debts`, `payment_intents`, `payment_plans`, `payment_executions`, `notification_preferences`, `notification_events`, `plaid_items`, `spinwheel_users`, `billing_subscriptions`, etc.

Para esas áreas, preferir **siempre el modelo A (server-only)** y exponer solo lo necesario vía **rutas HTTP** del backend.

---

## Checklist antes de cada PR que toque SQL

- [ ] **Security Advisor** en Supabase (0 errores; revisar también advertencias relevantes).
- [ ] **Grants**: confirmar `REVOKE`/`GRANT` alineados con la clasificación A/B/C y con las fechas de Data API (grants explícitos si el cliente debe usar PostgREST).
- [ ] **RLS**: habilitado; políticas acotadas; sin `true` para roles públicos en datos sensibles.
- [ ] **Vistas** expuestas: `security_invoker` donde aplique; sin filas/columnas sensibles visibles a roles incorrectos.
- [ ] Repo: `node --check server.js`, `node --check public/app.js`, `npm test` (y reglas de deploy del proyecto si aplica).

---

## Resumen rápido

| Modelo        | RLS | anon / authenticated | service_role |
|---------------|-----|------------------------|----------------|
| A server-only | ON  | sin acceso (revoke)    | grant explícito |
| B user-owned  | ON  | grant + policy dueño   | grant explícito |
| C público RO  | ON  | select acotado         | según backend  |

Cualquier duda entre B y A: elegir **A** y servir datos desde la API Node.
