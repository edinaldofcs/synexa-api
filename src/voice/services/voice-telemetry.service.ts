import { patchConversationState } from '../../common/prisma/conversation-state';
import { finalizeVoiceConversation } from './voice-heartbeat';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ModelPricingService } from '../../orchestrator/services/model-pricing.service';
import type { VoiceClientSession } from '../sessions/voice-client-session';

export interface VoiceTelemetryPayload {
  durationSec: number;
  forwardedSec: number;
  suppressedSec: number;
  interruptedCount: number;
  totalTokens: number;
  audioInputTokens: number;
  audioOutputTokens: number;
  costUsd: number;
  costBrl: number;
  voiceName: string;
  audioGateEnabled: boolean;
}

/**
 * Persistência da sessão de voz do navegador: mensagens (buffer do turno da
 * IA com throttle), transcripts do usuário, estado da conversa e telemetria
 * consolidada (agent_runs + voice_session_telemetry).
 */
@Injectable()
export class VoiceTelemetryService {
  private readonly logger = new Logger(VoiceTelemetryService.name);
  private readonly costCache = new WeakMap<
    VoiceClientSession,
    { usageKey: string; costUsd: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: ModelPricingService,
  ) {}

  // ── Buffer do turno da IA ───────────────────────────────────────

  createAiBuffer() {
    return { messageId: null, content: '', lastPersist: 0 };
  }

  /**
   * Acumula o transcript da IA no buffer do turno. Eventos podem ser deltas
   * ("Vamos", "conversar") ou cumulativos; o startsWith detecta o caso
   * cumulativo. Chunks intermediários atualizam sempre a MESMA linha
   * (throttle 1s).
   */
  async appendAiTranscript(
    session: VoiceClientSession,
    text: string,
    turnId = session.auditTurn?.assistant(),
  ): Promise<void> {
    const buffer = session.aiMessageBuffer;
    if (!buffer) return;
    if (!session.conversationId || !session.companyId || !text) return;

    try {
      if (buffer.content && text.startsWith(buffer.content)) {
        buffer.content = text;
      } else {
        buffer.content = buffer.content ? `${buffer.content} ${text}` : text;
      }

      const now = Date.now();
      if (!buffer.messageId) {
        const created = await this.prisma.messages.create({
          data: {
            company_id: session.companyId,
            conversation_id: session.conversationId!,
            sender_type: 'ai',
            channel: 'voice',
            direction: 'outbound',
            content: buffer.content,
            metadata: turnId
              ? { turn_id: turnId, agent_id: session.agentId || null }
              : undefined,
          },
        });
        buffer.messageId = created.id;
        buffer.lastPersist = now;
      } else if (now - buffer.lastPersist > 1000) {
        await this.prisma.messages.update({
          where: { id: buffer.messageId },
          data: { content: buffer.content },
        });
        buffer.lastPersist = now;
      }
    } catch (e: any) {
      this.logger.debug(`Erro ao salvar mensagem AI: ${e.message}`);
    }
  }

  /** Persiste o conteúdo final acumulado do turno da IA e encerra o buffer. */
  async flushAiBuffer(session: VoiceClientSession): Promise<void> {
    const buffer = session.aiMessageBuffer;
    if (!buffer?.messageId || !buffer.content) return;
    try {
      await this.prisma.messages.update({
        where: { id: buffer.messageId },
        data: { content: buffer.content },
      });
    } catch (e: any) {
      this.logger.debug(`Erro ao finalizar mensagem AI: ${e.message}`);
    }
    session.aiMessageBuffer = null;
  }

  // ── Transcripts e estado ────────────────────────────────────────

  async persistUserTranscript(
    session: VoiceClientSession,
    text: string,
    turnId = session.auditTurn?.user(),
  ): Promise<void> {
    if (!session.conversationId || !session.companyId || !text) return;
    try {
      await this.prisma.messages.create({
        data: {
          company_id: session.companyId,
          conversation_id: session.conversationId,
          sender_type: 'customer',
          channel: 'voice',
          direction: 'inbound',
          content: text,
          metadata: turnId
            ? { turn_id: turnId, agent_id: session.agentId || null }
            : undefined,
        },
      });
    } catch (e: any) {
      this.logger.debug(`Erro ao salvar mensagem User: ${e.message}`);
    }
  }

  async persistConversationState(session: VoiceClientSession): Promise<void> {
    if (!session.conversationId) return;
    await patchConversationState(
      this.prisma,
      session.conversationId,
      session.state,
    );
  }

  // ── Telemetria consolidada ──────────────────────────────────────

