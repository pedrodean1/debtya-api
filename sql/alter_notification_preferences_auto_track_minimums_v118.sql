-- DebtYa V118: opt-in automatic scheduled minimum payment tracking.
-- Run manually in Supabase SQL Editor. Idempotent.
-- DebtYa does not make payments or move money; this only stores an opt-in tracking preference
-- and prevents the same scheduled minimum from being auto-tracked twice for the same debt/date.

ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS auto_track_minimum_payments boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.notification_preferences.auto_track_minimum_payments IS
  'Opt-in only. When true, DebtYa may record scheduled minimum payments in app history when due_day arrives. DebtYa does not make the payment.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_auto_minimum_tracking_unique
  ON public.payment_intents (user_id, debt_id, scheduled_for)
  WHERE source = 'scheduled_minimum_tracking';