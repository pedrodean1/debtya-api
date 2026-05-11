-- DebtYa V107: status + paid_at on debts (idempotent).
-- Run once in Supabase SQL editor or via migration runner.

ALTER TABLE public.debts
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';

ALTER TABLE public.debts
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

COMMENT ON COLUMN public.debts.status IS 'active | paid | archived — V107 payoff tracking';
COMMENT ON COLUMN public.debts.paid_at IS 'When DebtYa marked the debt paid in full (balance at or below threshold)';

-- Normalize legacy rows using balance, or balance/current_balance when current_balance exists.
DO $$
DECLARE
  has_cb boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'debts'
      AND column_name = 'current_balance'
  )
  INTO has_cb;

  IF has_cb THEN
    UPDATE public.debts
    SET
      status = 'paid',
      paid_at = COALESCE(paid_at, updated_at, created_at, now())
    WHERE
      COALESCE(balance, current_balance, 0)::numeric <= 0.01
      AND COALESCE(status, 'active') <> 'archived'
      AND (status IS DISTINCT FROM 'paid');

    UPDATE public.debts
    SET status = 'active'
    WHERE
      COALESCE(balance, current_balance, 0)::numeric > 0.01
      AND (status IS NULL OR status = '');
  ELSE
    UPDATE public.debts
    SET
      status = 'paid',
      paid_at = COALESCE(paid_at, updated_at, created_at, now())
    WHERE
      COALESCE(balance, 0)::numeric <= 0.01
      AND COALESCE(status, 'active') <> 'archived'
      AND (status IS DISTINCT FROM 'paid');

    UPDATE public.debts
    SET status = 'active'
    WHERE
      COALESCE(balance, 0)::numeric > 0.01
      AND (status IS NULL OR status = '');
  END IF;
END $$;

-- Optional CHECK: add NOT VALID then validate; skip validate if legacy rows violate IN list.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'debts_status_chk'
  ) THEN
    ALTER TABLE public.debts
      ADD CONSTRAINT debts_status_chk
      CHECK (status IS NULL OR status IN ('active', 'paid', 'archived'))
      NOT VALID;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  BEGIN
    ALTER TABLE public.debts VALIDATE CONSTRAINT debts_status_chk;
  EXCEPTION
    WHEN undefined_object THEN NULL;
    WHEN check_violation THEN
      RAISE NOTICE 'Skipping VALIDATE debts_status_chk: fix invalid status values then re-run VALIDATE.';
  END;
END $$;
