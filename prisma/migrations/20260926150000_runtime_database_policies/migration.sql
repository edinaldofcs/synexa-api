-- The server authenticates users in Redis and applies company scope in Prisma.
-- auth.uid()-based policies are for direct end-user database sessions, not the
-- pooled backend connection. Preserve them for the dedicated NOLOGIN role.
DO $$
DECLARE item record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synexa_app')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synexa_end_user') THEN
    FOR item IN SELECT schemaname, tablename, policyname FROM pg_policies
      WHERE schemaname IN ('public', 'auth') AND roles = ARRAY['public']::name[]
    LOOP
      EXECUTE format('ALTER POLICY %I ON %I.%I TO synexa_end_user', item.policyname, item.schemaname, item.tablename);
    END LOOP;
    FOR item IN SELECT n.nspname, c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public','auth') AND c.relrowsecurity
    LOOP
      EXECUTE format('CREATE POLICY synexa_backend_dml ON %I.%I FOR ALL TO synexa_app USING (true) WITH CHECK (true)', item.nspname, item.relname);
    END LOOP;
  END IF;
END $$;
