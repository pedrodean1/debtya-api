-- V100: metadata jsonb para forceTest y auditoría (ej. { "force_test": true }).

ALTER TABLE public.notification_events
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.notification_events.metadata IS
  'Metadatos opcionales; force_test marca envíos del cron POST ?forceTest=1.';
