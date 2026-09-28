BEGIN;
-- These counters have always received aggregate provider usage, not audio-only tokens.
ALTER TABLE voice_session_telemetry RENAME COLUMN audio_input_tokens TO input_tokens;
ALTER TABLE voice_session_telemetry RENAME COLUMN audio_output_tokens TO output_tokens;
ALTER TABLE voice_session_telemetry ADD COLUMN exchange_rate numeric(18,8);
ALTER TABLE voice_session_telemetry ALTER COLUMN turns DROP NOT NULL, ALTER COLUMN turns DROP DEFAULT,
  ALTER COLUMN text_input_tokens DROP NOT NULL, ALTER COLUMN text_input_tokens DROP DEFAULT,
  ALTER COLUMN text_output_tokens DROP NOT NULL, ALTER COLUMN text_output_tokens DROP DEFAULT,
  ALTER COLUMN thoughts_tokens DROP NOT NULL, ALTER COLUMN thoughts_tokens DROP DEFAULT;
-- Zero was an unimplemented default. Preserve any real measurement from another environment.
UPDATE voice_session_telemetry SET turns=NULL WHERE turns=0;
UPDATE voice_session_telemetry SET text_input_tokens=NULL WHERE text_input_tokens=0;
UPDATE voice_session_telemetry SET text_output_tokens=NULL WHERE text_output_tokens=0;
UPDATE voice_session_telemetry SET thoughts_tokens=NULL WHERE thoughts_tokens=0;

-- Resolve explicit legacy chain references within the client; ambiguous references abort.
DO $$ DECLARE a record; target uuid; matches integer; BEGIN
  FOR a IN SELECT * FROM painel_apis WHERE nullif(btrim(next_tool),'') IS NOT NULL AND nullif(config->>'next_api_id','') IS NULL LOOP
    SELECT count(*),(array_agg(id))[1] INTO matches,target FROM painel_apis
      WHERE client_id=a.client_id AND (id::text=a.next_tool OR name=a.next_tool);
    IF matches<>1 THEN RAISE EXCEPTION 'Ambiguous or missing next_tool for API %; configure next_api_id explicitly',a.id; END IF;
    UPDATE painel_apis SET config=coalesce(config,'{}') || jsonb_build_object('next_api_id',target::text) WHERE id=a.id;
  END LOOP;
END $$;
ALTER TABLE painel_apis DROP COLUMN next_tool;
COMMIT;
