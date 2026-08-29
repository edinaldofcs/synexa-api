import { Injectable, Logger } from '@nestjs/common';
import { ITelephonyAdapter } from './telephony-adapter.interface';
import { AsteriskFastAgiAdapter } from './asterisk/asterisk-fastagi.adapter';
import { CallFlexAdapter } from './callflex/callflex.adapter';
import { AudioSocketAdapter } from './audiosocket/audiosocket.adapter';
import { TwilioMediaStreamsAdapter } from './twilio/twilio-media-streams.adapter';
import { VonageVoiceAdapter } from './vonage/vonage-voice.adapter';

export type TelephonyAdapterConstructor = new (
  ...args: any[]
) => ITelephonyAdapter;

/**
 * Registro central de adapters de telefonia.
 *
 * Plug-and-play: cada provedor novo de discador/transporte implementa
 * `ITelephonyAdapter` e se registra aqui — nenhum ingresso precisa ser
 * alterado para utilizá-lo.
 */
@Injectable()
export class TelephonyAdapterFactory {
  private readonly logger = new Logger(TelephonyAdapterFactory.name);
  private readonly registry = new Map<string, TelephonyAdapterConstructor>();

  constructor() {
    this.registerDefaults();
  }

  public register(
    providerName: string,
    ctor: TelephonyAdapterConstructor,
  ): void {
    this.registry.set(providerName.toLowerCase(), ctor);
    this.logger.log(`🔌 [AdapterFactory] Adapter registrado: ${providerName}`);
  }

  public has(providerName: string): boolean {
    return this.registry.has(providerName.toLowerCase());
  }

  public list(): string[] {
    return [...this.registry.keys()];
  }

  public create(providerName: string, ...args: any[]): ITelephonyAdapter {
    const ctor = this.registry.get(providerName.toLowerCase());
    if (!ctor) {
      throw new Error(
        `[AdapterFactory] Provedor de telefonia desconhecido: '${providerName}'. Disponíveis: ${this.list().join(', ')}`,
      );
    }
    return new ctor(...args);
  }

  private registerDefaults(): void {
    this.register('asterisk_fastagi', AsteriskFastAgiAdapter);
    this.register('callflex', CallFlexAdapter);
    this.register('callflex_ws', CallFlexAdapter);
    this.register('audiosocket', AudioSocketAdapter);
    this.register('twilio_media_streams', TwilioMediaStreamsAdapter);
    this.register('twilio', TwilioMediaStreamsAdapter);
    this.register('vonage_voice', VonageVoiceAdapter);
    this.register('vonage', VonageVoiceAdapter);
  }
}
