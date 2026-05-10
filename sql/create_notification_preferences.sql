-- DebtYa V96: preferencias de recordatorios de pago.
--
-- APLICACION MANUAL (requerido): el backend usa service_role y no aplica migraciones
-- automaticas. Abre Supabase -> SQL -> New query, pega este archivo completo y ejecuta.
-- Idempotente: puedes re-ejecutarlo; politicas y trigger se recrean con DROP IF EXISTS.
--
-- RLS: filas propias del usuario autenticado (auth.uid()). El servidor Node con
-- service_role ignora RLS para upsert/lectura administrada por la API.

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  email_enabled boolean NOT NULL DEFAULT false,
  sms_enabled boolean NOT NULL DEFAULT false,
  phone_number text,
  preferred_channel text NOT NULL DEFAULT 'none',
  reminder_time time,
  timezone text,
  consent_sms_at timestamptz,
  consent_email_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_preferences_user_unique UNIQUE (user_id),
  CONSTRAINT notification_preferences_channel_check CHECK (preferred_channel IN ('email', 'sms', 'both', 'none')),
  CONSTRAINT notification_preferences_sms_phone_check CHECK ((sms_enabled = false) OR (phone_number IS NOT NULL AND length(trim(phone_number)) > 0)),
  CONSTRAINT notification_preferences_sms_consent_check CHECK ((sms_enabled = false) OR (consent_sms_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_notification_preferences_user_id
  ON public.notification_preferences (user_id);

COMMENT ON TABLE public.notification_preferences IS
  'Opt-in email/SMS reminder preferences for manual-first DebtYa payment reminders.';

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_preferences_select_own ON public.notification_preferences;
CREATE POLICY notification_preferences_select_own
  ON public.notification_preferences
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS notification_preferences_insert_own ON public.notification_preferences;
CREATE POLICY notification_preferences_insert_own
  ON public.notification_preferences
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS notification_preferences_update_own ON public.notification_preferences;
CREATE POLICY notification_preferences_update_own
  ON public.notification_preferences
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS notification_preferences_delete_own ON public.notification_preferences;
CREATE POLICY notification_preferences_delete_own
  ON public.notification_preferences
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.notification_preferences FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_preferences TO authenticated;
GRANT ALL ON public.notification_preferences TO service_role;

CREATE OR REPLACE FUNCTION public.notification_preferences_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notification_preferences_touch_updated_at ON public.notification_preferences;
CREATE TRIGGER notification_preferences_touch_updated_at
  BEFORE UPDATE ON public.notification_preferences
  FOR EACH ROW
  EXECUTE PROCEDURE public.notification_preferences_touch_updated_at();
