-- V100.1: columna message NOT NULL para auditoría (alineado con producción).
-- Idempotente. Si la columna ya existe, ADD COLUMN IF NOT EXISTS no hace nada.

ALTER TABLE public.notification_events
  ADD COLUMN IF NOT EXISTS message text NOT NULL DEFAULT 'DebtYa reminder sent';

COMMENT ON COLUMN public.notification_events.message IS
  'Resumen legible del recordatorio enviado; el backend siempre envía texto no vacío.';
