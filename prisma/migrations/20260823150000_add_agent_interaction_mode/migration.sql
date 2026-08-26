ALTER TABLE "painel_agents"
ADD COLUMN "interaction_mode" TEXT NOT NULL DEFAULT 'both';

ALTER TABLE "painel_agents"
ADD CONSTRAINT "painel_agents_interaction_mode_check"
CHECK ("interaction_mode" IN ('text', 'voice', 'both'));
