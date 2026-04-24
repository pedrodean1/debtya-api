-- DebtYa: vínculo Supabase Auth ↔ Spinwheel userId por entorno (sandbox | production).
-- Ejecutar en Supabase SQL Editor (idempotente: IF NOT EXISTS / DROP POLICY IF EXISTS).

CREATE TABLE IF NOT EXISTS public.spinwheel_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  spinwheel_user_id uuid NOT NULL,
  environment text NOT NULL DEFAULT 'sandbox',
  status text NOT NULL DEFAULT 'active',
  raw_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spinwheel_users_environment_check CHECK (environment IN ('sandbox', 'production')),
  CONSTRAINT spinwheel_users_user_env_unique UNIQUE (user_id, environment),
  CONSTRAINT spinwheel_users_spinwheel_env_unique UNIQUE (spinwheel_user_id, environment)
);

CREATE INDEX IF NOT EXISTS idx_spinwheel_users_user_id ON public.spinwheel_users (user_id);
CREATE INDEX IF NOT EXISTS idx_spinwheel_users_spinwheel_user_id ON public.spinwheel_users (spinwheel_user_id);

COMMENT ON TABLE public.spinwheel_users IS
  'Mapeo 1:1 por entorno entre usuario DebtYa (auth.users) y userId Spinwheel; RLS para acceso cliente.';

ALTER TABLE public.spinwheel_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS spinwheel_users_select_own ON public.spinwheel_users;
CREATE POLICY spinwheel_users_select_own
  ON public.spinwheel_users
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS spinwheel_users_insert_own ON public.spinwheel_users;
CREATE POLICY spinwheel_users_insert_own
  ON public.spinwheel_users
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS spinwheel_users_update_own ON public.spinwheel_users;
CREATE POLICY spinwheel_users_update_own
  ON public.spinwheel_users
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS spinwheel_users_delete_own ON public.spinwheel_users;
CREATE POLICY spinwheel_users_delete_own
  ON public.spinwheel_users
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.spinwheel_users FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.spinwheel_users TO authenticated;
GRANT ALL ON public.spinwheel_users TO service_role;

CREATE OR REPLACE FUNCTION public.spinwheel_users_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS spinwheel_users_touch_updated_at ON public.spinwheel_users;
CREATE TRIGGER spinwheel_users_touch_updated_at
  BEFORE UPDATE ON public.spinwheel_users
  FOR EACH ROW
  EXECUTE FUNCTION public.spinwheel_users_touch_updated_at();
