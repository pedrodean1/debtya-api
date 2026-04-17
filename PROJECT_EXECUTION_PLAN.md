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
   - Tests unitarios de `lib/validation.js`: `npm test`.
   - CI en GitHub Actions (`.github/workflows/ci.yml`): `npm ci` + `npm test` en push/PR a `main`; paso opcional `validate:env` si hay secrets (ver checklist GitHub abajo).
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
   - Unificar formato de errores para frontend (contrato en `lib/json-error.js`; incluye `http_status` y `request_id`).
   - Documentar endpoints y ejemplos de respuesta.
2. Features
   - Entregar mejoras priorizadas por impacto de negocio.

## Regla de ejecucion

- Cambios pequenos, auditables y reversibles.
- Siempre con plan de validacion y rollback.
- Sin tocar flujos criticos sin evidencia de necesidad.

## GitHub Actions (secrets del repo)

Configurar en **Settings → Secrets and variables → Actions** (mismos nombres que en el host). El paso opcional `validate:env` en CI solo corre si **los seis** estan definidos; si falta cualquiera (o en forks sin secrets), se omite y el workflow sigue verde.

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `CRON_SECRET`

Tras el primer push con secrets: comprobar en la pestaña **Actions** que el job `test` incluye el paso *Validate production env shape* en verde.

## Branch protection (main)

En GitHub: **Settings → Branches → Branch protection rule** para `main`:

- Require a pull request before merging (opcional si trabajas solo, recomendable con colaboradores).
- Require status checks to pass: marcar el workflow **CI / test** (nombre exacto segun Actions).
- Do not allow bypassing the above settings (solo owners si aplica).

## Contrato JSON de errores (`lib/json-error.js`)

Respuestas de error HTTP tipicas incluyen:

- `ok`: `false`
- `error`: mensaje legible
- `http_status`: mismo codigo HTTP de la respuesta
- `request_id`: correlacion con cabecera `X-Request-Id` (middleware `lib/request-id.js`, aplicado tambien al webhook de Stripe)
- Campos adicionales opcionales (`details`, etc.) segun el endpoint

## Chequeos locales de seguridad

- `npm run security:preflight` (PowerShell): confirma que `.env` y `node_modules` no estan trackeados y avisa si `.env` aparece en historial.

## Historial git y secretos

- El archivo `.env` llego a aparecer en el historial (p. ej. commit `fe8fe09`). Aunque hoy este en `.gitignore`, **quien clone el repo puede ver ese commit**. Recomendacion: rotar claves que pudieran figurar alli (Supabase service/anon, Stripe, Plaid, cron) y, si el riesgo lo exige, usar `git filter-repo` o soporte de GitHub para purgar datos sensibles del historial remoto.
- **`node_modules` no debe versionarse.** Si estaba en el indice, quitarlo con `git rm -r --cached node_modules` y un commit dedicado; luego `npm ci` en cada clone/CI.

## Checklist de deploy (API)

0. `npm run security:preflight` (PowerShell).
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
- Las respuestas JSON de error incluyen `request_id` y `http_status` cuando aplica, para correlacionar con logs del servidor.
