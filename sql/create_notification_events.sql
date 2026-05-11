-- DebtYa V97: eventos de recordatorios enviados (deduplicacion / auditoria ligera).
-- Ejecutar en Supabase SQL Editor despues de notification_preferences. Idempotente.
--
-- Solo el backend (service_role) inserta filas; RLS sin politicas para authenticated
-- implica que el cliente anon/auth no lee esta tabla por defecto.

CREATE TABLE IF NOT EXISTS public.notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  intent_id uuid,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  event_type text NOT NULL DEFAULT 'auto_reminder'
    CHECK (event_type IN ('auto_reminder', 'test', 'skipped_no_provider', 'skipped_cadence', 'skipped_window')),
  message text NOT NULL DEFAULT 'DebtYa reminder sent',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_events_user_intent_channel_time
  ON public.notification_events (user_id, intent_id, channel, created_at DESC);

COMMENT ON TABLE public.notification_events IS
  'Reminder sends and skips for manual-first notifications; used for smart cadence.';

ALTER TABLE public.notification_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.notification_events FROM anon;
REVOKE ALL ON public.notification_events FROM authenticated;
GRANT ALL ON public.notification_events TO service_role;
