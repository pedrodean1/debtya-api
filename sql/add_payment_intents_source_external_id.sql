-- DebtYa: marcar intents originados desde deudas Spinwheel (planificación).
-- Ejecutar en Supabase SQL Editor después de desplegar la API que inserta estos campos.

ALTER TABLE public.payment_intents ADD COLUMN IF NOT EXISTS source text NULL;
ALTER TABLE public.payment_intents ADD COLUMN IF NOT EXISTS external_id text NULL;

COMMENT ON COLUMN public.payment_intents.source IS
  'Origen del intent (p. ej. spinwheel); null = pipeline histórico vía allocations.';
COMMENT ON COLUMN public.payment_intents.external_id IS
  'Id externo correlativo (p. ej. debts.spinwheel_external_id cuando source = spinwheel).';

CREATE INDEX IF NOT EXISTS idx_payment_intents_user_source_ext
  ON public.payment_intents (user_id, source, external_id)
  WHERE source IS NOT NULL AND external_id IS NOT NULL;
