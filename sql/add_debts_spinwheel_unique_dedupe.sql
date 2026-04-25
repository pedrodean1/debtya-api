-- DebtYa: idempotencia Spinwheel en public.debts (dedupe + índice único parcial).
-- Ejecutar en Supabase SQL Editor en este orden.

-- 1) Eliminar duplicados: misma fila lógica = user_id + source + spinwheel_external_id (solo source spinwheel con ext).
DELETE FROM public.debts d
WHERE d.id IN (
  SELECT id
  FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY user_id, source, spinwheel_external_id
        ORDER BY
          COALESCE(updated_at, created_at) DESC NULLS LAST,
          (CASE WHEN raw_spinwheel IS NOT NULL THEN 1 ELSE 0 END) DESC,
          id DESC
      ) AS rn
    FROM public.debts
    WHERE source = 'spinwheel'
      AND spinwheel_external_id IS NOT NULL
  ) sub
  WHERE sub.rn > 1
);

-- Índice previo (no único) sustituido por el único parcial.
DROP INDEX IF EXISTS idx_debts_spinwheel_user_ext;

-- 2) Garantizar unicidad para import Spinwheel (PostgREST upsert onConflict).
CREATE UNIQUE INDEX IF NOT EXISTS uq_debts_user_source_spinwheel_ext
  ON public.debts (user_id, source, spinwheel_external_id)
  WHERE spinwheel_external_id IS NOT NULL;

COMMENT ON INDEX public.uq_debts_user_source_spinwheel_ext IS
  'Una fila por usuario/origen Spinwheel y liability Spinwheel; evita duplicados en POST /spinwheel/import-debts.';
