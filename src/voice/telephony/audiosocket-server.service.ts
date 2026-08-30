import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as net from 'net';
import { AudioSocketAdapter } from '../adapters/audiosocket/audiosocket.adapter';
import { TelephonyEndpointResolverService } from '../services/telephony-endpoint-resolver.service';
import { VoiceSessionFactory } from '../services/voice-session.factory';
import { AsteriskAmiService } from './asterisk-ami.service';

/**
 * Ingresso de transporte AudioSocket do Asterisk.
 *
 * Dialplan recomendado (deploy/asterisk/conf/extensions.conf):
 *   same => n,Set(DB(SYNEXA/${SYNEXA_UUID})=${UNIQUEID})
 *   same => n,AudioSocket(${SYNEXA_UUID},voice:8090)
 *
 * O protocolo só entrega o UUID e o app do Asterisk exige UUID canônico;
 * o DID/cliente é resolvido via AMI (DB(SYNEXA/<uuid>) → canal → Getvar
 * SYNEXA_CLIENT_ID / SYNEXA_AGENT_STEP / SYNEXA_DID) e roteado por
 * telephony_endpoints.
 */
@Injectable()
export class AudioSocketServerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AudioSocketServerService.name);
  private server: net.Server | null = null;
  private port: number;
  private enabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly endpointResolver: TelephonyEndpointResolverService,
    private readonly voiceSessionFactory: VoiceSessionFactory,
    private readonly amiService: AsteriskAmiService,
  ) {
    this.port = this.configService.get<number>('AUDIOSOCKET_PORT') || 8090;
    this.enabled =
      this.configService.get<boolean>('AUDIOSOCKET_ENABLED') ?? false;
  }

  public onModuleInit(): void {
    if (this.enabled) {
      this.start();
    }
  }

  public onModuleDestroy(): void {
    this.stop();
  }

  public start(): void {
    if (this.server) return;

    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      this.logger.log(
        `📞 [AudioSocket] Servidor TCP escutando em 0.0.0.0:${this.port}`,
      );
    });
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.logger.log('🛑 [AudioSocket] Servidor encerrado');
    }
  }

  private async handleConnection(socket: net.Socket): Promise<void> {
    const adapter = new AudioSocketAdapter(socket);

    const channelId = await this.waitForChannelId(adapter);
    if (!channelId || !socket.writable) {
      socket.destroy();
      return;
    }

    try {
      // Roteamento: UUID → AsteriskDB → canal real → telephony_endpoints
      const { channel: asteriskChannel, vars: channelVars } =
        await this.amiService.resolveAudioSocketContext(channelId, [
          'SYNEXA_CLIENT_ID',
          'SYNEXA_AGENT_STEP',
          'SYNEXA_DID',
          'CDR(dnid)',
          'EXTEN',
          'CALLERID(name)',
          'CALLERID(num)',
          'SYNEXA_VARS_JSON',
          'SYNEXA_CLIENTE_NOME',
          'SYNEXA_CPF',
        ]);

      if (channelVars['CALLERID(num)']) {
        adapter.metadata.callerNumber = channelVars['CALLERID(num)'];
      }
      if (channelVars['CALLERID(name)']) {
        adapter.metadata.callerName = channelVars['CALLERID(name)'];
      }

      // Suporte a discagem com parâmetros (ex: discar "2000*12345678900")
      let rawDid =
        channelVars['SYNEXA_DID'] ||
        channelVars['CDR(dnid)'] ||
        channelVars['EXTEN'] ||
        '';
      let dialParam: string | undefined;
      if (rawDid.includes('*')) {
        const parts = rawDid.split('*');
        rawDid = parts[0];
        dialParam = parts.slice(1).join('*');
      }
      const didNumber = rawDid || undefined;

      // Popula variáveis de contexto recebidas na chamada telefônica
      const customVars: Record<string, any> = {
        ...(adapter.metadata.customVariables || {}),
      };

      const callerName = channelVars['CALLERID(name)'];
      if (callerName && callerName.toLowerCase() !== 'microsip') {
        customVars.caller_name = callerName;
        customVars.nome_contato = callerName;
        customVars.cliente_nome = callerName;
      }
      if (channelVars['CALLERID(num)']) {
        customVars.caller_number = channelVars['CALLERID(num)'];
      }
      if (dialParam) {
        customVars.param = dialParam;
        customVars.cpf = dialParam;
        customVars.documento = dialParam;
        customVars.codigo = dialParam;
      }
      if (channelVars['SYNEXA_CLIENTE_NOME']) {
        customVars.nome_contato = channelVars['SYNEXA_CLIENTE_NOME'];
        customVars.cliente_nome = channelVars['SYNEXA_CLIENTE_NOME'];
      }
      if (channelVars['SYNEXA_CPF']) {
        customVars.cpf = channelVars['SYNEXA_CPF'];
      }
      if (channelVars['SYNEXA_VARS_JSON']) {
        try {
          const parsed = JSON.parse(channelVars['SYNEXA_VARS_JSON']);
          Object.assign(customVars, parsed);
        } catch {
          // ignora formato inválido
        }
      }

      adapter.metadata.customVariables = customVars;
      adapter.metadata.didNumber = didNumber;

      // A resolução de contexto AMI pode levar ~40s (várias conexões
      // sequenciais): sem esta checagem, uma chamada desligada criaria
      // sessão de voz órfã com o Gemini conectado
      if (!socket.writable || socket.destroyed) {
        this.logger.warn(
          `[AudioSocket] Socket fechado durante a resolução de rota (channel=${channelId}); sessão abortada`,
        );
        return;
      }

      const route = await this.endpointResolver.resolve({
        didNumber,
        providerName: adapter.providerName,
        clientIdHint: channelVars['SYNEXA_CLIENT_ID'] || undefined,
        agentStepHint: channelVars['SYNEXA_AGENT_STEP'] || undefined,
      });

      if (!route) {
        this.logger.warn(
          `[AudioSocket] Chamada sem rota (channel=${channelId}, did=${didNumber}). Cadastre em telephony_endpoints.`,
        );
        adapter.hangup('no_route');
        return;
      }

      const agent = route.agent as Record<string, any> | null;
      if (agent?.interaction_mode === 'text') {
        adapter.hangup('agent_text_only');
        return;
      }

      const { session } = await this.voiceSessionFactory.create(
        adapter,
        route,
        {
          onAiHangupRequest: async () => {
            await this.amiService.hangupChannel(asteriskChannel || channelId);
          },
        },
      );

      this.logger.log(
        `📞 [AudioSocket] Sessão iniciada | canal=${channelId} | canal_asterisk=${asteriskChannel ?? 'n/d'} | cliente=${route.client_id} | agente=${route.agent?.id ?? 'default'}`,
      );
      await session.start();
    } catch (err: any) {
      this.logger.error(
        `[AudioSocket] Erro ao processar chamada ${channelId}: ${err.message}`,
      );
      adapter.hangup('internal_error');
    }
  }

  /**
   * O primeiro frame do AudioSocket carrega o UUID do canal; aguarda
   * brevemente por ele antes de decidir rotear.
   */
  private async waitForChannelId(
    adapter: AudioSocketAdapter,
    timeoutMs = 3000,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const id = adapter.metadata.channelId as string | undefined;
      if (id) return id;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }
}
