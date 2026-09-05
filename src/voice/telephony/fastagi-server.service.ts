import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import * as net from 'net';
import * as readline from 'readline';

import { AsteriskFastAgiAdapter } from '../adapters/asterisk/asterisk-fastagi.adapter';
import { TelephonyEndpointResolverService } from '../services/telephony-endpoint-resolver.service';
import { VoiceSessionFactory } from '../services/voice-session.factory';
import { AsteriskAmiService } from './asterisk-ami.service';

export function parseVoiceIngressAllowlist(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function matchesIngressCidr(address: string, cidr: string): boolean {
  if (address.includes(':') || cidr.includes(':')) {
    return address.toLowerCase() === cidr.toLowerCase();
  }
  const [range, bitsRaw] = cidr.split('/');
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  const addressInt = ipv4ToInt(address);
  const rangeInt = ipv4ToInt(range || '');
  if (
    addressInt === null ||
    rangeInt === null ||
    !Number.isInteger(bits) ||
    bits < 0 ||
    bits > 32
  ) {
    return false;
  }
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (addressInt & mask) === (rangeInt & mask);
}

/**
 * Allowlist de ingresso de voz (VOICE_INGRESS_ALLOWLIST, CIDRs separados
 * por virgula). Lista vazia = sem restricao (desenvolvimento); em
 * production os servidores de voz recusam iniciar sem allowlist.
 */
export function isVoiceIngressIpAllowed(
  remoteAddress: string | undefined,
  allowlist: string[],
): boolean {
  if (!allowlist.length) return true;
  if (!remoteAddress) return false;
  const address = remoteAddress.toLowerCase().replace(/^::ffff:/, '');
  return allowlist.some((cidr) =>
    matchesIngressCidr(address, cidr.toLowerCase()),
  );
}

/**
 * Comparacao em tempo constante (via SHA-256) do shared secret FastAGI.
 * O dialplan precisa enviar a variavel SYNEXA_SECRET (Set(SYNEXA_SECRET=...)
 * antes do AGI) quando AGI_SHARED_SECRET estiver configurada.
 */
export function voiceIngressSecretMatches(
  provided: string | undefined,
  expected: string,
): boolean {
  if (!provided || !expected) return false;
  const providedHash = createHash('sha256').update(provided).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

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
  private bindHost: string;
  private ingressAllowlist: string[];
  private agiSharedSecret: string;
  private environment: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly endpointResolver: TelephonyEndpointResolverService,
    private readonly voiceSessionFactory: VoiceSessionFactory,
    private readonly amiService: AsteriskAmiService,
  ) {
    this.port = this.configService.get<number>('FASTAGI_PORT') || 4573;
    this.enabled = this.configService.get<boolean>('FASTAGI_ENABLED') ?? false;
    this.bindHost =
      this.configService.get<string>('AGI_BIND_HOST') || '0.0.0.0';
    this.ingressAllowlist = parseVoiceIngressAllowlist(
      this.configService.get<string>('VOICE_INGRESS_ALLOWLIST'),
    );
    this.agiSharedSecret =
      this.configService.get<string>('AGI_SHARED_SECRET') || '';
    this.environment =
      this.configService.get<string>('ENVIRONMENT') || 'development';
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

    if (this.environment === 'production' && !this.ingressAllowlist.length) {
      throw new Error(
        '[FastAGI] VOICE_INGRESS_ALLOWLIST obrigatoria em ENVIRONMENT=production (fail-closed)',
      );
    }

    this.server = net.createServer((socket) => {
      this.handleSocketConnection(socket);
    });

    this.server.listen(this.port, this.bindHost, () => {
      this.logger.log(
        `📞 [FastAGI] Servidor TCP escutando em ${this.bindHost}:${this.port}`,
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
    const remoteAddress = socket.remoteAddress || '';
    if (!isVoiceIngressIpAllowed(remoteAddress, this.ingressAllowlist)) {
      this.logger.warn(
        `[FastAGI] Conexao recusada fora da allowlist (ip=${remoteAddress || 'unknown'})`,
      );
      socket.destroy();
      return;
    }

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
    // 0. Shared secret opcional (AGI_SHARED_SECRET): o dialplan precisa
    // enviar Set(SYNEXA_SECRET=...) antes do AGI; sem match a conexao encerra
    if (this.agiSharedSecret) {
      const provided = agiEnv['agi_variable_SYNEXA_SECRET'];
      if (!voiceIngressSecretMatches(provided, this.agiSharedSecret)) {
        this.logger.warn(
          `[FastAGI] Shared secret ausente ou invalido; conexao encerrada (ip=${socket.remoteAddress || 'unknown'})`,
        );
        socket.end();
        return;
      }
    }

    // Ingresso confiavel: passou pela allowlist de IP e/ou shared secret
    // (sem allowlist/secret configurados, variaveis de roteamento sao
    // ignoradas pelo adapter e o roteamento acontece apenas pelo DID)
    const trusted =
      this.ingressAllowlist.length > 0 || this.agiSharedSecret.length > 0;

    // 1. Transporte: variáveis AGI viram metadados normalizados do adapter
    const adapter = new AsteriskFastAgiAdapter(socket, agiEnv, { trusted });
    this.logger.log(
      `📞 [FastAGI] Chamada recebida | canal=${adapter.metadata.channelId} | caller=${adapter.metadata.callerNumber} | did=${adapter.metadata.didNumber} | vars=${JSON.stringify(adapter.metadata.customVariables || {})}`,
    );

    const customVariables = (adapter.metadata.customVariables || {}) as Record<
      string,
      unknown
    >;

    let session: any = null;
    try {
      // 2. Roteamento plug-and-play: DID/variáveis -> telephony_endpoints
      const route = await this.endpointResolver.resolve({
        didNumber: (adapter.metadata.didNumber as string) || undefined,
        providerName: adapter.providerName,
        clientIdHint: trusted
          ? (customVariables.SYNEXA_CLIENT_ID as string) || undefined
          : undefined,
        agentStepHint: trusted
          ? (customVariables.SYNEXA_AGENT_STEP as string) || undefined
          : undefined,
        trusted,
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
      const created = await this.voiceSessionFactory.create(adapter, route, {
        onAiHangupRequest: async () => {
          if (channelId) {
            await this.amiService.hangupChannel(channelId);
          }
        },
      });
      session = created.session;

      await session.start();
    } catch (err: any) {
      this.logger.error(`❌ [FastAGI] Erro ao iniciar sessão: ${err.message}`);
      if (session) {
        try {
          await session.end('start_failed');
        } catch {}
      }
      adapter.hangup('internal_error');
    }
  }
}
