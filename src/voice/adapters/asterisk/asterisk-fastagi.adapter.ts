import { Logger } from '@nestjs/common';
import * as net from 'net';
import {
  ITelephonyAdapter,
  TelephonyCallMetadata,
} from '../telephony-adapter.interface';
import { G711Codec } from '../../audio/g711-codec.util';
import { AudioResampler } from '../../audio/audio-resampler.util';

export interface FastAgiRawEnvironment {
  agi_channel?: string;
  agi_uniqueid?: string;
  agi_callerid?: string;
  agi_calleridname?: string;
  agi_extension?: string;
  agi_dnid?: string;
  agi_context?: string;
  agi_priority?: string;
  agi_arg_1?: string;
  agi_arg_2?: string;
  agi_arg_3?: string;
  [key: string]: string | undefined;
}

export interface FastAgiAdapterOptions {
  /** Conexao passou pela allowlist de IP e/ou shared secret do ingresso */
  trusted?: boolean;
}

// Chaves de roteamento: so sao honradas em ingressos confiaveis (allowlist
// de IP ou shared secret); sem trust sao descartadas (anti cross-tenant)
const ROUTING_VARIABLE_KEYS = new Set([
  'SYNEXA_CLIENT_ID',
  'SYNEXA_AGENT_ID',
  'SYNEXA_AGENT_STEP',
]);

// Prefixos de negocio aceitos do dialplan (variaveis uteis da URA)
const DIALPLAN_VARIABLE_PREFIXES = ['SYNEXA_', 'VAR_'];

// Chaves fixas de identificacao/telefone/uuid aceitas do dialplan
const DIALPLAN_VARIABLE_KEYS = new Set([
  'CALLER_NAME',
  'CALLER_NUMBER',
  'CLIENTE_NOME',
  'NOME_CONTATO',
  'CPF',
  'CPF_CLIENTE',
  'DOCUMENTO',
  'CODIGO',
  'PARAM',
  'PROTOCOLO',
  'PLANO',
  'FATURAS_ABERTAS',
  'TELEFONE',
  'PHONE',
  'UUID',
  'LEAD_ID',
]);

