import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as net from 'net';
import { AudioSocketAdapter } from '../adapters/audiosocket/audiosocket.adapter';
import { TelephonyEndpointResolverService } from '../services/telephony-endpoint-resolver.service';
import { VoiceSessionFactory } from '../services/voice-session.factory';
import {
  isVoiceIngressIpAllowed,
  parseVoiceIngressAllowlist,
} from './fastagi-server.service';
import { AsteriskAmiService } from './asterisk-ami.service';
import { VoiceGateway } from '../voice.gateway';

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
  private bindHost: string;
  private ingressAllowlist: string[];
  private environment: string;
  private testSessions = new Map<
    string,
    {
      channelId: string;
      asteriskChannel?: string;
      adapter: AudioSocketAdapter;
      session?: any;
      clientId?: string;
      broadcastCallEnd: (reason?: string) => void;
    }
  >();

  constructor(
    private readonly configService: ConfigService,
    private readonly endpointResolver: TelephonyEndpointResolverService,
    private readonly voiceSessionFactory: VoiceSessionFactory,
    private readonly amiService: AsteriskAmiService,
    @Inject(forwardRef(() => VoiceGateway))
    private readonly voiceGateway?: VoiceGateway,
  ) {
    this.port = this.configService.get<number>('AUDIOSOCKET_PORT') || 8090;
    this.enabled =
      this.configService.get<boolean>('AUDIOSOCKET_ENABLED') ?? false;
    this.bindHost =
      this.configService.get<string>('AUDIOSOCKET_BIND_HOST') || '0.0.0.0';
    this.ingressAllowlist = parseVoiceIngressAllowlist(
      this.configService.get<string>('VOICE_INGRESS_ALLOWLIST'),
    );
    this.environment =
      this.configService.get<string>('ENVIRONMENT') || 'development';
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

    if (this.environment === 'production' && !this.ingressAllowlist.length) {
      throw new Error(
        '[AudioSocket] VOICE_INGRESS_ALLOWLIST obrigatoria em ENVIRONMENT=production (fail-closed)',
      );
    }

    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    this.server.listen(this.port, this.bindHost, () => {
      this.logger.log(
        `📞 [AudioSocket] Servidor TCP escutando em ${this.bindHost}:${this.port}`,
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
    const remoteAddress = socket.remoteAddress || '';
    if (!isVoiceIngressIpAllowed(remoteAddress, this.ingressAllowlist)) {
      this.logger.warn(
        `[AudioSocket] Conexao recusada fora da allowlist (ip=${remoteAddress || 'unknown'})`,
      );
      socket.destroy();
      return;
    }

    // Sem allowlist configurada o ingresso roda em modo nao confiavel:
    // dicas de roteamento herdadas do canal (SYNEXA_CLIENT_ID/AGENT_STEP/
    // VARS_JSON) sao ignoradas e o roteamento ocorre apenas pelo DID
    const trusted = this.ingressAllowlist.length > 0;

    const adapter = new AudioSocketAdapter(socket);

    const channelId = await this.waitForChannelId(adapter);
    if (!channelId || !socket.writable) {
      socket.destroy();
      return;
    }

    let session: any = null;
    let isTestRoute = false;
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
      const dialTokens: string[] = [];
      if (rawDid.includes('*')) {
        const parts = rawDid.split('*');
        rawDid = parts[0];
        dialParam = parts.slice(1).join('*');
        dialTokens.push(...parts.slice(1));
      }
      const didNumber = rawDid || undefined;

      // Popula variáveis de contexto recebidas na chamada telefônica
      const customVars: Record<string, any> = {
        ...(adapter.metadata.customVariables || {}),
      };

      const callerName = channelVars['CALLERID(name)'];
      if (callerName && callerName.toLowerCase() !== 'microsip') {
        if (callerName.includes(';') || callerName.includes('|')) {
          const parts = callerName.split(/[;|]/);
          parts.forEach((p, idx) => {
            if (p.includes('=')) {
              const [k, ...v] = p.split('=');
              if (k.trim()) customVars[k.trim()] = v.join('=').trim();
            } else if (idx === 0) {
              customVars.caller_name = p.trim();
              customVars.nome_contato = p.trim();
              customVars.cliente_nome = p.trim();
            }
          });
        } else {
          customVars.caller_name = callerName;
          customVars.nome_contato = callerName;
          customVars.cliente_nome = callerName;
        }
      }
      if (channelVars['CALLERID(num)']) {
        customVars.caller_number = channelVars['CALLERID(num)'];
        customVars.origem_chamada = channelVars['CALLERID(num)'];
      }
      if (dialTokens.length > 0) {
        dialTokens.forEach((token, idx) => {
          if (token.includes('=')) {
            const [k, ...v] = token.split('=');
            if (k.trim()) customVars[k.trim()] = v.join('=').trim();
          } else {
            customVars[`param_${idx + 1}`] = token;
            if (idx === 0) {
              customVars.param = token;
              customVars.cpf = token;
              customVars.documento = token;
              customVars.codigo = token;
            }
          }
        });
      }
      if (channelVars['SYNEXA_CLIENTE_NOME']) {
        customVars.nome_contato = channelVars['SYNEXA_CLIENTE_NOME'];
        customVars.cliente_nome = channelVars['SYNEXA_CLIENTE_NOME'];
      }
      if (channelVars['SYNEXA_CPF']) {
        customVars.cpf = channelVars['SYNEXA_CPF'];
      }
      if (trusted && channelVars['SYNEXA_VARS_JSON']) {
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
        clientIdHint: trusted
          ? channelVars['SYNEXA_CLIENT_ID'] || undefined
          : undefined,
        agentStepHint: trusted
          ? channelVars['SYNEXA_AGENT_STEP'] || undefined
          : undefined,
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

      // ROTA DE TESTES DO FLOW STUDIO
      isTestRoute =
        route.agent_step === 'test' ||
        channelVars['SYNEXA_TEST_MODE'] === 'true' ||
        (didNumber && /^7\d{3}$/.test(didNumber))
          ? true
          : false;

      const startTime = Date.now();
      const callerNumber = adapter.metadata.callerNumber || 'MicroSIP';
      const callerDisplayName = adapter.metadata.callerName || 'Ramal Local';

      if (isTestRoute) {
        this.logger.log(
          `🧪 [AudioSocket] Rota de Testes Flow Studio CONECTADA À IA para DID=${didNumber} canal=${channelId} cliente=${route.client_id}.`,
        );

        // Notifica o frontend de que o Listener detectou a chamada e iniciou a sessão de teste
        this.voiceGateway?.broadcast({
          type: 'flow_telephony_inbound',
          clientId: route.client_id || null,
          agentStep: 'test',
          agentName:
            (route.agent as any)?.service_step ||
            (route.agent as any)?.name ||
            null,
          agentId: (route.agent as any)?.id || null,
          event: {
            id: `evt_sip_${channelId}`,
            clientId: route.client_id || null,
            timestamp: new Date().toLocaleTimeString('pt-BR', {
              hour12: false,
            }),
            connectorId: 'connector-asterisk-primary',
            environment: 'test',
            mode: 'voice',
            status: 'streaming',
            voiceData: {
              callerNumber,
              callerName: callerDisplayName,
              didNumber: didNumber || '7001',
              queue: 'rota_teste_inbound',
              channelId: String(channelId),
              uniqueId: asteriskChannel || channelId,
              protocol: 'SIP / AudioSocket (Asterisk 20)',
              codec: 'G.711u (PCMU 8kHz)',
              sampleRate: 8000,
              sipHeaders: {
                'Call-ID': `sip-${channelId}@asterisk`,
                'User-Agent': 'MicroSIP / Asterisk PJSIP',
                'X-Synexa-Channel': channelId,
                'X-Asterisk-Channel': asteriskChannel ?? 'Local',
                'X-Caller-ID': callerNumber,
                'X-Listener-Mode': 'AGENTE_ATIVO_IA',
              },
              customVariables: customVars,
              chunksCount: 0,
              totalAudioBytes: 0,
              currentDb: -20,
              durationSeconds: 0,
              isStreaming: true,
            },
          },
        });

        // Transmite métricas acústicas em tempo real
        let lastAudioBroadcast = 0;
        let chunksCount = 0;
        let totalAudioBytes = 0;
        adapter.onAudioMetrics(({ db, bytesCount }) => {
          chunksCount++;
          totalAudioBytes += bytesCount;
          const now = Date.now();
          if (now - lastAudioBroadcast > 100) {
            lastAudioBroadcast = now;
            this.voiceGateway?.broadcast({
              type: 'flow_telephony_audio',
              channelId,
              clientId: route.client_id || null,
              agentStep: 'test',
              currentDb: db,
              chunksCount,
              totalAudioBytes,
              durationSeconds: Math.round((now - startTime) / 1000),
            });
          }
        });

        let callEndBroadcasted = false;
        const broadcastCallEnd = (reason?: string) => {
          if (callEndBroadcasted) return;
          callEndBroadcasted = true;
          this.testSessions.delete(String(channelId));
          if (route.client_id) {
            this.testSessions.delete(route.client_id);
          }
          const durationSeconds = Number(
            ((Date.now() - startTime) / 1000).toFixed(1),
          );
          this.logger.log(
            `🧪 [AudioSocket] Rota de Testes com IA finalizada | canal=${channelId} | dur=${durationSeconds}s | motivo=${reason || 'caller_hangup'}`,
          );
          this.voiceGateway?.broadcast({
            type: 'flow_telephony_inbound',
            clientId: route.client_id || null,
            agentStep: 'test',
            event: {
              id: `evt_sip_${channelId}`,
              clientId: route.client_id || null,
              timestamp: new Date().toLocaleTimeString('pt-BR', {
                hour12: false,
              }),
              connectorId: 'connector-asterisk-primary',
              environment: 'test',
              mode: 'voice',
              status: 'completed',
              hangupReason: reason || 'caller_hangup',
              voiceData: {
                callerNumber,
                callerName: callerDisplayName,
                didNumber: didNumber || '7001',
                channelId: String(channelId),
                uniqueId: asteriskChannel || channelId,
                durationSeconds,
                isStreaming: false,
                customVariables: customVars,
              },
            },
          });
        };

        const testSessionItem = {
          channelId: String(channelId),
          asteriskChannel: asteriskChannel || undefined,
          adapter,
          session: undefined as any,
          clientId: route.client_id,
          broadcastCallEnd,
        };
        this.testSessions.set(String(channelId), testSessionItem);
        if (route.client_id) {
          this.testSessions.set(route.client_id, testSessionItem);
        }

        adapter.onCallEnd((reason) => {
          broadcastCallEnd(reason);
        });
      }

      const maxConcurrent = (route.client as any)?.max_concurrent_calls;
      const slotCheck = this.voiceSessionFactory.checkAcquireSession(
        route.client_id,
        maxConcurrent,
      );
      if (!slotCheck.allowed) {
        this.logger.warn(
          `[AudioSocket] Chamada recusada: ${slotCheck.reason} (cliente=${route.client_id}, max=${maxConcurrent})`,
        );
        adapter.hangup('limit_exceeded');
        return;
      }

      const created = await this.voiceSessionFactory.create(adapter, route, {
        onAiHangupRequest: async () => {
          await this.amiService.hangupChannel(asteriskChannel || channelId);
        },
        onSessionEnd: () => {
          if (isTestRoute) {
            const current = this.testSessions.get(String(channelId));
            if (current) current.broadcastCallEnd('session_end');
          }
        },
        onEvent: (event: any) => {
          if (isTestRoute) {
            this.voiceGateway?.broadcast({
              ...event,
              channelId,
              clientId: route.client_id || null,
              agentStep: 'test',
            });
          }
        },
      });
      session = created.session;
      if (isTestRoute) {
        const current = this.testSessions.get(String(channelId));
        if (current) current.session = session;
      }

      this.logger.log(
        `📞 [AudioSocket] Sessão de Produção iniciada | canal=${channelId} | canal_asterisk=${asteriskChannel ?? 'n/d'} | cliente=${route.client_id} | agente=${route.agent?.id ?? 'default'}`,
      );

      // Chamadas de produção rodam no fluxo regular com a IA e não emitem eventos visuais para o Flow Studio

      await session.start();
    } catch (err: any) {
      this.logger.error(
        `[AudioSocket] Erro ao processar chamada ${channelId}: ${err.message}`,
      );
      if (session) {
        try {
          await session.end('start_failed');
        } catch {}
      }
      adapter.hangup('internal_error');
      // Broadcast de encerramento APENAS quando a sessão falhou ao iniciar.
      // O fim legítimo da chamada é transmitido por adapter.onCallEnd /
      // onSessionEnd / hangup manual — nunca aqui, pois o `start()` resolve
      // em ~2s (só configura provider + transporte) e um broadcast neste
      // ponto matava as animações AO VIVO do Flow Studio no meio da ligação.
      if (isTestRoute) {
        const current = this.testSessions.get(String(channelId));
        if (current) current.broadcastCallEnd('start_failed');
      }
    }
  }

  /**
   * Captura dados e pacotes de áudio da rota de teste sem conectar ao LLM/Agente.
   * Mantém a perna do Asterisk ativa e acumula estatísticas até o chamador desligar.
   */
  private handleTestCaptureSession(
    adapter: AudioSocketAdapter,
    channelId: string,
    asteriskChannel: string | null,
    didNumber?: string,
    customVars: Record<string, any> = {},
    clientId?: string | null,
  ): void {
    const callerNumber = adapter.metadata.callerNumber || 'MicroSIP';
    const callerName = adapter.metadata.callerName || 'Ramal Local';
    const startTime = Date.now();

    let chunksCount = 0;
    let totalAudioBytes = 0;
    let maxDb = -60;
    let sumDb = 0;
    let dbSamples = 0;

    // 1. Notifica o frontend de que o Listener detectou a chamada de teste e iniciou a captura
    this.voiceGateway?.broadcast({
      type: 'flow_telephony_inbound',
      clientId: clientId || null,
      agentStep: 'test',
      event: {
        id: `evt_sip_${channelId}`,
        clientId: clientId || null,
        timestamp: new Date().toLocaleTimeString('pt-BR', { hour12: false }),
        connectorId: 'connector-asterisk-primary',
        environment: 'test',
        mode: 'voice',
        status: 'streaming',
        voiceData: {
          callerNumber,
          callerName,
          didNumber: didNumber || '7001',
          queue: 'rota_teste_inbound',
          channelId: String(channelId),
          uniqueId: asteriskChannel || channelId,
          protocol: 'SIP / AudioSocket (Asterisk 20)',
          codec: 'G.711u (PCMU 8kHz)',
          sampleRate: 8000,
          sipHeaders: {
            'Call-ID': `sip-${channelId}@asterisk`,
            'User-Agent': 'MicroSIP / Asterisk PJSIP',
            'X-Synexa-Channel': channelId,
            'X-Asterisk-Channel': asteriskChannel ?? 'Local',
            'X-Caller-ID': callerNumber,
            'X-Listener-Mode': 'CAPTURA_SEM_AGENTE',
          },
          customVariables: customVars,
          chunksCount: 0,
          totalAudioBytes: 0,
          currentDb: -20,
          durationSeconds: 0,
          isStreaming: true,
        },
      },
    });

    // 2. Transmite métricas acústicas em tempo real conforme os frames de 20ms chegam
    let lastAudioBroadcast = 0;
    adapter.onAudioMetrics(({ db, bytesCount }) => {
      chunksCount++;
      totalAudioBytes += bytesCount;
      if (db > maxDb) maxDb = db;
      if (db > -60) {
        sumDb += db;
        dbSamples++;
      }

      const now = Date.now();
      if (now - lastAudioBroadcast > 80) {
        lastAudioBroadcast = now;
        this.voiceGateway?.broadcast({
          type: 'flow_telephony_audio',
          channelId,
          clientId: clientId || null,
          agentStep: 'test',
          currentDb: db,
          chunksCount,
          totalAudioBytes,
          durationSeconds: Math.round((now - startTime) / 1000),
        });
      }
    });

    // 3. Ao encerrar a ligação no MicroSIP: consolida tudo o que chegou e entrega ao front
    adapter.onCallEnd((reason) => {
      const durationSeconds = Number(
        ((Date.now() - startTime) / 1000).toFixed(1),
      );
      const avgDb = dbSamples > 0 ? Math.round(sumDb / dbSamples) : maxDb;

      this.logger.log(
        `🧪 [AudioSocket] Rota de Testes finalizada | canal=${channelId} | frames=${chunksCount} | bytes=${totalAudioBytes} | dur=${durationSeconds}s`,
      );

      this.voiceGateway?.broadcast({
        type: 'flow_telephony_inbound',
        clientId: clientId || null,
        agentStep: 'test',
        event: {
          id: `evt_sip_${channelId}`,
          clientId: clientId || null,
          timestamp: new Date().toLocaleTimeString('pt-BR', { hour12: false }),
          connectorId: 'connector-asterisk-primary',
          environment: 'test',
          mode: 'voice',
          status: 'completed',
          hangupReason: reason || 'caller_hangup',
          voiceData: {
            callerNumber,
            callerName,
            didNumber: didNumber || '7001',
            queue: 'rota_teste_inbound',
            channelId: String(channelId),
            uniqueId: asteriskChannel || channelId,
            protocol: 'SIP / AudioSocket (Asterisk 20)',
            codec: 'G.711u (PCMU 8kHz)',
            sampleRate: 8000,
            sipHeaders: {
              'Call-ID': `sip-${channelId}@asterisk`,
              'User-Agent': 'MicroSIP / Asterisk PJSIP',
              'X-Synexa-Channel': channelId,
              'X-Asterisk-Channel': asteriskChannel ?? 'Local',
              'X-Caller-ID': callerNumber,
              'X-Capture-Status': 'CONCLUIDO_COM_SUCESSO',
              'X-Audio-Chunks': String(chunksCount),
              'X-Total-Bytes': `${(totalAudioBytes / 1024).toFixed(1)} KB`,
              'X-Avg-Db': `${avgDb} dB`,
              'X-Max-Db': `${maxDb} dB`,
            },
            customVariables: {
              ...customVars,
              total_frames_audio: chunksCount,
              total_bytes_audio: totalAudioBytes,
              duracao_segundos: durationSeconds,
              pico_acustico_db: maxDb,
              status_conector: 'dados_consolidados_prontos',
            },
            chunksCount,
            totalAudioBytes,
            currentDb: maxDb,
            durationSeconds,
            isStreaming: false,
          },
        },
      });
    });
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

  /**
   * Encerra chamadas ativas de teste do Flow Studio (MicroSIP / Asterisk),
   * liberando canais no PBX e notificando o frontend.
   */
  public async hangupTestCall(clientId?: string): Promise<boolean> {
    this.logger.log(
      `📞 [AudioSocket] Solicitação de encerramento manual de chamada de teste (cliente=${clientId || 'todos'})`,
    );
    let hungUp = false;
    const targets = Array.from(this.testSessions.values());
    for (const item of targets) {
      if (!clientId || item.clientId === clientId) {
        try {
          if (item.asteriskChannel) {
            await this.amiService.hangupChannel(item.asteriskChannel);
          }
          item.adapter.hangup('manual_hangup');
          if (item.session) {
            await item.session.end('manual_hangup');
          }
          item.broadcastCallEnd('manual_hangup');
          hungUp = true;
        } catch (err: any) {
          this.logger.warn(
            `[AudioSocket] Erro ao desligar canal ${item.channelId}: ${err.message}`,
          );
        }
      }
    }

    // Notificação garantida para o frontend caso nenhuma sessão estivesse no mapa
    this.voiceGateway?.broadcast({
      type: 'flow_telephony_inbound',
      clientId: clientId || null,
      agentStep: 'test',
      event: {
        id: `evt_sip_manual_${Date.now()}`,
        clientId: clientId || null,
        timestamp: new Date().toLocaleTimeString('pt-BR', { hour12: false }),
        connectorId: 'connector-asterisk-primary',
        environment: 'test',
        mode: 'voice',
        status: 'completed',
        hangupReason: 'manual_hangup',
        voiceData: {
          callerNumber: 'manual',
          callerName: 'Encerramento Manual',
          didNumber: '7001',
          durationSeconds: 0,
          isStreaming: false,
        },
      },
    });

    return hungUp;
  }
}
