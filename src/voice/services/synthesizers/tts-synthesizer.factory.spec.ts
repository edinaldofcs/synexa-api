import { TtsSynthesizerFactory } from './tts-synthesizer.factory';
import { CartesiaTtsSynthesizer } from './cartesia-tts.synthesizer';
import { GoogleTtsSynthesizer } from './google-tts.synthesizer';
import { ITtsSynthesizer } from './tts-synthesizer.interface';

describe('TtsSynthesizerFactory', () => {
  let factory: TtsSynthesizerFactory;
  let mockCartesia: jest.Mocked<CartesiaTtsSynthesizer>;
  let mockGoogle: jest.Mocked<GoogleTtsSynthesizer>;

  beforeEach(() => {
    mockCartesia = {
      providerName: 'cartesia',
      synthesize: jest.fn().mockResolvedValue(Buffer.from('cartesia-audio')),
    } as any;

    mockGoogle = {
      providerName: 'google',
      synthesize: jest.fn().mockResolvedValue(Buffer.from('google-audio')),
    } as any;

    factory = new TtsSynthesizerFactory(mockCartesia, mockGoogle);
  });

  it('deve resolver o sintetizador do Cartesia com sucesso', () => {
    const synth = factory.get('cartesia');
    expect(synth).toBe(mockCartesia);
    expect(synth.providerName).toBe('cartesia');
  });

  it('deve resolver o sintetizador do Google com sucesso', () => {
    const synth = factory.get('google');
    expect(synth).toBe(mockGoogle);
    expect(synth.providerName).toBe('google');
  });

  it('deve ser case-insensitive e tolerar espaços', () => {
    expect(factory.get('  Cartesia  ')).toBe(mockCartesia);
    expect(factory.get('GOOGLE')).toBe(mockGoogle);
  });

  it('deve usar fallback para cartesia quando o provedor for desconhecido', () => {
    const fallback = factory.get('provedor_inexistente');
    expect(fallback).toBe(mockCartesia);
  });

  it('deve permitir registrar novos provedores dinamicamente (ex: elevenlabs)', () => {
    const mockEleven: ITtsSynthesizer = {
      providerName: 'elevenlabs',
      synthesize: jest.fn().mockResolvedValue(Buffer.from('eleven-audio')),
    };

    expect(factory.has('elevenlabs')).toBe(false);
    factory.register(mockEleven);
    expect(factory.has('elevenlabs')).toBe(true);
    expect(factory.get('elevenlabs')).toBe(mockEleven);
  });
});
