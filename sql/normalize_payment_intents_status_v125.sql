-- DebtYa V125: normalize payment_intents.status and make the CHECK constraint match runtime states.
-- Idempotent. Run once in Supabase SQL editor, or with:
--   node scripts/apply-sql-file.mjs sql/normalize_payment_intents_status_v125.sql

BEGIN;

ALTER TABLE public.payment_intents
  DROP CONSTRAINT IF EXISTS payment_intents_status_check;

UPDATE public.payment_intents
SET status = CASE
  WHEN status IS NULL OR btrim(status) = '' THEN 'draft'
  WHEN lower(btrim(status)) IN ('cancel', 'canceled', 'cancelled') THEN 'cancelled'
  WHEN lower(btrim(status)) IN ('pending review', 'pending-review') THEN 'pending_review'
  WHEN lower(btrim(status)) IN ('complete', 'completed') THEN 'executed'
  ELSE lower(btrim(status))
END
WHERE status IS NULL
   OR status <> lower(btrim(status))
   OR lower(btrim(status)) IN ('cancel', 'canceled', 'pending review', 'pending-review', 'complete', 'completed');

UPDATE public.payment_intents
SET status = CASE
  WHEN executed_at IS NOT NULL THEN 'executed'
  ELSE 'draft'
END
WHERE status NOT IN (
  'draft',
  'pending',
  'queued',
  'proposed',
  'built',
  'ready',
  'pending_review',
  'approved',
  'executed',
  'cancelled',
  'failed'
);

ALTER TABLE public.payment_intents
  ALTER COLUMN status SET DEFAULT 'draft';

ALTER TABLE public.payment_intents
  ADD CONSTRAINT payment_intents_status_check
  CHECK (
    status IN (
      'draft',
      'pending',
      'queued',
      'proposed',
      'built',
      'ready',
      'pending_review',
      'approved',
      'executed',
      'cancelled',
      'failed'
    )
  );

COMMENT ON CONSTRAINT payment_intents_status_check ON public.payment_intents IS
  'DebtYa V125 canonical states: draft, pending, queued, proposed, built, ready, pending_review, approved, executed, cancelled, failed.';

COMMIT;
