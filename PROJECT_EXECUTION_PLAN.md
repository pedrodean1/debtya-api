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
   - Modularizar `server.js` por dominios (`billing`, `plaid`, `rules`, `cron`).
   - Introducir validacion de input centralizada.

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
