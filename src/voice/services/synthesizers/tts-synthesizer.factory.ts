import { Injectable, Logger } from '@nestjs/common';
import { ITtsSynthesizer } from './tts-synthesizer.interface';
import { CartesiaTtsSynthesizer } from './cartesia-tts.synthesizer';
import { GoogleTtsSynthesizer } from './google-tts.synthesizer';
import { CustomTtsSynthesizer } from './custom-tts.synthesizer';

@Injectable()
export class TtsSynthesizerFactory {
  private readonly logger = new Logger(TtsSynthesizerFactory.name);
  private readonly synthesizers = new Map<string, ITtsSynthesizer>();

  constructor(
    private readonly cartesiaSynthesizer: CartesiaTtsSynthesizer,
    private readonly googleSynthesizer: GoogleTtsSynthesizer,
    private readonly customSynthesizer: CustomTtsSynthesizer,
  ) {
    this.register(this.cartesiaSynthesizer);
    this.register(this.googleSynthesizer);
    this.register(this.customSynthesizer);
  }

  /**
   * Registra um sintetizador na factory.
   */
  public register(synthesizer: ITtsSynthesizer): void {
    const key = synthesizer.providerName.toLowerCase().trim();
    this.synthesizers.set(key, synthesizer);
    this.logger.debug(`🎙️ [TtsSynthesizerFactory] Provedor registrado: ${key}`);
  }

  /**
   * Obtém a instância do sintetizador para o provedor solicitado.
   */
  public get(provider: string): ITtsSynthesizer {
    const key = (provider || 'cartesia').toLowerCase().trim();
    const synth = this.synthesizers.get(key);
    if (!synth) {
      this.logger.warn(
        `⚠️ Provedor TTS '${provider}' não encontrado na factory. Usando fallback 'cartesia'.`,
      );
      const fallback = this.synthesizers.get('cartesia');
      if (!fallback) {
        throw new Error(
          `Nenhum sintetizador TTS disponível para o provedor '${provider}'`,
        );
      }
      return fallback;
    }
    return synth;
  }

  /**
   * Verifica se o provedor está registrado.
   */
  public has(provider: string): boolean {
    return this.synthesizers.has((provider || '').toLowerCase().trim());
  }
}
