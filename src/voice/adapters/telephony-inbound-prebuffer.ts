/**
 * Pre-buffer de áudio inbound para adapters de telefonia.
 *
 * A sessão de IA leva ~1-2s para registrar `onAudio` (handshake Gemini +
 * montagem do prompt). Chamadas reais começam com o cliente falando na
 * hora ("alô") — sem buffer, esse áudio se perde na janela de setup.
 *
 * Uso: `push()` enquanto o callback não existe; `onAudio` chama `drain()`
 * para esvaziar em ordem antes de passar a encaminhar direto.
 */
export class TelephonyInboundPreBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  public push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const dropped = this.chunks.shift();
      if (!dropped) break;
      this.bytes -= dropped.length;
    }
  }

  public drain(callback: (chunk: Buffer) => void): void {
    while (this.chunks.length > 0) {
      const chunk = this.chunks.shift();
      if (chunk) {
        this.bytes -= chunk.length;
        callback(chunk);
      }
    }
  }
}
