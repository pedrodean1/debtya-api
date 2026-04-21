-- Si la tabla ya existía sin este paso, ejecutar en Supabase SQL Editor (una vez).

ALTER TABLE IF EXISTS public.password_reset_shortlinks DISABLE ROW LEVEL SECURITY;
