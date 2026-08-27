import net from 'net';
import { TelephonyAdapterFactory } from './telephony-adapter.factory';
import { AsteriskFastAgiAdapter } from './asterisk/asterisk-fastagi.adapter';

describe('TelephonyAdapterFactory', () => {
  it('registra os adapters padrão (asterisk, callflex, audiosocket)', () => {
    const factory = new TelephonyAdapterFactory();

    expect(factory.has('asterisk_fastagi')).toBe(true);
    expect(factory.has('callflex')).toBe(true);
    expect(factory.has('callflex_ws')).toBe(true);
    expect(factory.has('audiosocket')).toBe(true);
    expect(factory.list()).toContain('asterisk_fastagi');
  });

  it('instancia o adapter correto por nome de provedor', () => {
    const factory = new TelephonyAdapterFactory();
    const adapter = factory.create('Asterisk_FastAGI', new net.Socket(), {
      agi_channel: 'PJSIP/test',
    });
    expect(adapter).toBeInstanceOf(AsteriskFastAgiAdapter);
    expect(adapter.providerName).toBe('asterisk_fastagi');
  });

  it('lança erro explícito para provedor desconhecido', () => {
    const factory = new TelephonyAdapterFactory();
    expect(() => factory.create('discador_fantasma')).toThrow(
      /discador_fantasma/,
    );
  });

  it('permite registrar adapter novo sem tocar nos ingressos', () => {
    class FakeAdapter extends AsteriskFastAgiAdapter {}
    const factory = new TelephonyAdapterFactory();
    factory.register('nexcore', FakeAdapter);
    expect(factory.create('nexcore', new net.Socket(), {})).toBeInstanceOf(
      FakeAdapter,
    );
  });
});
