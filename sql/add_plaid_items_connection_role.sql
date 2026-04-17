-- Ejecutar en Supabase SQL Editor.
-- Clasifica cada conexión Plaid: origen del dinero (funding) vs banco de deudas (liabilities).

ALTER TABLE public.plaid_items
ADD COLUMN IF NOT EXISTS connection_role text NOT NULL DEFAULT 'unspecified';

ALTER TABLE public.plaid_items DROP CONSTRAINT IF EXISTS plaid_items_connection_role_check;

ALTER TABLE public.plaid_items
ADD CONSTRAINT plaid_items_connection_role_check
CHECK (connection_role IN ('funding', 'liabilities', 'both', 'unspecified'));

COMMENT ON COLUMN public.plaid_items.connection_role IS
  'funding = cuenta desde la que sales dinero; liabilities = banco donde estan deudas/tarjetas; both = ambos; unspecified = legado sin clasificar';
