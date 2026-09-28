-- Run with psql -v ON_ERROR_STOP=1 as database administrator after migrations.
-- Requires the production SIP roles and at least one eligible SIP account.
-- Reads counts only: never print SIP password digests.
BEGIN READ ONLY;
DO $$
DECLARE expected bigint; actual bigint;
BEGIN
  SELECT count(*) INTO expected
  FROM public.sip_accounts s
  JOIN public.companies c ON c.id = s.company_id
  JOIN public.painel_clients p ON p.id = s.client_id AND p.company_id = s.company_id
  WHERE s.enabled AND c.status = 'active';
  IF expected = 0 THEN
    RAISE EXCEPTION 'Test requires an enabled SIP account in an active company';
  END IF;
  SELECT count(*) INTO actual FROM public.synexa_sip_endpoints;
  IF actual <> expected THEN
    RAISE EXCEPTION 'SIP endpoints hidden by RLS or incorrectly scoped';
  END IF;
  IF has_table_privilege('synexa_sip', 'public.sip_accounts', 'SELECT') THEN
    RAISE EXCEPTION 'SIP login must not read the underlying accounts table';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'synexa_sip_view_owner'
    AND (rolcanlogin OR rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'SIP view owner has excessive privileges';
  END IF;
END $$;
SET LOCAL ROLE synexa_sip;
DO $$
DECLARE endpoints bigint; auths bigint; aors bigint;
BEGIN
  SELECT count(*) INTO endpoints FROM public.synexa_sip_endpoints;
  SELECT count(*) INTO auths FROM public.synexa_sip_auths;
  SELECT count(*) INTO aors FROM public.synexa_sip_aors;
  PERFORM count(*) FROM public.synexa_sip_routes;
  IF endpoints = 0 OR endpoints <> auths OR endpoints <> aors THEN
    RAISE EXCEPTION 'SIP login cannot read consistent registration views';
  END IF;
  IF has_table_privilege(current_user, 'public.synexa_sip_endpoints', 'INSERT') THEN
    RAISE EXCEPTION 'SIP login must not write endpoints';
  END IF;
END $$;
ROLLBACK;
