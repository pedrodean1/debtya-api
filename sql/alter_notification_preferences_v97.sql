-- DebtYa V97: frecuencia de recordatorios automaticos (smart / daily / weekly / off).
-- Ejecutar en Supabase SQL Editor. Idempotente (ADD COLUMN IF NOT EXISTS).

ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS reminder_frequency text NOT NULL DEFAULT 'smart';

DO $$
BEGIN
  ALTER TABLE public.notification_preferences
    ADD CONSTRAINT notification_preferences_reminder_frequency_check
    CHECK (reminder_frequency IN ('smart', 'daily', 'weekly', 'off'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.notification_preferences.reminder_frequency IS
  'Cadencia para envios automaticos: smart (36h min por intent/canal), daily (22h), weekly (7d), off (solo prueba manual).';
