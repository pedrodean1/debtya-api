-- Ejecutar en Supabase si la tabla password_reset_shortlinks ya existía sin email/user_id.

ALTER TABLE public.password_reset_shortlinks
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS user_id uuid;
