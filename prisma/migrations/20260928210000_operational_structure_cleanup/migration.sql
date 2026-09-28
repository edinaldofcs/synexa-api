BEGIN;

-- Abort instead of silently discarding a deployment's live legacy content.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM conversations WHERE ai_context IS NOT NULL OR current_step IS NOT NULL OR assigned_to IS NOT NULL OR coalesce(priority,0) <> 0 OR coalesce(mode,'auto') <> 'auto')
     OR EXISTS (SELECT 1 FROM messages WHERE external_message_id IS NOT NULL OR channel_message_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM channel_connections WHERE default_webhook_endpoint_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM outbox_events WHERE locked_at IS NOT NULL OR locked_by IS NOT NULL)
     OR EXISTS (SELECT 1 FROM painel_clients WHERE max_concurrent_calls IS NOT NULL) THEN
    RAISE EXCEPTION 'Legacy content requires explicit review before structure cleanup';
  END IF;
END $$;

ALTER TABLE painel_apis ADD COLUMN config jsonb;
UPDATE painel_apis SET config = coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(coalesce(headers,'{}')) WHERE key IN ('field_description','next_api_id','request_schema','response_schema')), '{}'),
  headers = coalesce(headers,'{}') - ARRAY['field_description','next_api_id','request_schema','response_schema'];
UPDATE painel_apis SET headers=(headers-'headers') || (headers->'headers') WHERE jsonb_typeof(headers->'headers')='object';

-- Only clean the envelope produced by the retired metadata generator.
UPDATE painel_clients c SET metadata =
  (c.metadata - ARRAY['sessionId','phone_number','company_name','strategy','tentativas','ofertas_disponiveis']
    - coalesce((SELECT array_agg(a.id::text) FROM painel_agents a WHERE a.client_id=c.id), ARRAY[]::text[])
    - coalesce((SELECT array_agg(a.name) FROM painel_apis a WHERE a.client_id=c.id AND c.metadata->a.name='false'::jsonb), ARRAY[]::text[]))
  #- '{metadata,activation_rules}'
WHERE c.metadata #> '{metadata,activation_rules}' IS NOT NULL;

ALTER TABLE conversations DROP COLUMN ai_context, DROP COLUMN current_step, DROP COLUMN assigned_to, DROP COLUMN priority, DROP COLUMN mode;
ALTER TABLE painel_clients DROP COLUMN max_concurrent_calls;
ALTER TABLE messages DROP COLUMN external_message_id, DROP COLUMN channel_message_id;
ALTER TABLE channel_connections DROP COLUMN default_webhook_endpoint_id;
ALTER TABLE outbox_events DROP COLUMN locked_at, DROP COLUMN locked_by;
UPDATE prompt_templates SET category='custom' WHERE category='human_handover';

ALTER TABLE voice_session_telemetry DROP CONSTRAINT voice_session_telemetry_conversation_id_fkey;
ALTER TABLE voice_session_telemetry ADD CONSTRAINT voice_session_telemetry_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL ON UPDATE CASCADE;
DROP INDEX IF EXISTS voice_session_telemetry_conversation_id_idx;

-- A single owner for timestamp/version, including non-ORM writers.
CREATE FUNCTION bump_conversation_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  NEW.updated_at = clock_timestamp();
  NEW.version = OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER conversation_state_version BEFORE UPDATE ON conversation_state FOR EACH ROW EXECUTE FUNCTION bump_conversation_state();

-- Recover only explicit, valid agent references belonging to the same client.
UPDATE conversations c SET current_agent_id = a.id
FROM painel_agents a WHERE c.current_agent_id IS NULL AND a.client_id=c.client_id AND
  a.id::text = coalesce((SELECT s.state->>'current_agent_id' FROM conversation_state s WHERE s.conversation_id=c.id), c.metadata->>'agent_id');
UPDATE message_events e SET client_id=c.client_id FROM conversations c
WHERE e.conversation_id=c.id AND e.company_id=c.company_id AND e.client_id IS NULL;

ALTER TABLE webhook_deliveries ADD COLUMN lease_until timestamptz(6), ADD COLUMN lease_token text;
CREATE INDEX webhook_deliveries_status_lease_until_idx ON webhook_deliveries(status,lease_until);
CREATE INDEX users_company_id_idx ON users(company_id);
CREATE INDEX painel_agents_client_id_idx ON painel_agents(client_id);
CREATE INDEX painel_apis_client_id_active_execution_order_idx ON painel_apis(client_id,active,execution_order);
CREATE INDEX painel_apis_agent_id_idx ON painel_apis(agent_id);
CREATE INDEX webhook_endpoints_channel_connection_id_idx ON webhook_endpoints(channel_connection_id);
CREATE INDEX channel_identities_end_user_id_idx ON channel_identities(end_user_id);
CREATE INDEX inbound_events_channel_connection_id_idx ON inbound_events(channel_connection_id);
CREATE INDEX tool_calls_message_id_idx ON tool_calls(message_id);
CREATE INDEX agent_runs_agent_id_idx ON agent_runs(agent_id);
CREATE INDEX agent_runs_inbound_message_id_idx ON agent_runs(inbound_message_id);
CREATE INDEX agent_runs_response_message_id_idx ON agent_runs(response_message_id);
CREATE INDEX agent_runs_company_id_started_at_idx ON agent_runs(company_id,started_at);
CREATE INDEX knowledge_documents_media_asset_id_idx ON knowledge_documents(media_asset_id);
CREATE INDEX voice_session_telemetry_company_id_created_at_idx ON voice_session_telemetry(company_id,created_at);
CREATE UNIQUE INDEX painel_agents_one_initial_per_client ON painel_agents(client_id) WHERE is_initial AND is_active;

-- Keep direct database access closed; the existing backend role uses application tenant scope.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['call_exports','credential_audit_logs','prompt_templates','provider_credentials','sip_accounts','voice_session_telemetry'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='synexa_app') THEN
      EXECUTE format('CREATE POLICY synexa_backend_dml ON %I FOR ALL TO synexa_app USING (true) WITH CHECK (true)',t);
    END IF;
  END LOOP;
END $$;
COMMIT;
