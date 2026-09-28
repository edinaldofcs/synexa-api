DO $$ DECLARE data jsonb; actual_usage record; expected record; BEGIN
  SELECT state INTO data FROM conversation_state WHERE conversation_id='bb000000-0000-4000-8000-000000000021';
  IF data <> '{"CPF":"00123","atual":false,"nulo":null,"zero":0,"somenteAntigo":[false,0,null],"Dados":{"report_target":"preserve"},"SomenteNoRegistro":"001","SomenteNoEnvelope":false}'::jsonb THEN
    RAISE EXCEPTION 'Variable recovery, collision or inferred metric regression';
  END IF;
  IF EXISTS(SELECT 1 FROM conversation_state WHERE conversation_id='bb000000-0000-4000-8000-000000000022') THEN
    RAISE EXCEPTION 'Cross-tenant recovery';
  END IF;
  IF EXISTS(SELECT 1 FROM conversations WHERE id='bb000000-0000-4000-8000-000000000023') THEN
    RAISE EXCEPTION 'Orphan recreated';
  END IF;
  IF EXISTS(SELECT 1 FROM expected_state e JOIN conversation_state cs USING(conversation_id),
    LATERAL jsonb_each(e.state) v WHERE cs.state->v.key IS DISTINCT FROM v.value) THEN
    RAISE EXCEPTION 'Existing state changed';
  END IF;
  IF EXISTS(SELECT id FROM expected_conversations EXCEPT SELECT id FROM conversations) THEN
    RAISE EXCEPTION 'Existing conversation lost';
  END IF;
  SELECT metadata INTO data FROM painel_clients WHERE id='bb000000-0000-4000-8000-000000000011';
  IF data ? 'analytics_config' OR data ? 'session_output_config'
    OR data #> '{inbound_variable_mapping,rules,0,report_target}' IS NOT NULL
    OR data #>> '{custom,report_target}' <> 'preserve' THEN
    RAISE EXCEPTION 'Configuration cleanup modified customer data or retained BI';
  END IF;
  SELECT extract_data INTO data FROM painel_apis WHERE id='bb000000-0000-4000-8000-000000000031';
  IF data #> '{Nome,report_target}' IS NOT NULL OR data #> '{Fixo,report_target}' IS NOT NULL
    OR data #>> '{Fixo,value,report_target}' <> 'preserve' THEN
    RAISE EXCEPTION 'Extraction cleanup traversed a business value';
  END IF;
  FOR actual_usage IN
    SELECT 'agent_runs' AS kind, count(*) AS n, md5(string_agg(t::text,'|' ORDER BY id)) AS fingerprint FROM agent_runs t
    UNION ALL SELECT 'telemetry',count(*),md5(string_agg(t::text,'|' ORDER BY id)) FROM voice_session_telemetry t
  LOOP
    SELECT * INTO expected FROM expected_usage WHERE kind=actual_usage.kind;
    IF actual_usage.n <> expected.n OR actual_usage.fingerprint IS DISTINCT FROM expected.fingerprint THEN
      RAISE EXCEPTION 'Billing data changed';
    END IF;
  END LOOP;
  IF to_regclass('public.painel_interactions') IS NOT NULL OR to_regclass('public.painel_tracks') IS NOT NULL THEN
    RAISE EXCEPTION 'Legacy tables remain';
  END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND column_name IN ('tabulation_history','tabulation_notes','tabulated_at','tabulated_by','tabulation_inactivity_minutes','track_id')) THEN
    RAISE EXCEPTION 'Legacy columns remain';
  END IF;
END $$;
SELECT 'BI migration regression checks passed' AS result;
