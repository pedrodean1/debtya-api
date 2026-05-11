-- DebtYa V97.1: default moderado weekly, frecuencia twice_weekly opcional (interna).
-- Ejecutar en Supabase SQL Editor. Idempotente.

ALTER TABLE public.notification_preferences
  ALTER COLUMN reminder_frequency SET DEFAULT 'weekly';

DO $$
BEGIN
  ALTER TABLE public.notification_preferences
    DROP CONSTRAINT IF EXISTS notification_preferences_reminder_frequency_check;
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE public.notification_preferences
  ADD CONSTRAINT notification_preferences_reminder_frequency_check
  CHECK (reminder_frequency IN ('smart', 'daily', 'weekly', 'twice_weekly', 'off'));

COMMENT ON COLUMN public.notification_preferences.reminder_frequency IS
  'Cadencia: weekly (defecto moderado), twice_weekly (interno), smart/daily (legacy), off.';
