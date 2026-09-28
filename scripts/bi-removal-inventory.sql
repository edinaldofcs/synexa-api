-- Read-only inventory. Never prints variable values, endpoint secrets or personal data.
SELECT current_database(), now();
SELECT status, origin_channel, count(*) FROM conversations GROUP BY status, origin_channel;
SELECT status, count(*) FROM call_exports GROUP BY status;
SELECT id, client_id, enabled, retry_policy -> 'payload_version' AS payload_version
FROM webhook_endpoints WHERE events @> '["call.completed"]'::jsonb;
SELECT count(*) AS interactions,
 count(*) FILTER (WHERE c.id IS NULL) AS orphans,
 count(*) FILTER (WHERE c.id IS NOT NULL AND cs.id IS NULL) AS missing_state
FROM painel_interactions i LEFT JOIN conversations c
 ON i.session_id=c.id::text AND i.company_id=c.company_id AND i.client_id=c.client_id
LEFT JOIN conversation_state cs ON cs.conversation_id=c.id;
SELECT id AS client_id, key AS affected_configuration FROM painel_clients,
 LATERAL jsonb_object_keys(metadata) key
WHERE key IN ('analytics_config','session_output_config','report_bindings','report_values');
SELECT dependent_ns.nspname, dependent.relname, source.relname AS source
FROM pg_depend d JOIN pg_class source ON source.oid=d.refobjid
JOIN pg_rewrite r ON r.oid=d.objid JOIN pg_class dependent ON dependent.oid=r.ev_class
JOIN pg_namespace dependent_ns ON dependent_ns.oid=dependent.relnamespace
WHERE source.relname IN ('painel_interactions','painel_tracks');
SELECT count(*) AS agent_runs, sum(cost) AS cost, sum(input_tokens) AS input_tokens,
 sum(output_tokens) AS output_tokens FROM agent_runs;
SELECT count(*) AS telemetry, sum(cost_usd) AS cost_usd, sum(total_tokens) AS total_tokens,
 sum(duration_sec) AS duration_sec FROM voice_session_telemetry;

SELECT event, status, count(*) FROM webhook_deliveries WHERE event='call.completed' GROUP BY event,status;
SELECT a.id AS api_id, a.client_id, d.key AS extraction_field
FROM painel_apis a CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(a.extract_data)='object' THEN a.extract_data ELSE '{}'::jsonb END) d
WHERE jsonb_typeof(d.value)='object' AND d.value ? 'report_target';
SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prosrc ~* 'painel_interactions|painel_tracks|tabulation|session_record';
