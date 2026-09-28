BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM conversations WHERE status='active' AND origin_channel='voice' AND voice_heartbeat_at>now()-interval '2 minutes') THEN
    RAISE EXCEPTION 'Drain active voice sessions before migrating';
  END IF;
END $$;
-- Run only after stopping voice runtimes. Preserve the last observed time, without estimating usage.
UPDATE conversations SET status='closed',closed_at=coalesce(closed_at,voice_heartbeat_at),voice_finalized_at=now(),
  metadata=coalesce(metadata,'{}') || '{"hangup_cause":"reconciled_after_restart","ended_at_source":"last_heartbeat"}'::jsonb
WHERE status='active' AND origin_channel='voice' AND voice_heartbeat_at<now()-interval '2 minutes';
ALTER TABLE painel_clients ADD CONSTRAINT client_company_name_nonempty CHECK (company_name IS NULL OR length(btrim(company_name))>0) NOT VALID;
ALTER TABLE painel_clients ADD CONSTRAINT client_agent_name_nonempty CHECK (agent_name IS NULL OR length(btrim(agent_name))>0) NOT VALID;
CREATE FUNCTION guard_active_agent_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.is_active AND NOT EXISTS (SELECT 1 FROM painel_clients c WHERE c.id=NEW.client_id AND nullif(btrim(c.company_name),'') IS NOT NULL AND nullif(btrim(c.agent_name),'') IS NOT NULL) THEN
    RAISE EXCEPTION 'Company and agent identity required before activation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER active_agent_identity BEFORE INSERT OR UPDATE OF is_active,client_id ON painel_agents FOR EACH ROW EXECUTE FUNCTION guard_active_agent_identity();
CREATE FUNCTION guard_client_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (nullif(btrim(NEW.company_name),'') IS NULL OR nullif(btrim(NEW.agent_name),'') IS NULL) AND EXISTS (SELECT 1 FROM painel_agents WHERE client_id=NEW.id AND is_active) THEN
    RAISE EXCEPTION 'Cannot clear identity of an active client' USING ERRCODE='23514';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'Client tenant cannot be reassigned' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER client_identity BEFORE UPDATE OF company_id,company_name,agent_name ON painel_clients FOR EACH ROW EXECUTE FUNCTION guard_client_identity();
COMMIT;
