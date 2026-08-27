import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as net from 'net';
import * as readline from 'readline';

import { AsteriskFastAgiAdapter } from '../adapters/asterisk/asterisk-fastagi.adapter';
import { TelephonyEndpointResolverService } from '../services/telephony-endpoint-resolver.service';
import { VoiceSessionFactory } from '../services/voice-session.factory';
import { AsteriskAmiService } from './asterisk-ami.service';

export interface FastAgiEnv {
  agi_channel?: string;
  agi_uniqueid?: string;
  agi_callerid?: string;
  agi_calleridname?: string;
  agi_extension?: string;
  agi_arg_1?: string; // Cellphone
  agi_arg_2?: string; // Company Phone / DID
  agi_arg_3?: string; // Client ID / Persona ID / JSON variables
  [key: string]: string | undefined;
}

/**
 * Ingresso de transporte FastAGI/EAGI do Asterisk.
 *
 * Toda a lógica de IA (mapeamento de variáveis, prompt, conversa, gate,
 * provider, telemetria) vive em `VoiceCallSession` e é montada pelo
 * `VoiceSessionFactory` — este serviço apenas entrega o transporte.
 */
@Injectable()
export class FastAgiServerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FastAgiServerService.name);
  private server: net.Server | null = null;
  private port: number;
  private enabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly endpointResolver: TelephonyEndpointResolverService,
    private readonly voiceSessionFactory: VoiceSessionFactory,
    private readonly amiService: AsteriskAmiService,
  ) {
    this.port = this.configService.get<number>('FASTAGI_PORT') || 4573;
    this.enabled = this.configService.get<boolean>('FASTAGI_ENABLED') ?? false;
  }

  public onModuleInit(): void {
    if (this.enabled) {
      this.start();
    } else {
      this.logger.log(
        'ℹ️ [FastAGI] Servidor FastAGI desativado (FASTAGI_ENABLED=false)',
      );
    }
  }

  public onModuleDestroy(): void {
    this.stop();
  }

  public start(): void {
    if (this.server) return;

    this.server = net.createServer((socket) => {
      this.handleSocketConnection(socket);
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      this.logger.log(
        `📞 [FastAGI] Servidor TCP escutando em 0.0.0.0:${this.port}`,
      );
    });
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.logger.log('🛑 [FastAGI] Servidor FastAGI encerrado');
    }
  }

  private handleSocketConnection(socket: net.Socket): void {
    const agiEnv: FastAgiEnv = {};
    const rl = readline.createInterface({
      input: socket,
      output: socket,
      terminal: false,
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed === '') {
        rl.removeAllListeners('line');
        this.processAgiCall(socket, agiEnv).catch((err) => {
          this.logger.error(
            `❌ [FastAGI] Erro ao processar chamada: ${err.message}`,
          );
          socket.end();
        });
      } else {
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx !== -1) {
          const key = trimmed.substring(0, colonIdx).trim();
          const val = trimmed.substring(colonIdx + 1).trim();
          agiEnv[key] = val;
        }
      }
    });

    socket.on('error', (err) => {
      this.logger.warn(`[FastAGI] Erro no socket TCP: ${err.message}`);
    });
  }

  private async processAgiCall(
    socket: net.Socket,
    agiEnv: FastAgiEnv,
  ): Promise<void> {
    // 1. Transporte: variáveis AGI viram metadados normalizados do adapter
    const adapter = new AsteriskFastAgiAdapter(socket, agiEnv);
    this.logger.log(
      `📞 [FastAGI] Chamada recebida | canal=${adapter.metadata.channelId} | caller=${adapter.metadata.callerNumber} | did=${adapter.metadata.didNumber} | vars=${JSON.stringify(adapter.metadata.customVariables || {})}`,
    );

    const customVariables = (adapter.metadata.customVariables || {}) as Record<
      string,
      unknown
    >;

    try {
      // 2. Roteamento plug-and-play: DID/variáveis -> telephony_endpoints
      const route = await this.endpointResolver.resolve({
        didNumber: (adapter.metadata.didNumber as string) || undefined,
        providerName: adapter.providerName,
        clientIdHint: (customVariables.SYNEXA_CLIENT_ID as string) || undefined,
        agentStepHint:
          (customVariables.SYNEXA_AGENT_STEP as string) || undefined,
      });

      if (!route) {
        this.logger.warn(
          `[FastAGI] Chamada sem rota (did=${adapter.metadata.didNumber}). Cadastre um endpoint em telephony_endpoints ou envie SYNEXA_CLIENT_ID.`,
        );
        adapter.hangup('no_route');
        return;
      }

      if ((route.agent as any)?.interaction_mode === 'text') {
        this.logger.warn(
          `[FastAGI] Chamada recusada: agente ${route.agent?.id} aceita somente texto`,
        );
        adapter.hangup('agent_text_only');
        return;
      }

      // 3. Pipeline único de IA via factory
      const channelId = (adapter.metadata.channelId as string) || undefined;
      const { session } = await this.voiceSessionFactory.create(
        adapter,
        route,
        {
          onAiHangupRequest: async () => {
            if (channelId) {
              await this.amiService.hangupChannel(channelId);
            }
          },
        },
      );

      await session.start();
    } catch (err: any) {
      this.logger.error(`❌ [FastAGI] Erro ao iniciar sessão: ${err.message}`);
      adapter.hangup('internal_error');
    }
  }
}
