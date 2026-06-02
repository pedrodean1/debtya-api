-- DebtYa V119: audit/dedupe events for scheduled minimum payment due emails.
-- Run manually in Supabase SQL Editor. Idempotent.
--
-- The minimum-payment due email must not participate in the general reminder
-- cooldown, so it uses event_type = 'minimum_payment_due' instead of
-- 'auto_reminder'. Only the backend service_role should access this table.

ALTER TABLE public.notification_events
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.notification_events
  ADD COLUMN IF NOT EXISTS message text NOT NULL DEFAULT 'DebtYa reminder sent';

ALTER TABLE public.notification_events
  DROP CONSTRAINT IF EXISTS notification_events_event_type_check;

ALTER TABLE public.notification_events
  ADD CONSTRAINT notification_events_event_type_check
  CHECK (
    event_type IN (
      'auto_reminder',
      'test',
      'skipped_no_provider',
      'skipped_cadence',
      'skipped_window',
      'minimum_payment_due'
    )
  );

CREATE INDEX IF NOT EXISTS idx_notification_events_minimum_due_lookup
  ON public.notification_events (user_id, channel, event_type, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_events_minimum_due_unique
  ON public.notification_events (
    user_id,
    channel,
    ((metadata->>'debt_id')),
    ((metadata->>'date_key'))
  )
  WHERE event_type = 'minimum_payment_due'
    AND metadata ? 'debt_id'
    AND metadata ? 'date_key';

COMMENT ON CONSTRAINT notification_events_event_type_check ON public.notification_events IS
  'Allows minimum_payment_due audit events without making them auto_reminder cooldown inputs.';

COMMENT ON INDEX public.idx_notification_events_minimum_due_unique IS
  'Prevents duplicate minimum payment due email audit events for the same user/debt/date.';

ALTER TABLE public.notification_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_events FROM anon;
REVOKE ALL ON public.notification_events FROM authenticated;
GRANT ALL ON public.notification_events TO service_role;
