ALTER TABLE painel_agents
  ADD COLUMN is_initial BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN activation_conditions JSONB DEFAULT NULL,
  ADD COLUMN activation_mode VARCHAR(20) DEFAULT 'on_next_message';