function isAllowedDialplanVariable(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    ROUTING_VARIABLE_KEYS.has(upper) ||
    DIALPLAN_VARIABLE_KEYS.has(upper) ||
    DIALPLAN_VARIABLE_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

export class AsteriskFastAgiAdapter implements ITelephonyAdapter {
  private readonly logger = new Logger(AsteriskFastAgiAdapter.name);

  public readonly id: string;
  public readonly providerName = 'asterisk_fastagi';
  public readonly sampleRate = 8000;
  public readonly metadata: TelephonyCallMetadata;

  private socket: net.Socket | null = null;
  private audioCallback: ((pcm16: Buffer) => void) | null = null;
  private callStartCallback: (() => void) | null = null;
  private callEndCallback: ((reason?: string) => void) | null = null;
  private errorCallback: ((err: Error) => void) | null = null;
  private variableCallback: ((key: string, value: string) => void) | null =
    null;
  private dtmfCallback: ((digit: string) => void) | null = null;
  private isClosed = false;

  constructor(
    socket: net.Socket,
    rawEnv: FastAgiRawEnvironment,
    options: FastAgiAdapterOptions = {},
  ) {
    this.socket = socket;
    this.id =
      rawEnv.agi_uniqueid ||
      `ast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const trusted = options.trusted ?? false;

    // Extrai variáveis contextuais enviadas pelo dialplan do Asterisk
    // (whitelist; SYNEXA_SECRET nunca entra no contexto da sessão)
    const customVariables: Record<string, string | unknown> = {};
    let droppedVariableLogged = false;
    const warnDropped = (key: string, reason: 'allowlist' | 'untrusted') => {
      if (droppedVariableLogged) return;
      droppedVariableLogged = true;
      if (reason === 'untrusted') {
        this.logger.warn(
          `[AsteriskFastAgiAdapter] Ingresso nao confiavel: variavel de roteamento "${key}" ignorada`,
        );
      } else {
        this.logger.warn(
          `[AsteriskFastAgiAdapter] Variavel fora da allowlist ignorada: "${key}"`,
        );
      }
    };
    for (const [key, value] of Object.entries(rawEnv)) {
      if (value === undefined) continue;
      // Trata variáveis com prefixo personalizado ou argumentos AGI
      if (key.startsWith('agi_variable_')) {
        const cleanKey = key.replace('agi_variable_', '');
        if (cleanKey.toUpperCase() === 'SYNEXA_SECRET') continue;
        if (!isAllowedDialplanVariable(cleanKey)) {
          warnDropped(cleanKey, 'allowlist');
          continue;
        }
        if (ROUTING_VARIABLE_KEYS.has(cleanKey.toUpperCase()) && !trusted) {
          warnDropped(cleanKey, 'untrusted');
          continue;
        }
        customVariables[cleanKey] = this.tryParseJson(value);
      } else if (
        key.toUpperCase().startsWith('SYNEXA_') ||
        key.toUpperCase().startsWith('VAR_')
      ) {
        if (key.toUpperCase() === 'SYNEXA_SECRET') continue;
        if (ROUTING_VARIABLE_KEYS.has(key.toUpperCase()) && !trusted) {
          warnDropped(key, 'untrusted');
          continue;
        }
        customVariables[key] = this.tryParseJson(value);
      }
    }

    // Suporte a JSON direto passado em agi_arg_3 ou SYNEXA_VARIABLES
    if (rawEnv.agi_arg_3 && rawEnv.agi_arg_3.startsWith('{')) {
      try {
        const parsed = JSON.parse(rawEnv.agi_arg_3) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          if (key.toUpperCase() === 'SYNEXA_SECRET') continue;
          if (ROUTING_VARIABLE_KEYS.has(key.toUpperCase()) && !trusted) {
            warnDropped(key, 'untrusted');
            continue;
          }
          if (!isAllowedDialplanVariable(key)) {
            warnDropped(key, 'allowlist');
            continue;
          }
          customVariables[key] = value;
        }
      } catch {
        // Ignora se não for JSON válido
      }
    }

    this.metadata = {
      channelId: rawEnv.agi_channel,
      uniqueId: this.id,
      callerNumber: rawEnv.agi_callerid || rawEnv.agi_arg_1 || 'anonymous',
      callerName: rawEnv.agi_calleridname,
      didNumber:
        rawEnv.agi_extension ||
        rawEnv.agi_dnid ||
        rawEnv.agi_arg_2 ||
        'default',
      customVariables,
    };

    this.setupSocketEvents();
  }

  private setupSocketEvents(): void {
    if (!this.socket) return;

    this.socket.on('error', (err) => {
      this.logger.warn(
        `[AsteriskFastAgiAdapter] Erro no socket TCP: ${err.message}`,
      );
      this.errorCallback?.(err);
    });

    this.socket.on('close', () => {
      if (!this.isClosed) {
        this.isClosed = true;
        this.callEndCallback?.('socket_closed');
      }
    });
  }

  private tryParseJson(value: string): string | unknown {
    if (value.startsWith('{') || value.startsWith('[')) {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }

  public async start(): Promise<void> {
    if (!this.socket || this.isClosed) return;
    // Responde ao Asterisk com ANSWER para estabelecer o canal de áudio
    this.sendCommand('ANSWER');
    this.callStartCallback?.();
    // Aviso único: o protocolo FastAGI NÃO transporta áudio no socket de
    // controle — egresso exige EAGI (fd 3) ou RTP dedicado; ingresso idem
    this.logger.warn(
      '[AsteriskFastAgiAdapter] Canal FastAGI sem transporte de áudio configurado (EAGI/RTP). Áudio da IA não será reproduzido e o ingresso depende de handleIncomingAudio ser acionado por um transporte dedicado.',
    );
  }

  public sendAudio(pcm16: Buffer): void {
    // NUNCA escrever PCM no socket de controle AGI: o Asterisk interpretaria
    // os bytes como comandos AGI, corrompendo o protocolo. Sem transporte
    // EAGI/RTP configurado, o egresso de áudio é descartado com aviso.
    if (this.isClosed) return;
  }

  /**
   * Dispara um pacote de áudio recebido do canal de telefonia (convertido para PCM 16-bit).
   * Deve ser acionado por um transporte de áudio dedicado (EAGI fd 3 / RTP),
   * nunca pelo socket de controle AGI.
   */
  public handleIncomingAudio(rawAudio: Buffer, isG711Ulaw = true): void {
    if (this.isClosed || !this.audioCallback) return;
    const pcm8k = isG711Ulaw ? G711Codec.decodeUlaw(rawAudio) : rawAudio;
    // Converte de 8kHz (Telefonia) para 16kHz (Gemini Live)
    const pcm16k = AudioResampler.telephonyToGemini(pcm8k);
    this.audioCallback(pcm16k);
  }

  public sendCommand(cmd: string): void {
    if (this.socket && !this.isClosed) {
      this.socket.write(`${cmd}\n`);
    }
  }

  public setVariable(key: string, value: string): void {
    if (!this.metadata.customVariables) {
      this.metadata.customVariables = {};
    }
    this.metadata.customVariables[key] = value;
    this.sendCommand(`SET VARIABLE ${key} "${value}"`);
    this.variableCallback?.(key, value);
    this.logger.log(
      `📞 [AsteriskFastAgiAdapter] Variável de canal definida: ${key}="${value}"`,
    );
  }

  public getVariable(key: string): string | undefined {
    return (this.metadata.customVariables?.[key] as string) || undefined;
  }

  public hangup(reason = 'normal_hangup'): void {
    if (this.isClosed) return;
    this.logger.log(
      `📞 [AsteriskFastAgiAdapter] Desligando chamada (${reason})`,
    );
    this.sendCommand('HANGUP');
    this.close();
  }

  public async transferCall(destination: string): Promise<boolean> {
    if (this.isClosed) return false;
    this.logger.log(
      `📞 [AsteriskFastAgiAdapter] Transferindo chamada para: ${destination}`,
    );
    this.sendCommand(`EXEC Transfer "${destination}"`);
    return true;
  }

  public onAudio(callback: (pcm16: Buffer) => void): void {
    this.audioCallback = callback;
  }

  public onCallStart(callback: () => void): void {
    this.callStartCallback = callback;
  }

  public onCallEnd(callback: (reason?: string) => void): void {
    this.callEndCallback = callback;
  }

  public onError(callback: (err: Error) => void): void {
    this.errorCallback = callback;
  }

  public onVariable(callback: (key: string, value: string) => void): void {
    this.variableCallback = callback;
  }

  public onDTMF(callback: (digit: string) => void): void {
    this.dtmfCallback = callback;
  }

  public close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    this.callEndCallback?.('adapter_closed');
  }
}
