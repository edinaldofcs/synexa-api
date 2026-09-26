import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as net from 'net';

type AmiFrame = Record<string, string>;
type PendingAction = {
  event?: string;
  finish: (frame: AmiFrame | null) => void;
};

@Injectable()
export class AsteriskAmiService implements OnModuleDestroy {
  private socket: net.Socket | null = null;
  private connecting: Promise<boolean> | null = null;
  private finishLogin: ((success: boolean) => void) | null = null;
  private authenticated = false;
  private stopped = false;
  private reconnectAfter = 0;
  private nextActionId = 0;
  private loginId = '';
  private buffer = '';
  private readonly pending = new Map<string, PendingAction>();
  private readonly requestTimeoutMs = 4000;
  private readonly maxPendingActions = 1024;
  private readonly maxFrameLength = 1024 * 1024;

  private readonly logger = new Logger(AsteriskAmiService.name);
  private host: string;
  private port: number;
  private user: string;
  private secret: string;

  constructor(private readonly configService: ConfigService) {
    this.host =
      this.configService.get<string>('ASTERISK_AMI_HOST') || 'dialer-asterisk';
    this.port = this.configService.get<number>('ASTERISK_AMI_PORT') || 5038;
    this.user =
      this.configService.get<string>('ASTERISK_AMI_USER') || 'synexa_voice';
    this.secret = this.configService.get<string>('ASTERISK_AMI_SECRET') || '';
  }

  public async hangupChannel(channel: string): Promise<boolean> {
    const cleanChannel = (channel || '').replace(/[\r\n]/g, '').trim();
    if (!cleanChannel) return false;

    const response = await this.request([
      'Action: Hangup',
      'Channel: ' + cleanChannel,
    ]);
    return response?.response === 'Success';
  }

  /**
   * Origina uma chamada no Asterisk (outbound/campanha), roteando para o
   * contexto do dialplan que por sua vez entrega ao ingresso da IA.
   */
  public async originate(params: {
    endpoint: string;
    context: string;
    extension: string;
    priority?: number;
    callerId?: string;
    timeoutMs?: number;
    variables?: Record<string, string>;
  }): Promise<boolean> {
    const cleanEndpoint = sanitize(params.endpoint);
    if (!cleanEndpoint || !params.context || !params.extension) return false;

    let timeoutMs = params.timeoutMs ?? 30000;
    timeoutMs = Math.max(5000, Math.min(timeoutMs, 120000));

    const actionLines = [
      'Action: Originate',
      'Async: true',
      `Channel: ${cleanEndpoint}`,
      `Context: ${sanitize(params.context)}`,
      `Exten: ${sanitize(params.extension)}`,
      `Priority: ${params.priority ?? 1}`,
      `Timeout: ${timeoutMs}`,
    ];

    if (params.callerId) {
      actionLines.push(`CallerID: ${sanitize(params.callerId)}`);
    }
    if (params.variables) {
      for (const [key, value] of Object.entries(params.variables)) {
        actionLines.push(`Variable: ${sanitize(key)}=${sanitize(value)}`);
      }
    }

    // Success means the originate was accepted, not that the callee answered.
    const response = await this.request(actionLines);
    return response?.response === 'Success';
  }

  /**
   * Consulta variáveis de canal via AMI (usada pelo ingresso AudioSocket,
   * que não recebe variáveis do dialplan como o FastAGI).
   */
  public async getChannelVariables(
    channel: string,
    variables: string[],
  ): Promise<Record<string, string | null>> {
    const cleanChannel = sanitize(channel);
    const result: Record<string, string | null> = {};
    if (!cleanChannel || !variables.length || !this.secret) return result;

    await Promise.all(
      variables.map(async (variable) => {
        result[variable] = await this.queryVariable(cleanChannel, variable);
      }),
    );
    return result;
  }

  /**
   * Resolve o contexto de uma chamada AudioSocket a partir do UUID recebido.
   *
   * O app AudioSocket do Asterisk exige um UUID canônico (rejeita o formato
   * de ${UNIQUEID}) e o protocolo não transporta o DID. O dialplan padrão do
   * Synexa grava DB(SYNEXA/<uuid>)=<uniqueid>; aqui resolvemos esse mapa via
   * ação AMI DBGet (Getvar não avalia a função DB() sem canal) e então lemos
   * as variáveis do canal real. Fallback: trata o próprio uuid como
   * canal/uniqueid (compatibilidade com dialplans antigos).
   */
  public async resolveAudioSocketContext(
    uuid: string,
    variables: string[],
  ): Promise<{ channel: string | null; vars: Record<string, string | null> }> {
    const cleanUuid = sanitize(uuid);
    if (!cleanUuid || !variables.length || !this.secret) {
      return { channel: null, vars: {} };
    }

    const mapped = await this.queryDbEntry('SYNEXA', cleanUuid);
    if (mapped) {
      return {
        channel: mapped,
        vars: await this.getChannelVariables(mapped, variables),
      };
    }
    return {
      channel: cleanUuid,
      vars: await this.getChannelVariables(cleanUuid, variables),
    };
  }

  private async queryVariable(
    channel: string,
    variable: string,
  ): Promise<string | null> {
    const response = await this.request([
      'Action: Getvar',
      'Channel: ' + sanitize(channel),
      'Variable: ' + sanitize(variable),
    ]);
    const value = response?.value;
    return value && value !== '<unset>' ? value : null;
  }

