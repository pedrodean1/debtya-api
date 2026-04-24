-- DebtYa: columnas y CHECK para deudas importadas desde Spinwheel (idempotente).
-- Ejecutar en Supabase SQL Editor después de sql/create_spinwheel_users.sql.

ALTER TABLE public.debts DROP CONSTRAINT IF EXISTS debts_source_check;
ALTER TABLE public.debts
  ADD CONSTRAINT debts_source_check
  CHECK (source IN ('manual', 'plaid', 'method', 'spinwheel'));

COMMENT ON COLUMN public.debts.source IS
  'Origen: manual | plaid | method | spinwheel.';

ALTER TABLE public.debts ADD COLUMN IF NOT EXISTS spinwheel_external_id text NULL;
ALTER TABLE public.debts ADD COLUMN IF NOT EXISTS spinwheel_external_type text NULL;
ALTER TABLE public.debts ADD COLUMN IF NOT EXISTS creditor_name text NULL;
ALTER TABLE public.debts ADD COLUMN IF NOT EXISTS raw_spinwheel jsonb NULL;

COMMENT ON COLUMN public.debts.spinwheel_external_id IS
  'ID estable del liability en Spinwheel (creditCardId, autoLoanId, etc.).';
COMMENT ON COLUMN public.debts.spinwheel_external_type IS
  'Colección + subtipo o liabilitySubtype para trazabilidad.';
COMMENT ON COLUMN public.debts.creditor_name IS
  'Acreedor u origen legible desde Spinwheel (creditor.originalName o displayName).';
COMMENT ON COLUMN public.debts.raw_spinwheel IS
  'Snapshot JSON del liability Spinwheel al importar/actualizar.';

CREATE INDEX IF NOT EXISTS idx_debts_spinwheel_user_ext
  ON public.debts (user_id, spinwheel_external_id)
  WHERE source = 'spinwheel' AND spinwheel_external_id IS NOT NULL;
