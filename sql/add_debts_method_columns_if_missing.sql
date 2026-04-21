-- DebtYa: columnas Method en `debts` (idempotente). Ejecutar en Supabase si el reset o import Method fallan
-- por "column debts.method_entity_id does not exist" u otras columnas del híbrido Plaid+Method.

ALTER TABLE public.debts
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'debts_source_check'
  ) THEN
    ALTER TABLE public.debts
      ADD CONSTRAINT debts_source_check
      CHECK (source IN ('manual', 'plaid', 'method'));
  END IF;
END $$;

ALTER TABLE public.debts
  ADD COLUMN IF NOT EXISTS method_account_id text NULL;

ALTER TABLE public.debts
  ADD COLUMN IF NOT EXISTS method_entity_id text NULL;

ALTER TABLE public.debts
  ADD COLUMN IF NOT EXISTS payment_capable boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_debts_user_source
  ON public.debts (user_id, source);

CREATE INDEX IF NOT EXISTS idx_debts_method_account_id
  ON public.debts (method_account_id)
  WHERE method_account_id IS NOT NULL;
