import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/redis/redis.service';

export type CallSpeakingStatus =
  | 'connecting'
  | 'speaking_ai'
  | 'listening_user'
  | 'thinking';

export interface ActiveCallDescriptor {
  callId: string;
  channelId: string;
  asteriskChannel?: string;
  companyId: string;
  clientId: string;
  agentId?: string;
  agentName?: string;
  callerNumber: string;
  callerName: string;
  didNumber: string;
  startedAt: number;
  status: CallSpeakingStatus;
  lastStateChange?: number;
}

export interface LiveAudioChunk {
  role: 'ai' | 'user';
  pcmBase64: string;
  sampleRate: number;
}

@Injectable()
export class ActiveCallsRegistryService {
  private readonly logger = new Logger(ActiveCallsRegistryService.name);
  private readonly calls = new Map<string, ActiveCallDescriptor>();
  private readonly audioListeners = new Map<
    string,
    Set<(chunk: LiveAudioChunk) => void>
  >();
  private statusUpdateCallback?: (event: {
    type: string;
    call: ActiveCallDescriptor;
  }) => void;

  constructor(private readonly redis: RedisService) {}

  public onCallEvent(
    callback: (event: { type: string; call: ActiveCallDescriptor }) => void,
  ): void {
    this.statusUpdateCallback = callback;
  }

  public async registerCall(
    descriptor: Omit<ActiveCallDescriptor, 'startedAt' | 'status'> & {
      status?: CallSpeakingStatus;
    },
  ): Promise<ActiveCallDescriptor> {
    const full: ActiveCallDescriptor = {
      ...descriptor,
      startedAt: Date.now(),
      status: descriptor.status || 'connecting',
      lastStateChange: Date.now(),
    };

    this.calls.set(full.callId, full);
    if (full.channelId && full.channelId !== full.callId) {
      this.calls.set(full.channelId, full);
    }

    try {
      await this.redis.set(`synexa:call:${full.callId}`, full, 3600);
      await this.syncCompanyCallsToRedis(full.companyId);
    } catch (e: any) {
      this.logger.warn(
        `Falha ao sincronizar registro da chamada no Redis: ${e?.message}`,
      );
    }

    this.statusUpdateCallback?.({
      type: 'monitoring_call_started',
      call: full,
    });

    return full;
  }

  public updateCallStatus(callId: string, status: CallSpeakingStatus): void {
    const call = this.calls.get(callId);
    if (!call || call.status === status) return;
    call.status = status;
    call.lastStateChange = Date.now();
    this.statusUpdateCallback?.({ type: 'monitoring_call_status', call });
  }

  public async unregisterCall(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call) return;

    this.calls.delete(call.callId);
    if (call.channelId) this.calls.delete(call.channelId);

    // Fecha ouvintes de áudio ativos
    const listeners = this.audioListeners.get(call.callId);
    if (listeners) {
      listeners.clear();
      this.audioListeners.delete(call.callId);
    }

    try {
      await this.redis.del(`synexa:call:${call.callId}`);
      await this.syncCompanyCallsToRedis(call.companyId);
    } catch (e: any) {
      this.logger.warn(`Falha ao remover chamada do Redis: ${e?.message}`);
    }

    this.statusUpdateCallback?.({ type: 'monitoring_call_ended', call });
  }

  public async getActiveCalls(
    companyId: string,
  ): Promise<ActiveCallDescriptor[]> {
    const results: ActiveCallDescriptor[] = [];
    const seen = new Set<string>();

    for (const call of this.calls.values()) {
      if (call.companyId === companyId && !seen.has(call.callId)) {
        seen.add(call.callId);
        results.push(call);
      }
    }

    if (results.length > 0) {
      return results;
    }

    // Fallback para Redis (quando consultado pelo container da API)
    try {
      const fromRedis = await this.redis.get<ActiveCallDescriptor[]>(
        `synexa:active_calls:${companyId}`,
      );
      if (Array.isArray(fromRedis)) {
        return fromRedis;
      }
    } catch (e: any) {
      this.logger.debug(`Falha ao ler chamadas ativas do Redis: ${e?.message}`);
    }

    return [];
  }

  public getCall(callId: string): ActiveCallDescriptor | undefined {
    return this.calls.get(callId);
  }

  public async getCallFromRedis(
    callId: string,
  ): Promise<ActiveCallDescriptor | undefined> {
    const inMem = this.calls.get(callId);
    if (inMem) return inMem;
    try {
      const fromRedis = await this.redis.get<ActiveCallDescriptor>(
        `synexa:call:${callId}`,
      );
      return fromRedis || undefined;
    } catch {
      return undefined;
    }
  }

  public subscribeAudio(
    callId: string,
    listener: (chunk: LiveAudioChunk) => void,
  ): () => void {
    let set = this.audioListeners.get(callId);
    if (!set) {
      set = new Set();
      this.audioListeners.set(callId, set);
    }
    set.add(listener);

    return () => {
      const current = this.audioListeners.get(callId);
      if (current) {
        current.delete(listener);
        if (current.size === 0) {
          this.audioListeners.delete(callId);
        }
      }
    };
  }

  public pushAudioChunk(
    callId: string,
    role: 'ai' | 'user',
    pcmBuffer: Buffer,
    sampleRate: number,
  ): void {
    const listeners = this.audioListeners.get(callId);
    if (!listeners || listeners.size === 0) return;

    const chunk: LiveAudioChunk = {
      role,
      pcmBase64: pcmBuffer.toString('base64'),
      sampleRate,
    };

    for (const listener of listeners) {
      try {
        listener(chunk);
      } catch (err: any) {
        this.logger.debug(
          `Falha ao despachar áudio para listener: ${err?.message}`,
        );
      }
    }
  }

  private async syncCompanyCallsToRedis(companyId: string): Promise<void> {
    if (!companyId) return;
    const calls = this.getActiveCalls(companyId);
    await this.redis.set(`synexa:active_calls:${companyId}`, calls, 3600);
  }
}
