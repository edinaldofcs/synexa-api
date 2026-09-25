ALTER TABLE conversations ADD COLUMN voice_heartbeat_at timestamptz, ADD COLUMN voice_finalized_at timestamptz;
CREATE TABLE call_exports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL UNIQUE,
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE ON UPDATE CASCADE,
 client_id uuid NOT NULL REFERENCES painel_clients(id) ON DELETE CASCADE ON UPDATE CASCADE,
 endpoint_id uuid NOT NULL, payload_enc text, destination_enc text,
 status text NOT NULL DEFAULT 'pending', attempt integer NOT NULL DEFAULT 0,
 http_status integer, error_code text, expires_at timestamptz NOT NULL,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_token text,
 created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz, purged_at timestamptz
);
CREATE INDEX call_exports_status_next_attempt_at_idx ON call_exports(status, next_attempt_at);
CREATE INDEX call_exports_client_id_created_at_idx ON call_exports(client_id, created_at);
CREATE INDEX call_exports_company_id_idx ON call_exports(company_id);
CREATE UNIQUE INDEX webhook_call_export_one_per_client ON webhook_endpoints(client_id)
 WHERE enabled = true AND events @> '["call.completed"]'::jsonb;
CREATE INDEX call_exports_due_idx ON call_exports(next_attempt_at) WHERE purged_at IS NULL;

-- Billing keeps numeric usage after conversation content is removed.
ALTER TABLE voice_session_telemetry ALTER COLUMN conversation_id DROP NOT NULL;
