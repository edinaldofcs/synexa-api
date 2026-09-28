-- Run only after backup verification, ingress suspension and delivery drain.
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM call_exports WHERE purged_at IS NULL) THEN
    RAISE EXCEPTION 'Drain existing call exports before migrating; prepared payloads must not be rewritten';
  END IF;
  IF EXISTS (SELECT 1 FROM webhook_deliveries WHERE event='call.completed'
             AND status IN ('pending','processing')) THEN
    RAISE EXCEPTION 'Drain pending call.completed deliveries before migrating';
  END IF;
  IF EXISTS (SELECT 1 FROM conversations WHERE voice_finalized_at IS NULL
             AND voice_heartbeat_at > now() - interval '2 minutes') THEN
    RAISE EXCEPTION 'Finish active voice sessions before migrating';
  END IF;
END $$;

CREATE FUNCTION pg_temp.object_or_empty(value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'object' THEN value ELSE '{}'::jsonb END
$$;

-- Recover raw variables only, never interaction columns containing inferred metrics.
-- Both tenant identifiers must match. Orphans are deliberately not recreated.
WITH raw AS (
  SELECT c.id,
    pg_temp.object_or_empty(i.context_variables)
    || pg_temp.object_or_empty(c.metadata #> '{session_record,dados_variaveis}')
    || pg_temp.object_or_empty(c.metadata #> '{session_data,variables}')
    || pg_temp.object_or_empty(c.metadata -> 'context_variables')
    || pg_temp.object_or_empty(c.metadata -> 'test_chat_context_variables') AS variables,
    c.client_id
  FROM conversations c
  LEFT JOIN painel_interactions i ON i.session_id = c.id::text
    AND i.company_id = c.company_id AND i.client_id = c.client_id
), recovered AS (
  SELECT r.id, COALESCE(jsonb_object_agg(v.key, v.value), '{}'::jsonb) AS variables
  FROM raw r CROSS JOIN LATERAL jsonb_each(r.variables) v
  WHERE v.key NOT LIKE '\_%'
    AND v.key <> ALL(ARRAY['__proto__','constructor','prototype',
      'analytics_config','session_output_config','report_bindings','report_values',
      'session_record','session_data','ai_summary','sentiment',
      'available_apis','current_agent_id','pending_agent_id','switch_reason',
      'inbound_variable_mapping','activation_rules','llm_providers',
      'llm_providers_updated_at','variable_schema','metadata','sessionId',
      'company_id','client_id','nome_agente','nome_empresa','agent_name','company_name',
      'authorization','password','secret','api_key','access_token','refresh_token'])
    AND NOT EXISTS (SELECT 1 FROM painel_agents a WHERE a.client_id=r.client_id AND a.id::text=v.key)
    AND NOT EXISTS (SELECT 1 FROM painel_apis a WHERE a.client_id=r.client_id AND a.name=v.key)
  GROUP BY r.id
)
INSERT INTO conversation_state(conversation_id, state)
SELECT id, variables FROM recovered WHERE variables <> '{}'::jsonb
ON CONFLICT (conversation_id) DO UPDATE
  SET state = EXCLUDED.state || conversation_state.state;

-- Metadata belongs to the platform. Business objects inside variables are not traversed.
UPDATE conversations SET metadata = metadata - ARRAY[
  'analytics_config','session_output_config','report_bindings','report_values',
  'session_record','session_data','ai_summary','sentiment'];
UPDATE painel_clients SET metadata = metadata - ARRAY[
  'analytics_config','session_output_config','report_bindings','report_values',
  'session_record','session_data','ai_summary','sentiment'];

UPDATE painel_clients SET metadata = jsonb_set(metadata, '{variable_schema}',
  (metadata -> 'variable_schema') - 'session_output_config')
WHERE jsonb_typeof(metadata -> 'variable_schema') = 'object';

-- Previously generated metadata can also be present in runtime context snapshots.
DO $$ DECLARE context_key text; BEGIN
  FOREACH context_key IN ARRAY ARRAY['context_variables','test_chat_context_variables'] LOOP
    UPDATE conversations SET metadata = jsonb_set(metadata, ARRAY[context_key],
      (metadata -> context_key) - ARRAY['analytics_config','session_output_config',
       'report_bindings','report_values','session_record','session_data','ai_summary','sentiment'])
    WHERE jsonb_typeof(metadata -> context_key) = 'object';
  END LOOP;
END $$;

-- Strip only rule definitions; preserve customer data with the same property name.
DO $$ DECLARE config_key text; BEGIN
  FOREACH config_key IN ARRAY ARRAY['inbound_variable_mapping','inbound_mapping'] LOOP
    UPDATE painel_clients c SET metadata = jsonb_set(metadata, ARRAY[config_key,'rules'],
      (SELECT COALESCE(jsonb_agg(rule - 'report_target' ORDER BY ordinal), '[]'::jsonb)
       FROM jsonb_array_elements(c.metadata #> ARRAY[config_key,'rules']) WITH ORDINALITY a(rule, ordinal)))
    WHERE jsonb_typeof(metadata #> ARRAY[config_key,'rules']) = 'array';
  END LOOP;
END $$;

UPDATE painel_apis a SET extract_data = (
  SELECT COALESCE(jsonb_object_agg(key,
    CASE WHEN key NOT IN ('_chaining','validate_field','_fallback_message','fallback_message')
      AND jsonb_typeof(value) = 'object' THEN value - 'report_target' ELSE value END), '{}'::jsonb)
  FROM jsonb_each(a.extract_data))
WHERE jsonb_typeof(extract_data) = 'object';

UPDATE webhook_endpoints SET retry_policy =
  pg_temp.object_or_empty(retry_policy) || '{"payload_version":3}'::jsonb
WHERE events @> '["call.completed"]'::jsonb;

ALTER TABLE conversations
  DROP COLUMN track_id,
  DROP COLUMN tabulation_notes,
  DROP COLUMN tabulated_at,
  DROP COLUMN tabulated_by,
  DROP COLUMN tabulation_history;
ALTER TABLE painel_clients DROP COLUMN tabulation_inactivity_minutes;
-- No CASCADE: unknown external dependencies must fail the migration for review.
DROP TABLE painel_interactions;
DROP TABLE painel_tracks;
COMMIT;
