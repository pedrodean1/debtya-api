# Runbook: Hardening Supabase (DebtYa)

Este runbook cubre la ejecucion segura de:

- `sql/2026-04-15_supabase_hardening_backup_table_and_payment_trace_view.sql`
- `sql/2026-04-15_supabase_hardening_backup_table_and_payment_trace_view_rollback.sql`

Objetivo: corregir warnings de Supabase Advisor con minimo riesgo operativo.

## Alcance

- Tabla backup: `public.payment_intent_allocations_duplicates_backup`
- Vista: `public.v_payment_trace`

No toca frontend, Stripe, Plaid, auth ni flujo principal.

## Precondiciones

1. Tener acceso a Supabase SQL Editor del entorno correcto.
2. Confirmar ventana de bajo trafico.
3. Tener a mano endpoint backend a validar: `GET /payment-trace`.
4. Tener este plan de rollback disponible antes de ejecutar.

## Orden de ejecucion recomendado

1. Ejecutar hardening en **staging**:
   - `sql/2026-04-15_supabase_hardening_backup_table_and_payment_trace_view.sql`
2. Validar funcionalmente:
   - `GET /payment-trace` con usuario real.
   - Revisar que no haya 500 ni cambios inesperados de payload.
3. Revisar Supabase Advisor en staging.
4. Si todo esta OK, repetir en **produccion**.

## Criterios de exito

- Warning `RLS Disabled in Public` resuelto para:
  - `public.payment_intent_allocations_duplicates_backup`
- Warning `Security Definer View` resuelto para:
  - `public.v_payment_trace`
- Endpoint `GET /payment-trace` responde OK sin regresion funcional.

## Protocolo de rollback (si hay incidente)

Ejecutar:

- `sql/2026-04-15_supabase_hardening_backup_table_and_payment_trace_view_rollback.sql`

Luego validar de inmediato:

1. `GET /payment-trace`
2. Errores de backend
3. Estado de permisos/reloptions en post-checks del propio script

## Evidencia minima (operacion profesional)

Guardar en ticket interno:

1. Fecha/hora de ejecucion.
2. Entorno afectado (staging/prod).
3. Resultado de validacion de `GET /payment-trace`.
4. Estado de warnings en Supabase Advisor.
5. Si hubo rollback, motivo y hora.

