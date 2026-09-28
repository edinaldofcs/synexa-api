-- Some production installations retained this BI view outside migration history.
-- This prerequisite must run before removing painel_interactions. No CASCADE:
-- an unexpected downstream dependency must stop deployment for inspection.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP VIEW IF EXISTS public.vw_bi_resumo_diario;
COMMIT;
