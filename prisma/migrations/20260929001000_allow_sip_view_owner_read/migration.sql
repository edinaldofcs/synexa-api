-- Asterisk reads restricted views owned by a dedicated NOLOGIN role.
-- Enabling RLS on sip_accounts must preserve that view owner's SELECT path.
-- Do not grant the SIP login direct table access or disable row security.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='synexa_sip_view_owner') THEN
    CREATE POLICY synexa_sip_view_read ON public.sip_accounts
      FOR SELECT TO synexa_sip_view_owner USING (true);
  END IF;
END $$;
COMMIT;
