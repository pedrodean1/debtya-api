-- Ejecutar en Supabase SQL Editor.
-- Códigos de verificación de registro (solo accesible con service role desde la API).

CREATE TABLE IF NOT EXISTS public.signup_verification_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signup_verification_codes_email_lower_idx
  ON public.signup_verification_codes (lower(trim(email)));

CREATE INDEX IF NOT EXISTS signup_verification_codes_expires_idx
  ON public.signup_verification_codes (expires_at);

ALTER TABLE public.signup_verification_codes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.signup_verification_codes IS
  'Códigos de un solo uso para verificar email antes de crear cuenta; la API usa service role.';
