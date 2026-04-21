-- Paso final de recuperación (sin depender del redirect de Supabase al front).
-- Tras POST /auth/recover la API crea una fila aquí y redirige a GET /auth/reset-password?t=...
-- Ejecutar en Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS public.password_reset_finish (
  token text PRIMARY KEY,
  email text NOT NULL,
  user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_finish_expires_idx
  ON public.password_reset_finish (expires_at);

COMMENT ON TABLE public.password_reset_finish IS
  'Token de un solo uso para la pantalla API de nueva contraseña + código (tras /auth/recover).';

ALTER TABLE public.password_reset_finish DISABLE ROW LEVEL SECURITY;
