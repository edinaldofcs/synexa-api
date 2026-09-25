import { resolveVoiceFlowSettings } from './voice-flow-settings';
import { GroqWhisperSttService } from './groq-whisper-stt.service';
describe('Flow provider settings', () => {
  it('preserves supported settings and rejects unsupported model/language values', () => {
    expect(
      resolveVoiceFlowSettings({
        cartesiaModel: 'sonic-3',
        groqModel: 'whisper-large-v3',
        language: 'es',
        sttPrompt: ' Nome ',
      }),
    ).toMatchObject({
      cartesiaModel: 'sonic-3',
      groqModel: 'whisper-large-v3',
      language: 'es',
      sttPrompt: 'Nome',
    });
    expect(
      resolveVoiceFlowSettings({ cartesiaModel: 'unknown', language: {} }),
    ).toMatchObject({ cartesiaModel: 'sonic-3.6', language: 'pt' });
  });
  it('forwards the selected STT model, language and vocabulary to Groq', async () => {
    const original = global.fetch;
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ text: 'hola' }) });
    try {
      await new GroqWhisperSttService().transcribePcm(Buffer.alloc(100), {
        apiKey: 'test',
        model: 'whisper-large-v3',
        language: 'es',
        prompt: 'Synexa',
      });
      const form = (global.fetch as jest.Mock).mock.calls[0][1]
        .body as FormData;
      expect(form.get('model')).toBe('whisper-large-v3');
      expect(form.get('language')).toBe('es');
      expect(form.get('prompt')).toBe('Synexa');
    } finally {
      global.fetch = original;
    }
  });
});
