-- DebtYa: integración Method (híbrido Plaid + Method) — ejecutar en Supabase SQL Editor.
-- Idempotente: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS. No borra datos existentes.

-- ---------------------------------------------------------------------------
-- Tablas Method (lado servidor; la API usa service role)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.method_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  method_entity_id text NOT NULL,
  environment text NOT NULL DEFAULT 'production',
  status text NULL,
  connect_last_status text NULL,
  connect_last_id text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT method_entities_method_entity_id_key UNIQUE (method_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_method_entities_user_id
  ON public.method_entities (user_id);

COMMENT ON TABLE public.method_entities IS
  'Entidad Method (holder) vinculada al usuario DebtYa; se crea vía API Method.';

CREATE TABLE IF NOT EXISTS public.method_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  method_entity_id text NOT NULL,
  method_account_id text NOT NULL,
  holder_id text NULL,
  status text NULL,
  account_type text NULL,
  liability jsonb NULL,
  products jsonb NULL,
  payment_capable boolean NOT NULL DEFAULT false,
  raw_snapshot jsonb NULL,
  imported_debt_id uuid NULL,
  last_synced_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT method_accounts_method_account_id_key UNIQUE (method_account_id)
);

CREATE INDEX IF NOT EXISTS idx_method_accounts_user_id
  ON public.method_accounts (user_id);

CREATE INDEX IF NOT EXISTS idx_method_accounts_entity
  ON public.method_accounts (method_entity_id);

COMMENT ON TABLE public.method_accounts IS
  'Cuentas liability sincronizadas desde Method; payment_capable refleja producto payment en Method.';

CREATE TABLE IF NOT EXISTS public.method_connect_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  method_entity_id text NOT NULL,
  method_connect_id text NOT NULL,
  status text NULL,
  account_ids jsonb NULL,
  error jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_method_connect_sessions_user
  ON public.method_connect_sessions (user_id);

COMMENT ON TABLE public.method_connect_sessions IS
  'Registro de solicitudes Connect Method (auditoría).';

CREATE TABLE IF NOT EXISTS public.method_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  debt_id uuid NULL,
  method_payment_id text NULL,
  status text NOT NULL DEFAULT 'draft',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_method_payments_user
  ON public.method_payments (user_id);

COMMENT ON TABLE public.method_payments IS
  'Placeholder fase 2: ejecución de pagos al acreedor vía Method (no usado aún en runtime).';

-- ---------------------------------------------------------------------------
-- debts: origen híbrido (Plaid fuente / manual / Method liabilities)
-- ---------------------------------------------------------------------------

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

COMMENT ON COLUMN public.debts.source IS
  'Origen de la deuda en DebtYa: manual | plaid | method.';

COMMENT ON COLUMN public.debts.method_account_id IS
  'ID de cuenta liability en Method (acc_*) cuando source = method.';

COMMENT ON COLUMN public.debts.method_entity_id IS
  'ID de entidad Method (ent_*) asociada a esta deuda cuando aplica.';

COMMENT ON COLUMN public.debts.payment_capable IS
  'Si Method expone capacidad de pago (product payment) para esta liability.';

CREATE INDEX IF NOT EXISTS idx_debts_user_source
  ON public.debts (user_id, source);

CREATE INDEX IF NOT EXISTS idx_debts_method_account_id
  ON public.debts (method_account_id)
  WHERE method_account_id IS NOT NULL;
