export function resolveVoiceFlowSettings(raw: unknown) {
  const value =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const text = (key: string, fallback: string, max = 100) =>
    typeof value[key] === 'string' && value[key].trim()
      ? value[key].trim().slice(0, max)
      : fallback;
  return {
    inworldVoice: text('inworldVoice', 'Mariana'),
    cartesiaVoice: text('cartesiaVoice', ''),
    cartesiaModel: ['sonic-3.6', 'sonic-3', 'sonic-2'].includes(
      String(value.cartesiaModel),
    )
      ? String(value.cartesiaModel)
      : 'sonic-3.6',
    groqModel:
      value.groqModel === 'whisper-large-v3'
        ? 'whisper-large-v3'
        : 'whisper-large-v3-turbo',
    language: ['pt', 'en', 'es', 'fr', 'de', 'it'].includes(
      String(value.language),
    )
      ? String(value.language)
      : 'pt',
    sttPrompt: text('sttPrompt', '', 500),
    customTtsVoice: text('customTtsVoice', ''),
  };
}
