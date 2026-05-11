-- DebtYa V107: optional status + paid_at on debts (idempotent).
-- Run once in Supabase SQL editor or via migration runner.

ALTER TABLE public.debts
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';

ALTER TABLE public.debts
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

COMMENT ON COLUMN public.debts.status IS 'active | paid | archived — V107 payoff tracking';
COMMENT ON COLUMN public.debts.paid_at IS 'When DebtYa marked the debt paid in full (balance at or below threshold)';

-- Normalize legacy rows: treat near-zero balance as paid if column was just added.
UPDATE public.debts
SET
  status = 'paid',
  paid_at = COALESCE(paid_at, updated_at, created_at, now())
WHERE
  COALESCE(balance, 0)::numeric <= 0.01
  AND COALESCE(status, 'active') <> 'archived'
  AND (status IS DISTINCT FROM 'paid');

-- Optional: keep active debts explicitly tagged
UPDATE public.debts
SET status = 'active'
WHERE
  COALESCE(balance, 0)::numeric > 0.01
  AND (status IS NULL OR status = '');

-- Note: Postgres CHECK constraints cannot use IF NOT EXISTS; skip hard CHECK to avoid
-- migration failures on heterogeneous legacy data. Application validates status values.
