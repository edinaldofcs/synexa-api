-- BYO Voice: provedores de TTS/STT customizados por agente.
-- NULL = padrao da plataforma (cartesia/groq). 'custom' = usa endpoints HTTP do cliente (BYOK).
ALTER TABLE "painel_agents"
  ADD COLUMN "tts_provider" TEXT,
  ADD COLUMN "stt_provider" TEXT;