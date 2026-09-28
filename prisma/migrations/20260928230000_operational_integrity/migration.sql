BEGIN;
ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_client_id_fkey, DROP CONSTRAINT agent_runs_company_id_fkey;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_client_id_fkey FOREIGN KEY (client_id) REFERENCES painel_clients(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE voice_session_telemetry DROP CONSTRAINT voice_session_telemetry_company_id_fkey;
ALTER TABLE voice_session_telemetry ADD CONSTRAINT voice_session_telemetry_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Validate tenant references on writes, also protecting non-ORM ingestion.
CREATE FUNCTION guard_operational_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE value jsonb := to_jsonb(NEW); owner uuid; conv record;
BEGIN
  IF value->>'client_id' IS NOT NULL THEN
    SELECT company_id INTO owner FROM painel_clients WHERE id=(value->>'client_id')::uuid;
    IF owner IS DISTINCT FROM (value->>'company_id')::uuid THEN
      RAISE EXCEPTION 'Client tenant mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  IF value->>'conversation_id' IS NOT NULL THEN
    SELECT company_id,client_id INTO conv FROM conversations WHERE id=(value->>'conversation_id')::uuid;
    IF NOT FOUND OR conv.company_id IS DISTINCT FROM (value->>'company_id')::uuid
      OR (value->>'client_id' IS NOT NULL AND (value->>'client_id')::uuid IS DISTINCT FROM conv.client_id) THEN
      RAISE EXCEPTION 'Conversation tenant mismatch' USING ERRCODE='23514';
    END IF;
    IF value ? 'client_id' AND value->>'client_id' IS NULL THEN
      NEW := jsonb_populate_record(NEW,jsonb_build_object('client_id',conv.client_id));
    END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['agent_runs','tool_calls','message_events','voice_session_telemetry'] LOOP
    EXECUTE format('CREATE TRIGGER tenant_reference_guard BEFORE INSERT OR UPDATE OF company_id,client_id,conversation_id ON %I FOR EACH ROW EXECUTE FUNCTION guard_operational_tenant()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['conversations','channel_connections','end_users','channel_identities','inbound_events','media_assets','outbox_events','knowledge_bases','knowledge_documents','knowledge_chunks','knowledge_embeddings','provider_credentials','credential_audit_logs','telephony_endpoints','sip_accounts','prompt_templates'] LOOP
    EXECUTE format('CREATE TRIGGER tenant_reference_guard BEFORE INSERT OR UPDATE OF company_id,client_id ON %I FOR EACH ROW EXECUTE FUNCTION guard_operational_tenant()',t);
  END LOOP;
END $$;
CREATE TRIGGER tenant_reference_guard BEFORE INSERT OR UPDATE OF company_id,conversation_id ON messages FOR EACH ROW EXECUTE FUNCTION guard_operational_tenant();

-- Stable tool identifiers survive renaming/reordering and avoid catalog-dependent collisions.
ALTER TABLE painel_apis ADD COLUMN function_name text;
DO $$ DECLARE a record; base text; chosen text; suffix integer; BEGIN
  FOR a IN SELECT id,client_id,name FROM painel_apis ORDER BY execution_order NULLS LAST,id LOOP
    base := lower(left(trim(both '_' from regexp_replace(regexp_replace(normalize(a.name,NFD),U&'[\0300-\036f]','','g'),'[^a-zA-Z0-9_-]+','_','g')),40));
    IF base='' THEN base:='tool'; END IF;
    chosen:=base; suffix:=2;
    WHILE EXISTS (SELECT 1 FROM painel_apis WHERE client_id=a.client_id AND function_name=chosen) LOOP
      chosen:=base || '_' || suffix; suffix:=suffix+1;
    END LOOP;
    UPDATE painel_apis SET function_name=chosen WHERE id=a.id;
  END LOOP;
END $$;
ALTER TABLE painel_apis ALTER COLUMN function_name SET NOT NULL;
CREATE UNIQUE INDEX painel_apis_client_id_function_name_key ON painel_apis(client_id,function_name);
CREATE FUNCTION allocate_api_function_name() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE base text; chosen text; suffix integer:=2;
BEGIN
  IF NEW.function_name IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM id FROM painel_clients WHERE id=NEW.client_id FOR UPDATE;
  base := lower(left(trim(both '_' from regexp_replace(regexp_replace(normalize(NEW.name,NFD),U&'[\0300-\036f]','','g'),'[^a-zA-Z0-9_-]+','_','g')),40));
  IF base='' THEN base:='tool'; END IF;
  chosen:=base;
  WHILE EXISTS (SELECT 1 FROM painel_apis WHERE client_id=NEW.client_id AND function_name=chosen) LOOP
    chosen:=base || '_' || suffix; suffix:=suffix+1;
  END LOOP;
  NEW.function_name:=chosen;
  RETURN NEW;
END $$;
CREATE TRIGGER api_function_name BEFORE INSERT ON painel_apis FOR EACH ROW EXECUTE FUNCTION allocate_api_function_name();
COMMIT;
