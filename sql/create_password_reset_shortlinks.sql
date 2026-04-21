-- Enlace corto de recuperación: token -> URL larga de Supabase (un solo uso).
-- Ejecutar en Supabase SQL Editor. La API usa service role (sin RLS necesario).

CREATE TABLE IF NOT EXISTS public.password_reset_shortlinks (
  token text PRIMARY KEY,
  target_url text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  email text,
  user_id uuid
);

CREATE INDEX IF NOT EXISTS password_reset_shortlinks_expires_idx
  ON public.password_reset_shortlinks (expires_at);

COMMENT ON TABLE public.password_reset_shortlinks IS
  'Tokens de un solo uso para acortar el enlace de recuperación; email/user_id permiten POST /auth/recover -> /auth/reset-password en la API sin depender del front.';

-- Service role ya bypass RLS; por si el proyecto fuerza RLS por defecto en tablas nuevas:
ALTER TABLE public.password_reset_shortlinks DISABLE ROW LEVEL SECURITY;
