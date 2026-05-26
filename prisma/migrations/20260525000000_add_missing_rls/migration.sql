-- Row Level Security for tables missing RLS coverage
-- Phase 10: Completes tenant isolation via RLS as defense-in-depth
-- Backend uses service_role (bypasses RLS); Prisma connects directly via DATABASE_URL
-- RLS serves as defense-in-depth for any direct Supabase Data API access

-- Tables with direct company_id
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE painel_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;

-- Tables without company_id (JOIN via parent)
ALTER TABLE painel_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE painel_apis ENABLE ROW LEVEL SECURITY;
ALTER TABLE painel_intentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_state ENABLE ROW LEVEL SECURITY;

-- Policies: USING for SELECT/UPDATE/DELETE, WITH CHECK for INSERT/UPDATE

-- users: company_id is direct
CREATE POLICY "users_tenant_isolation" ON users
  FOR ALL
  USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));

-- painel_clients: company_id is direct
CREATE POLICY "painel_clients_tenant_isolation" ON painel_clients
  FOR ALL
  USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));

-- outbox_events: company_id is direct
CREATE POLICY "outbox_events_tenant_isolation" ON outbox_events
  FOR ALL
  USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));

-- painel_agents: JOIN via painel_clients
CREATE POLICY "painel_agents_tenant_isolation" ON painel_agents
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM painel_clients pc
      WHERE pc.id = painel_agents.client_id
      AND pc.company_id = (SELECT company_id FROM users WHERE id = auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM painel_clients pc
      WHERE pc.id = painel_agents.client_id
      AND pc.company_id = (SELECT company_id FROM users WHERE id = auth.uid())
    )
  );

-- painel_apis: JOIN via painel_clients
CREATE POLICY "painel_apis_tenant_isolation" ON painel_apis
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM painel_clients pc
      WHERE pc.id = painel_apis.client_id
      AND pc.company_id = (SELECT company_id FROM users WHERE id = auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM painel_clients pc
      WHERE pc.id = painel_apis.client_id
      AND pc.company_id = (SELECT company_id FROM users WHERE id = auth.uid())
    )
  );

-- painel_intentions: JOIN via painel_clients
CREATE POLICY "painel_intentions_tenant_isolation" ON painel_intentions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM painel_clients pc
      WHERE pc.id = painel_intentions.client_id
      AND pc.company_id = (SELECT company_id FROM users WHERE id = auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM painel_clients pc
      WHERE pc.id = painel_intentions.client_id
      AND pc.company_id = (SELECT company_id FROM users WHERE id = auth.uid())
    )
  );

-- conversation_state: JOIN via conversations
CREATE POLICY "conversation_state_tenant_isolation" ON conversation_state
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_state.conversation_id
      AND c.company_id = (SELECT company_id FROM users WHERE id = auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_state.conversation_id
      AND c.company_id = (SELECT company_id FROM users WHERE id = auth.uid())
    )
  );

-- Force RLS on new tables (service_role still bypasses)
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE painel_clients FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE painel_agents FORCE ROW LEVEL SECURITY;
ALTER TABLE painel_apis FORCE ROW LEVEL SECURITY;
ALTER TABLE painel_intentions FORCE ROW LEVEL SECURITY;
ALTER TABLE conversation_state FORCE ROW LEVEL SECURITY;