  private async queryDbEntry(
    family: string,
    key: string,
  ): Promise<string | null> {
    const response = await this.request(
      ['Action: DBGet', 'Family: ' + sanitize(family), 'Key: ' + sanitize(key)],
      'DBGetResponse',
    );
    return response?.val || null;
  }

  /**
   * Multiplex actions over one authenticated socket. Never replay a command:
   * after a disconnect its outcome may be unknown (especially Originate).
   */
  private async request(
    lines: string[],
    event?: string,
  ): Promise<AmiFrame | null> {
    if (!(await this.ensureConnected())) return null;
    const client = this.socket;
    if (!client || client.destroyed || !this.authenticated) return null;
    if (this.pending.size >= this.maxPendingActions) {
      this.logger.warn({ event: 'ami_pending_limit' });
      return null;
    }
    const actionId = String(++this.nextActionId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Reset an unresponsive connection and release all waiters.
        this.disconnect(client, 'request_timeout');
      }, this.requestTimeoutMs);
      this.pending.set(actionId, {
        event,
        finish: (frame) => {
          clearTimeout(timer);
          this.pending.delete(actionId);
          resolve(frame);
        },
      });
      try {
        client.write(
          lines.join('\r\n') + '\r\nActionID: ' + actionId + '\r\n\r\n',
        );
      } catch {
        this.disconnect(client, 'write_failed');
      }
    });
  }

  private ensureConnected(): Promise<boolean> {
    if (this.stopped || !this.secret) return Promise.resolve(false);
    if (this.authenticated && this.socket && !this.socket.destroyed) {
      return Promise.resolve(true);
    }
    if (this.connecting) return this.connecting;
    // One retry per second at most, on demand; no retry storm during outages.
    if (Date.now() < this.reconnectAfter) return Promise.resolve(false);

    let resolveLogin!: (success: boolean) => void;
    const connection = new Promise<boolean>((resolve) => {
      resolveLogin = resolve;
    });
    this.connecting = connection;
    let client: net.Socket;
    try {
      client = net.createConnection({ host: this.host, port: this.port });
    } catch {
      this.connecting = null;
      this.reconnectAfter = Date.now() + 1000;
      this.logger.warn({ event: 'ami_disconnected', reason: 'connect_failed' });
      resolveLogin(false);
      return connection;
    }
    this.socket = client;
    this.buffer = '';
    this.loginId = String(++this.nextActionId);
    const timer = setTimeout(
      () => this.disconnect(client, 'login_timeout'),
      4000,
    );
    this.finishLogin = (success) => {
      clearTimeout(timer);
      this.finishLogin = null;
      this.connecting = null;
      this.authenticated = success;
      resolveLogin(success);
    };
    client.setEncoding('utf8');
    client.setNoDelay(true);
    client.setKeepAlive(true, 30000);
    client.on('connect', () => {
      if (client !== this.socket) return;
      // DBGetResponse is a direct action response even with events disabled.
      client.write(
        [
          'Action: Login',
          'ActionID: ' + this.loginId,
          'Username: ' + sanitize(this.user),
          'Secret: ' + sanitize(this.secret),
          'Events: off',
          '',
          '',
        ].join('\r\n'),
      );
    });
    client.on('data', (chunk: string) => this.receive(client, chunk));
    client.on('error', () => this.disconnect(client, 'socket_error'));
    client.on('end', () => this.disconnect(client, 'socket_end'));
    client.on('close', () => this.disconnect(client, 'socket_closed'));
    return connection;
  }

  /** TCP can split headers or combine multiple responses in a single chunk. */
  private receive(client: net.Socket, chunk: string): void {
    if (client !== this.socket) return;
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf('\r\n\r\n')) !== -1) {
      if (end > this.maxFrameLength) {
        this.disconnect(client, 'frame_too_large');
        return;
      }
      const frame: AmiFrame = {};
      for (const line of this.buffer.slice(0, end).split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon > 0) {
          frame[line.slice(0, colon).toLowerCase()] = line
            .slice(colon + 1)
            .trim();
        }
      }
      this.buffer = this.buffer.slice(end + 4);
      if (!this.authenticated) {
        if (frame.actionid !== this.loginId) continue;
        if (frame.response !== 'Success') {
          this.disconnect(client, 'authentication_failed');
          return;
        }
        this.finishLogin?.(true);
        this.logger.log({ event: 'ami_connected' });
        continue;
      }
      const action = this.pending.get(frame.actionid);
      if (!action) continue;
      if (frame.response === 'Error') {
        action.finish(null);
      } else if (action.event) {
        // DBGet first acknowledges the request; its value arrives separately.
        if (frame.event === action.event) action.finish(frame);
      } else if (frame.response && !frame.event) {
        action.finish(frame);
      }
    }
    if (this.buffer.length > this.maxFrameLength) {
      this.disconnect(client, 'frame_too_large');
    }
  }

  private disconnect(client: net.Socket, reason: string): void {
    if (client !== this.socket) return;
    this.socket = null;
    this.authenticated = false;
    this.buffer = '';
    this.reconnectAfter = Date.now() + 1000;
    this.finishLogin?.(false);
    for (const action of this.pending.values()) action.finish(null);
    client.destroy();
    if (!this.stopped) this.logger.warn({ event: 'ami_disconnected', reason });
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.socket) this.disconnect(this.socket, 'shutdown');
  }
}

function sanitize(value: string): string {
  return (value || '').replace(/[\r\n]/g, '').trim();
}
