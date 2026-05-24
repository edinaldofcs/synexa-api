-- Row Level Security for multi-tenant isolation
-- Run this in Supabase SQL editor or via migration

-- Enable RLS on all enterprise tables
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE end_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_identities ENABLE ROW LEVEL SECURITY;

-- Users can only see rows from their own company
CREATE POLICY company_isolation ON companies
  FOR ALL USING (id = (SELECT company_id FROM users WHERE id = auth.uid()));

CREATE POLICY company_isolation ON conversations
  FOR ALL USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));

CREATE POLICY company_isolation ON messages
  FOR ALL USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));

CREATE POLICY company_isolation ON message_parts
  FOR ALL USING (EXISTS (
    SELECT 1 FROM messages m
    WHERE m.id = message_parts.message_id
    AND m.company_id = (SELECT company_id FROM users WHERE id = auth.uid())
  ));

CREATE POLICY company_isolation ON media_assets
  FOR ALL USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));

CREATE POLICY company_isolation ON inbound_events
  FOR ALL USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));

CREATE POLICY company_isolation ON agent_runs
  FOR ALL USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));

CREATE POLICY company_isolation ON tool_calls
  FOR ALL USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));

CREATE POLICY company_isolation ON message_events
  FOR ALL USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));

CREATE POLICY company_isolation ON knowledge_bases
  FOR ALL USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));

CREATE POLICY company_isolation ON knowledge_documents
  FOR ALL USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));

CREATE POLICY company_isolation ON knowledge_chunks
  FOR ALL USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));

CREATE POLICY company_isolation ON knowledge_embeddings
  FOR ALL USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));

CREATE POLICY company_isolation ON channel_connections
  FOR ALL USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));

CREATE POLICY company_isolation ON webhook_endpoints
  FOR ALL USING (EXISTS (
    SELECT 1 FROM painel_clients pc
    WHERE pc.id = webhook_endpoints.client_id
    AND pc.company_id = (SELECT company_id FROM users WHERE id = auth.uid())
  ));

CREATE POLICY company_isolation ON webhook_deliveries
  FOR ALL USING (EXISTS (
    SELECT 1 FROM webhook_endpoints we
    JOIN painel_clients pc ON pc.id = we.client_id
    WHERE we.id = webhook_deliveries.webhook_endpoint_id
    AND pc.company_id = (SELECT company_id FROM users WHERE id = auth.uid())
  ));

CREATE POLICY company_isolation ON end_users
  FOR ALL USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));

CREATE POLICY company_isolation ON channel_identities
  FOR ALL USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));

-- Service role bypass (for workers and internal services)
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
ALTER TABLE message_parts FORCE ROW LEVEL SECURITY;
ALTER TABLE media_assets FORCE ROW LEVEL SECURITY;
ALTER TABLE inbound_events FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE tool_calls FORCE ROW LEVEL SECURITY;
ALTER TABLE message_events FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_bases FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_embeddings FORCE ROW LEVEL SECURITY;
ALTER TABLE channel_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE end_users FORCE ROW LEVEL SECURITY;
ALTER TABLE channel_identities FORCE ROW LEVEL SECURITY;
