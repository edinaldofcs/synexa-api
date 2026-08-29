import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as net from 'net';

@Injectable()
export class AsteriskAmiService {
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

    return this.withSession(async (client) => {
      client.write(`Action: Hangup\r\nChannel: ${cleanChannel}\r\n\r\n`);
    });
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
      `Channel: ${cleanEndpoint}`,
      `Context: ${sanitize(params.context)}`,
      `Extension: ${sanitize(params.extension)}`,
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

    return this.withSession((client) => {
      client.write(`${actionLines.join('\r\n')}\r\n\r\n`);
    });
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

    for (const rawVariable of variables) {
      result[rawVariable] = await this.queryVariable(cleanChannel, rawVariable);
    }
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

  /**
   * Abre uma conexão AMI efêmera, autentica e lê uma única variável.
   * Com `channel = null`, lê variáveis globais/funções (ex.: DB(família/chave)).
   */
  private queryVariable(
    channel: string | null,
    variable: string,
  ): Promise<string | null> {
    return new Promise<string | null>((resolveValue) => {
      const client = net.createConnection({
        host: this.host,
        port: this.port,
      });
      let authenticated = false;
      let done = false;
      let buffer = '';
      const finish = (val: string | null) => {
        if (done) return;
        done = true;
        try {
          if (authenticated) {
            client.write('Action: Logoff\r\n\r\n');
          }
          client.destroy();
        } catch {
          /* noop */
        }
        resolveValue(val);
      };

      client.setTimeout(4000);
      client.on('connect', () => {
        client.write(this.loginPayload());
      });
      client.on('data', (data) => {
        const response = data.toString();
        if (!authenticated && response.includes('Authentication accepted')) {
          authenticated = true;
          const getvar =
            channel && channel.length > 0
              ? `Action: Getvar\r\nChannel: ${sanitize(channel)}\r\nVariable: ${sanitize(variable)}\r\n\r\n`
              : `Action: Getvar\r\nVariable: ${sanitize(variable)}\r\n\r\n`;
          client.write(getvar);
          return;
        }
        if (!authenticated) return;
        // Eventos AMI (SuccessfulAuth, FullyBooted...) podem chegar antes da
        // resposta: acumula até encontrar a linha Value: ou um erro.
        buffer += response;
        if (/^Response: Error/m.test(buffer)) {
          finish(null);
          return;
        }
        const match = buffer.match(/^Value:\s*(.*)$/m);
        if (match) {
          const value = match[1].trim();
          finish(value === '' || value === '<unset>' ? null : value);
        }
      });
      client.on('timeout', () => finish(null));
      client.on('error', () => finish(null));
    });
  }

  /**
   * Lê uma entrada do AsteriskDB via ação AMI DBGet (a resposta chega como
   * evento DBGetResponse com header `Val:`).
   */
  private queryDbEntry(family: string, key: string): Promise<string | null> {
    return new Promise<string | null>((resolveValue) => {
      const client = net.createConnection({
        host: this.host,
        port: this.port,
      });
      let authenticated = false;
      let done = false;
      let buffer = '';
      const finish = (val: string | null) => {
        if (done) return;
        done = true;
        try {
          if (authenticated) {
            client.write('Action: Logoff\r\n\r\n');
          }
          client.destroy();
        } catch {
          /* noop */
        }
        resolveValue(val);
      };

      client.setTimeout(4000);
      client.on('connect', () => {
        client.write(this.loginPayload());
      });
      client.on('data', (data) => {
        const response = data.toString();
        if (!authenticated && response.includes('Authentication accepted')) {
          authenticated = true;
          client.write(
            `Action: DBGet\r\nFamily: ${sanitize(family)}\r\nKey: ${sanitize(key)}\r\n\r\n`,
          );
          return;
        }
        if (!authenticated) return;
        buffer += response;
        if (/^Response: Error/m.test(buffer)) {
          finish(null);
          return;
        }
        const match = buffer.match(/^Val:\s*(.*)$/m);
        if (match) {
          const value = match[1].trim();
          finish(value === '' ? null : value);
        }
      });
      client.on('timeout', () => finish(null));
      client.on('error', () => finish(null));
    });
  }

  private loginPayload(): string {
    return `Action: Login\r\nUsername: ${this.user}\r\nSecret: ${this.secret}\r\n\r\n`;
  }

  /**
   * Abre uma conexão AMI efêmera autenticada e executa o comando desejado.
   * Resolve após escrever o comando (fire-and-forget na resposta).
   */
  private withSession(execute: (client: net.Socket) => void): Promise<boolean> {
    if (!this.secret) {
      this.logger.warn('[AsteriskAmi] ASTERISK_AMI_SECRET não configurado');
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const client = net.createConnection({
        host: this.host,
        port: this.port,
      });
      let authenticated = false;

      client.setTimeout(5000);

      client.on('connect', () => {
        client.write(this.loginPayload());
      });

      client.on('data', (data) => {
        const response = data.toString();
        if (
          !authenticated &&
          response.includes('Response: Success') &&
          response.includes('Authentication accepted')
        ) {
          authenticated = true;
          execute(client);
          client.write('Action: Logoff\r\n\r\n');
          resolve(true);
        }
      });

      client.on('timeout', () => {
        this.logger.warn('[AsteriskAmi] Timeout na conexão AMI');
        client.destroy();
        resolve(false);
      });

      client.on('error', (err) => {
        this.logger.warn(`[AsteriskAmi] Erro na conexão AMI: ${err.message}`);
        resolve(false);
      });
    });
  }
}

function sanitize(value: string): string {
  return (value || '').replace(/[\r\n]/g, '').trim();
}
