export const llmConfig = {
  provider: process.env.LLM_PROVIDER || 'gemini',
  models: {
    gemini: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    groq: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    openrouter: process.env.OPENROUTER_MODEL || 'openai/gpt-5.4-nano:nitro',
  },
  visionModels: {
    groq: 'gemini-2.5-flash-lite',
    gemini: 'gemini-2.5-flash-lite',
    openrouter: 'google/gemini-2.5-flash',
  },
  mediaVisionProvider: process.env.MEDIA_VISION_PROVIDER || 'gemini',
};
