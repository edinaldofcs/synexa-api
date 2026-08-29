-- Trilhas de Atendimento: rename de painel_intentions + campos enriquecidos
-- (label amigável, categoria, ícone, cor, exemplos, agente responsável, ordem)

ALTER TABLE painel_intentions RENAME TO painel_tracks;

-- Renomeia constraints e índices para o novo nome da tabela
ALTER TABLE painel_tracks RENAME CONSTRAINT painel_intentions_pkey TO painel_tracks_pkey;
ALTER TABLE painel_tracks RENAME CONSTRAINT painel_intentions_client_id_fkey TO painel_tracks_client_id_fkey;
ALTER INDEX IF EXISTS painel_intentions_client_id_code_key RENAME TO painel_tracks_client_id_code_key;

-- RLS: renomeia a política de tenant isolation
ALTER POLICY "painel_intentions_tenant_isolation" ON painel_tracks
  RENAME TO "painel_tracks_tenant_isolation";

-- label amigável (backfill a partir do code)
ALTER TABLE painel_tracks ADD COLUMN label TEXT NOT NULL DEFAULT '';
UPDATE painel_tracks SET label = code WHERE label = '';
ALTER TABLE painel_tracks ALTER COLUMN label DROP DEFAULT;

ALTER TABLE painel_tracks ADD COLUMN category TEXT;
ALTER TABLE painel_tracks ADD COLUMN icon TEXT;
ALTER TABLE painel_tracks ADD COLUMN color TEXT;
ALTER TABLE painel_tracks ADD COLUMN examples JSONB;
ALTER TABLE painel_tracks ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;

-- Agente responsável (opcional)
ALTER TABLE painel_tracks ADD COLUMN agent_id UUID REFERENCES painel_agents(id) ON DELETE SET NULL ON UPDATE CASCADE;

-- Índices de consulta
CREATE INDEX "painel_tracks_client_id_idx" ON painel_tracks(client_id);
CREATE INDEX "painel_tracks_category_idx" ON painel_tracks(category);
