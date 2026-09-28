-- Use ONLY in a disposable copy before the migration, in the same psql session as after.sql.
CREATE TEMP TABLE expected_usage AS
 SELECT 'agent_runs' AS kind, count(*) AS n, md5(string_agg(t::text,'|' ORDER BY id)) AS fingerprint FROM agent_runs t
 UNION ALL SELECT 'telemetry', count(*), md5(string_agg(t::text,'|' ORDER BY id)) FROM voice_session_telemetry t;
CREATE TEMP TABLE expected_state AS SELECT conversation_id, state FROM conversation_state;
CREATE TEMP TABLE expected_conversations AS SELECT id FROM conversations;

INSERT INTO companies(id,name) VALUES
 ('bb000000-0000-4000-8000-000000000001','Migration test A'),
 ('bb000000-0000-4000-8000-000000000002','Migration test B');
INSERT INTO painel_clients(id,company_id,metadata) VALUES
 ('bb000000-0000-4000-8000-000000000011','bb000000-0000-4000-8000-000000000001',
 '{"analytics_config":{},"session_output_config":{},"inbound_variable_mapping":{"rules":[{"source_field":"data","target_variable":"Nome","report_target":"contact_name"}]},"custom":{"report_target":"preserve","analytics_config":"preserve"}}'),
 ('bb000000-0000-4000-8000-000000000012','bb000000-0000-4000-8000-000000000002','{}');
INSERT INTO conversations(id,company_id,client_id,status,origin_channel,metadata) VALUES
 ('bb000000-0000-4000-8000-000000000021','bb000000-0000-4000-8000-000000000001','bb000000-0000-4000-8000-000000000011','closed','voice',
 '{"session_record":{"acordo":true,"dados_variaveis":{"SomenteNoRegistro":"001"}},"session_data":{"variables":{"SomenteNoEnvelope":false}},"ai_summary":"remove","sentiment":"remove"}'),
 ('bb000000-0000-4000-8000-000000000022','bb000000-0000-4000-8000-000000000002','bb000000-0000-4000-8000-000000000012','closed','webchat','{}');
INSERT INTO conversation_state(conversation_id,state) VALUES
 ('bb000000-0000-4000-8000-000000000021','{"CPF":"00123","atual":false,"nulo":null,"zero":0}');
INSERT INTO painel_interactions(company_id,client_id,session_id,context_variables,is_right_party,is_agreement_reached) VALUES
 ('bb000000-0000-4000-8000-000000000001','bb000000-0000-4000-8000-000000000011','bb000000-0000-4000-8000-000000000021',
 '{"CPF":"999","atual":true,"nulo":"old","zero":77,"somenteAntigo":[false,0,null],"Dados":{"report_target":"preserve"}}',true,true),
 ('bb000000-0000-4000-8000-000000000001','bb000000-0000-4000-8000-000000000011','bb000000-0000-4000-8000-000000000022','{"crossTenant":"must not copy"}',false,false),
 ('bb000000-0000-4000-8000-000000000001','bb000000-0000-4000-8000-000000000011','bb000000-0000-4000-8000-000000000023','{"orphan":"must not recreate"}',false,false);
INSERT INTO painel_apis(id,client_id,name,url,extract_data) VALUES
 ('bb000000-0000-4000-8000-000000000031','bb000000-0000-4000-8000-000000000011','migration_test','https://example.com',
 '{"Nome":{"path":"data.nome","report_target":"contact_name"},"Fixo":{"value":{"report_target":"preserve","analytics_config":"preserve"},"report_target":"agreement_id"}}');
