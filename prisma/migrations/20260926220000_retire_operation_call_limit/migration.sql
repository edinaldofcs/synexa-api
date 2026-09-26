-- Retire the secondary bot quota. CompanyVoiceQuotaService is the authority.
-- Preserve FORCE RLS after an atomic, table-owner-only data migration.
DO $$ DECLARE was_forced boolean; BEGIN
 SELECT relforcerowsecurity INTO was_forced FROM pg_class WHERE oid='public.painel_clients'::regclass;
 ALTER TABLE public.painel_clients NO FORCE ROW LEVEL SECURITY;
 UPDATE public.painel_clients SET max_concurrent_calls=NULL WHERE max_concurrent_calls IS NOT NULL;
 ALTER TABLE public.painel_clients ALTER COLUMN max_concurrent_calls DROP DEFAULT;
 IF was_forced THEN ALTER TABLE public.painel_clients FORCE ROW LEVEL SECURITY; END IF;
END $$;
