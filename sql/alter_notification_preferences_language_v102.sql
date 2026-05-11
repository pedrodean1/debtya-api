-- V102: idioma de recordatorios (email/SMS) alineado a la UI.
-- Idempotente: ejecutar en Supabase SQL Editor.

ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS preferred_language text DEFAULT 'en';

UPDATE public.notification_preferences
SET preferred_language = 'en'
WHERE preferred_language IS NULL
   OR trim(lower(preferred_language)) NOT IN ('en', 'es');

ALTER TABLE public.notification_preferences
  ALTER COLUMN preferred_language SET DEFAULT 'en';

ALTER TABLE public.notification_preferences
  DROP CONSTRAINT IF EXISTS notification_preferences_preferred_language_check;

ALTER TABLE public.notification_preferences
  ADD CONSTRAINT notification_preferences_preferred_language_check
  CHECK (preferred_language IN ('en', 'es'));

ALTER TABLE public.notification_preferences
  ALTER COLUMN preferred_language SET NOT NULL;

COMMENT ON COLUMN public.notification_preferences.preferred_language IS
  'Reminder copy language: en | es (matches in-app UI language).';
