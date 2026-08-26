-- Business events for configurable operational analytics markers
CREATE TABLE IF NOT EXISTS business_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  client_id UUID REFERENCES painel_clients(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  end_user_id UUID REFERENCES end_users(id),
  marker_code TEXT NOT NULL,
  values JSONB DEFAULT '{}',
  origin_channel TEXT,
  created_at TIMESTAMPTZ(6) DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS business_events_conversation_marker_key ON business_events(conversation_id, marker_code);
CREATE INDEX IF NOT EXISTS business_events_company_marker_created_idx ON business_events(company_id, marker_code, created_at);
CREATE INDEX IF NOT EXISTS business_events_client_marker_created_idx ON business_events(client_id, marker_code, created_at);
