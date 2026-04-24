-- DebtYa: guardar último debt profile Spinwheel sin que connect/verify lo pisen.
-- Ejecutar en Supabase SQL Editor (service role / SQL).

ALTER TABLE public.spinwheel_users
  ADD COLUMN IF NOT EXISTS spinwheel_debt_profile_raw jsonb NULL;

COMMENT ON COLUMN public.spinwheel_users.spinwheel_debt_profile_raw IS
  'Último JSON completo de debt profile (POST .../debtProfile). Import y caché; no se borra en verify.';

-- Opcional: copiar perfiles ya guardados solo en raw_response antes de esta migración.
UPDATE public.spinwheel_users u
SET spinwheel_debt_profile_raw = u.raw_response
WHERE u.spinwheel_debt_profile_raw IS NULL
  AND u.raw_response IS NOT NULL
  AND (
    jsonb_typeof(u.raw_response->'data'->'creditCards') = 'array'
    OR jsonb_typeof(u.raw_response->'data'->'autoLoans') = 'array'
    OR jsonb_typeof(u.raw_response->'data'->'homeLoans') = 'array'
    OR jsonb_typeof(u.raw_response->'data'->'personalLoans') = 'array'
    OR jsonb_typeof(u.raw_response->'data'->'studentLoans') = 'array'
    OR jsonb_typeof(u.raw_response->'data'->'miscellaneousLiabilities') = 'array'
  );