  buildTelemetryPayload(
    session: VoiceClientSession,
  ): VoiceTelemetryPayload | null {
    if (!session.conversationId) return null;

    const stats = session.gateSession?.getStats();
    const durationSec = Number(session.elapsedSeconds.toFixed(1));
    // Custo recalculado apenas quando o uso de tokens muda (telemetria WS 5s)
    const usageKey = `${session.inputTokens}:${session.outputTokens}`;
    const cached = this.costCache.get(session);
    const costUsd =
      cached?.usageKey === usageKey
        ? cached.costUsd
        : this.pricingService.calculateVoiceLiveCost({
            durationSeconds: durationSec,
            inputTokens: session.inputTokens,
            outputTokens: session.outputTokens,
          });
    if (cached?.usageKey !== usageKey) {
      this.costCache.set(session, { usageKey, costUsd });
    }

    return {
      durationSec,
      forwardedSec: stats?.forwardedSec || 0,
      suppressedSec: stats?.suppressedSec || 0,
      interruptedCount: session.interruptedCount,
      totalTokens: session.totalTokens,
      audioInputTokens: session.inputTokens,
      audioOutputTokens: session.outputTokens,
      costUsd,
      costBrl: Number(
        (costUsd * this.pricingService.getExchangeRate()).toFixed(4),
      ),
      voiceName: session.voiceName,
      audioGateEnabled: session.gateSession?.enabled ?? false,
    };
  }

  /**
   * Fecha a conversa omnichannel, registra agent_runs e voice_session_telemetry
   * (uma única vez por sessão).
   */
  async persistSessionTelemetry(
    session: VoiceClientSession,
    reason?: string,
  ): Promise<void> {
    if (session.telemetryPersisted) return;
    session.telemetryPersisted = true;

    const durationSeconds = Math.max(1, Math.round(session.elapsedSeconds));

    if (!session.companyId) return;

    try {
      const rawCost =
        session.voiceEngine === 'hybrid'
          ? this.pricingService.calculateHybridVoiceCost({
              durationSeconds,
              inputTokens: session.inputTokens,
              outputTokens: session.outputTokens,
              byoVoice: session.ttsProvider === 'custom',
            })
          : this.pricingService.calculateVoiceLiveCost({
              durationSeconds,
              inputTokens: session.inputTokens,
              outputTokens: session.outputTokens,
            });

      // 1. Fecha a conversa omnichannel
      if (session.conversationId) {
        await this.prisma.conversations.update({
          where: { id: session.conversationId },
          data: {
            status: 'closed',
            closed_at: new Date(),
          },
        });
      }

      // 2. Registra agent_runs
      if (session.totalTokens > 0 && session.companyId && session.clientId) {
        await this.prisma.agent_runs.create({
          data: {
            company_id: session.companyId,
            client_id: session.clientId,
            conversation_id: session.conversationId,
            provider:
              session.voiceEngine === 'hybrid'
                ? session.ttsProvider === 'custom'
                  ? 'custom-cascade'
                  : 'cartesia-cascade'
                : 'gemini-live',
            model: session.model,
            status: 'success',
            input_tokens: session.inputTokens,
            output_tokens: session.outputTokens,
            total_tokens: session.totalTokens,
            cost: rawCost,
            latency_ms: durationSeconds * 1000,
            trace: {
              type: 'voice_session',
              engine: session.voiceEngine,
              duration_seconds: durationSeconds,
              voice_name: session.voiceName,
              interrupted_count: session.interruptedCount,
            } as any,
          },
        });
      }

      // 3. Registra voice_session_telemetry
      if (session.conversationId) {
        const stats = session.gateSession?.getStats();
        await this.prisma.voice_session_telemetry.create({
          data: {
            company_id: session.companyId,
            client_id: session.clientId,
            conversation_id: session.conversationId,
            duration_sec: durationSeconds,
            hangup_cause:
              reason || (session.pendingAiHangup ? 'ai_completed' : null),
            audio_gate_forwarded_sec: stats?.forwardedSec ?? 0,
            audio_gate_suppressed_sec: stats?.suppressedSec ?? 0,
            audio_gate_closes: stats?.closes ?? 0,
            interrupted_count: session.interruptedCount,
            hybrid_stt_utterances: session.hybridSttUtterances,
            hybrid_stt_fallback_count: session.hybridSttFallbacks,
            total_tokens: session.totalTokens,
            input_tokens: session.inputTokens,
            output_tokens: session.outputTokens,
            turns: session.auditTurn.count,
            exchange_rate: this.pricingService.getExchangeRate(),
            cost_usd: rawCost,
            cost_brl: Number(
              (rawCost * this.pricingService.getExchangeRate()).toFixed(4),
            ),
            model: session.model,
            voice_name: session.voiceName,
            audio_gate_enabled: session.gateSession?.enabled ?? false,
          },
        });

        this.logger.log(
          `📊 [VoiceTelemetry] Sessão registrada: ${durationSeconds}s | Gate: +${stats?.forwardedSec ?? 0}s / -${stats?.suppressedSec ?? 0}s silêncio | Custo: $${rawCost}`,
        );
      }
    } catch (err: any) {
      this.logger.error(`Erro ao persistir telemetria de voz`);
    } finally {
      if (session.conversationId)
        await finalizeVoiceConversation(
          this.prisma,
          session.conversationId,
        ).catch(() =>
          this.logger.error('Voice finalization persistence failed'),
        );
    }
  }
}
