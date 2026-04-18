-- Enlace corto de recuperación: token -> URL larga de Supabase (un solo uso).
-- Ejecutar en Supabase SQL Editor. La API usa service role (sin RLS necesario).

CREATE TABLE IF NOT EXISTS public.password_reset_shortlinks (
  token text PRIMARY KEY,
  target_url text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_shortlinks_expires_idx
  ON public.password_reset_shortlinks (expires_at);

COMMENT ON TABLE public.password_reset_shortlinks IS
  'Tokens de un solo uso para acortar el enlace de recuperación de contraseña; la API inserta y GET /auth/recover redirige.';
