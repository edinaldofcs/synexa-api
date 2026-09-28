-- Widen historical production varchar columns to the Prisma text contract.
-- No truncation, default change, or business-data conversion.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE public.painel_agents ALTER COLUMN activation_mode TYPE text;
ALTER TABLE public.painel_clients ALTER COLUMN logo_icon TYPE text;
COMMIT;
