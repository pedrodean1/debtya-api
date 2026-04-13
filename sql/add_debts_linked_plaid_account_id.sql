-- Ejecutar en Supabase SQL Editor (PostgreSQL) antes de usar el vinculo deudas <-> cuentas Plaid.
-- Opcional pero recomendado: indice parcial para busquedas por vinculo.

ALTER TABLE public.debts
ADD COLUMN IF NOT EXISTS linked_plaid_account_id text NULL;

COMMENT ON COLUMN public.debts.linked_plaid_account_id IS
  'plaid_account_id de public.accounts (misma cuenta importada) cuando el usuario vincula una deuda manual.';

CREATE INDEX IF NOT EXISTS idx_debts_linked_plaid_account_id
  ON public.debts (linked_plaid_account_id)
  WHERE linked_plaid_account_id IS NOT NULL;
