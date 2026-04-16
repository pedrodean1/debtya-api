# DebtYa Plan Integral (Backend + Producto)

Plan de ejecucion para avanzar en paralelo con foco en impacto y estabilidad.

## Prioridad 1 (esta semana)

1. Seguridad operativa y trazabilidad
   - Hardening SQL aplicado (completado).
   - Rollback y runbook (completado).
   - Blindaje repo (`.gitignore`, `.env.example`) (completado).
2. Estabilidad backend
   - Catalogar endpoints criticos y respuesta esperada.
   - Definir smoke tests minimos para `/health`, `/payment-trace`, `/payment-intents`.
3. Observabilidad
   - Estandarizar logs de error con contexto de endpoint y request id.

## Prioridad 2 (proxima semana)

1. Performance
   - Revisar endpoints con mayor latencia (payment trace, intents, cron).
   - Reducir payloads y lecturas innecesarias.
2. Calidad de codigo
   - Modularizar `server.js` por dominios (`billing`, `plaid`, `rules`, `cron`). (hecho)
   - Validacion de input centralizada en `lib/validation.js` (UUID, montos; deudas POST/PATCH, reglas POST/PATCH, intents POST y approve/execute).

## Prioridad 3 (iteracion siguiente)

1. UX/API contract
   - Unificar formato de errores para frontend.
   - Documentar endpoints y ejemplos de respuesta.
2. Features
   - Entregar mejoras priorizadas por impacto de negocio.

## Regla de ejecucion

- Cambios pequenos, auditables y reversibles.
- Siempre con plan de validacion y rollback.
- Sin tocar flujos criticos sin evidencia de necesidad.

## Checklist de deploy (API)

1. `npm run validate:env` (carga `.env` local; en deploy usa variables del host). Con `NODE_ENV=production` exige tambien `SUPABASE_SERVICE_ROLE_KEY`, Stripe y `CRON_SECRET`.
2. Aplicar SQL pendiente en Supabase (si hay migraciones o scripts en `sql/`).
3. Desplegar API y verificar `GET /health` (incluye `X-Request-Id` en respuestas JSON de error).
4. `npm run smoke:local` o smoke contra URL real con token:
   - ejemplo auth amplio: `.\scripts\smoke-test.ps1 -ApiBaseUrl "https://TU_API" -AuthToken "TOKEN" -IncludePaymentIntents -IncludeAccountsDebtsRules`
5. Probar flujo minimo en app (login, cuentas, deudas, intents si aplica).
6. Revisar Supabase Advisor tras cambios de esquema/RLS.

## Rotacion de secretos (manual en proveedores)

No se puede rotar desde el repo; orden recomendado:

1. Supabase: rotar `service_role` y `anon` si hubo exposicion; actualizar variables en el host de la API.
2. Stripe: rotar secret key y webhook secret si el webhook o logs los filtraron.
3. Plaid: rotar secret; revisar items conectados si el proveedor lo exige.
4. `CRON_SECRET`: rotar y actualizar el scheduler que llama `POST /cron/full-auto`.

Tras rotar: redeploy + smoke tests + verificar webhooks (Stripe dashboard reenvio de eventos si hace falta).

## Observabilidad

- Cada request lleva `X-Request-Id` (o el valor enviado en cabecera `X-Request-Id` del cliente).
- Las respuestas JSON de error incluyen `request_id` cuando aplica, para correlacionar con logs del servidor.
