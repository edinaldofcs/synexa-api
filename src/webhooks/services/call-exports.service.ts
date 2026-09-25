import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, call_exports } from '@prisma/client';
import { createHmac, randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { encrypt, decrypt } from '../../common/utils/crypto.util';
import { postCallExport } from './call-export-transport';
import { QueueService } from '../../queue/queue.service';
import { MediaService } from '../../media/media.service';

type Destination = {
  url: string;
  secret: string;
  include_transcript: boolean;
  retention_hours: number;
};

@Injectable()
export class CallExportsService implements OnModuleInit {
  private readonly logger = new Logger(CallExportsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly queue: QueueService,
    private readonly media: MediaService,
  ) {}

  async onModuleInit() {
    await this.queue.scheduleCallExports();
  }

  /** PostgreSQL is the source of truth; the repeatable job contains no call data. */
  async sweep() {
    const rows = await this.prisma.call_exports.findMany({
      where: {
        purged_at: null,
        next_attempt_at: { lte: new Date() },
        OR: [{ lease_until: null }, { lease_until: { lt: new Date() } }],
      },
      orderBy: { next_attempt_at: 'asc' },
      take: 50,
    });
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(5, rows.length) }, async () => {
        while (cursor < rows.length) {
          const row = rows[cursor++];
          await this.process(row.id);
        }
      }),
    );
  }

  async process(id: string) {
    const token = randomUUID();
    const acquired = await this.prisma.call_exports.updateMany({
      where: {
        id,
        purged_at: null,
        OR: [{ lease_until: null }, { lease_until: { lt: new Date() } }],
      },
      data: { lease_token: token, lease_until: new Date(Date.now() + 120000) },
    });
    if (!acquired.count) return;
    const renewal = setInterval(() => {
      void this.update(id, token, {
        lease_until: new Date(Date.now() + 120000),
      }).catch(() => undefined);
    }, 30000);
    renewal.unref();
    try {
      let row = await this.prisma.call_exports.findUniqueOrThrow({
        where: { id },
      });
      if (row.status === 'collecting') {
        const prepared = await this.prepare(row, token);
        if (!prepared) return;
        row = prepared;
      }
      if (row.status === 'pending' && row.expires_at <= new Date()) {
        await this.update(id, token, {
          status: 'expired',
          error_code: 'retention_expired',
        });
        row.status = 'expired';
        this.logger.error(
          { event_id: id },
          'Call export expired without acknowledgement',
        );
      }
      if (row.status === 'pending') {
        await this.send(row, token);
        row = await this.prisma.call_exports.findUniqueOrThrow({
          where: { id },
        });
      }
      if (row.status === 'delivered' || row.status === 'expired')
        await this.purge(row, token);
    } catch {
      // Never retain receiver response bodies, secrets or conversation content in errors.
      await this.update(id, token, {
        error_code: 'processing_failed',
        next_attempt_at: new Date(Date.now() + 30000),
      });
      this.logger.error({ event_id: id }, 'Call export requires retry');
    } finally {
      clearInterval(renewal);
      await this.update(id, token, { lease_until: null, lease_token: null });
    }
  }

  private update(
    id: string,
    token: string,
    data: Prisma.call_exportsUpdateManyMutationInput,
  ) {
    return this.prisma.call_exports.updateMany({
      where: { id, lease_token: token },
      data,
    });
  }

  private async prepare(
    row: call_exports,
    token: string,
  ): Promise<call_exports | null> {
    let conversation = await this.prisma.conversations.findFirst({
      where: {
        id: row.conversation_id,
        company_id: row.company_id,
        client_id: row.client_id,
      },
    });
    if (!conversation) {
      await this.update(row.id, token, {
        status: 'expired',
        error_code: 'source_missing',
        expires_at: new Date(),
      });
      return this.prisma.call_exports.findUniqueOrThrow({
        where: { id: row.id },
      });
    }
    const recoveredCall = !conversation.voice_finalized_at;
    const stale = new Date(Date.now() - 120000);
    if (!conversation.voice_finalized_at) {
      // Heartbeat is created atomically with enrollment. Recover only enrolled calls.
      const recovered = await this.prisma.conversations.updateMany({
        where: {
          id: conversation.id,
          voice_finalized_at: null,
          voice_heartbeat_at: { lt: stale },
        },
        data: {
          status: 'closed',
          closed_at: conversation.closed_at || conversation.voice_heartbeat_at,
          voice_finalized_at: new Date(),
        },
      });
      if (!recovered.count) {
        await this.update(row.id, token, {
          next_attempt_at: new Date(Date.now() + 15000),
        });
        return null;
      }
      conversation = await this.prisma.conversations.findUniqueOrThrow({
        where: { id: conversation.id },
      });
    }
    const destination: Destination = JSON.parse(
      decrypt(row.destination_enc!, this.key()),
    );
    const [state, interaction, messages, tools] = await Promise.all([
      this.prisma.conversation_state.findUnique({
        where: { conversation_id: conversation.id },
      }),
      this.prisma.painel_interactions.findUnique({
        where: { session_id: conversation.id },
      }),
      destination.include_transcript
        ? this.prisma.messages.findMany({
            where: { conversation_id: conversation.id },
            select: { sender_type: true, content: true, created_at: true },
            orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
          })
        : Promise.resolve(undefined),
      this.prisma.tool_calls.findMany({
        where: { conversation_id: conversation.id },
        select: {
          tool_name: true,
          status: true,
          result: true,
          completed_at: true,
        },
        orderBy: { created_at: 'asc' },
      }),
    ]);
    const metadata = (conversation.metadata || {}) as Record<string, unknown>;
    const endedAt = conversation.closed_at || conversation.voice_finalized_at!;
    const payload = {
      schema_version: 1,
      event: 'call.completed',
      event_id: row.id,
      occurred_at: endedAt.toISOString(),
      company_id: row.company_id,
      client_id: row.client_id,
      call: {
        id: conversation.id,
        external_id: interaction?.call_id || metadata.call_id || null,
        started_at: conversation.started_at,
        ended_at: endedAt,
        duration_seconds:
          interaction?.duration_seconds ??
          Math.max(
            0,
            Math.round(
              (endedAt.getTime() -
                (conversation.started_at || endedAt).getTime()) /
                1000,
            ),
          ),
        end_reason: recoveredCall
          ? 'connection_lost'
          : interaction?.hangup_cause || metadata.hangup_cause || 'completed',
        agent_id:
          interaction?.agent_id ||
          metadata.agent_id ||
          conversation.current_agent_id ||
          null,
        caller_number: metadata.caller || null,
        dialed_number: metadata.did || interaction?.company_identifier || null,
        customer_identifier: interaction?.client_identifier || null,
        customer_name: interaction?.client_name || null,
        variables: state?.state || interaction?.context_variables || {},
        summary: interaction?.summary || null,
        transcript: messages,
        tools,
        usage: interaction
          ? {
              total_tokens: interaction.total_tokens,
              estimated_cost_usd: interaction.estimated_cost_usd,
            }
          : null,
      },
    };
    await this.update(row.id, token, {
      status: 'pending',
      payload_enc: encrypt(JSON.stringify(payload), this.key()),
      expires_at: new Date(
        endedAt.getTime() + destination.retention_hours * 3600000,
      ),
      next_attempt_at: new Date(),
    });
    return this.prisma.call_exports.findUniqueOrThrow({
      where: { id: row.id },
    });
  }

  private key() {
    return this.config.get<string>('ENCRYPTION_KEY', '');
  }

  private async send(row: call_exports, token: string) {
    const destination: Destination = JSON.parse(
      decrypt(row.destination_enc!, this.key()),
    );
    const body = decrypt(row.payload_enc!, this.key());
    const timestamp = String(Math.floor(Date.now() / 1000));
    let httpStatus: number | null = null;
    let delivered = false;
    try {
      httpStatus = await postCallExport(destination.url, body, {
        'Content-Type': 'application/json',
        'X-Synexa-Event': 'call.completed',
        'X-Synexa-Event-Id': row.id,
        'X-Synexa-Timestamp': timestamp,
        'X-Synexa-Signature': `sha256=${createHmac('sha256', destination.secret).update(`${timestamp}.${body}`).digest('hex')}`,
      });
      delivered = httpStatus >= 200 && httpStatus < 300;
    } catch {
      /* Fixed error codes only; no remote body or URL in logs. */
    }
    const attempt = row.attempt + 1;
    const next = Math.min(
      row.expires_at.getTime(),
      Date.now() + Math.min(3600000, 5000 * 2 ** Math.min(attempt - 1, 10)),
    );
    await this.update(row.id, token, {
      attempt,
      http_status: httpStatus,
      status: delivered ? 'delivered' : 'pending',
      delivered_at: delivered ? new Date() : null,
      error_code: delivered ? null : 'delivery_failed',
      next_attempt_at: new Date(next),
    });
  }

  private async purge(row: call_exports, token: string) {
    // Remove storage before database references so a storage failure remains retryable.
    const owned = await this.prisma.call_exports.count({
      where: { id: row.id, lease_token: token },
    });
    if (!owned) return;
    await this.media.purgeConversationAssets(
      row.conversation_id,
      row.company_id,
    );
    await this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.call_exports.updateMany({
          where: { id: row.id, lease_token: token },
          data: { lease_until: new Date(Date.now() + 120000) },
        });
        if (!locked.count) return;
        const scope = {
          conversation_id: row.conversation_id,
          company_id: row.company_id,
        };
        await tx.tool_calls.deleteMany({ where: scope });
        // Preserve numeric consumption used by billing; remove trace and links to content.
        await tx.agent_runs.updateMany({
          where: scope,
          data: { trace: Prisma.DbNull, error_message: null, request_id: null },
        });
        await tx.webhook_deliveries.deleteMany({
          where: { conversation_id: row.conversation_id },
        });
        await tx.outbox_events.deleteMany({
          where: {
            company_id: row.company_id,
            aggregate_id: row.conversation_id,
          },
        });
        await tx.painel_interactions.updateMany({
          where: {
            session_id: row.conversation_id,
            company_id: row.company_id,
          },
          data: {
            client_identifier: null,
            company_identifier: null,
            client_name: null,
            agent_name: null,
            debt_amount: null,
            agreement_id: null,
            agreement_amount: null,
            payment_method: null,
            promise_due_date: null,
            promise_amount: null,
            recording_url: null,
            call_id: null,
            summary: null,
            sentiment: null,
            messages: [],
            context_variables: {},
            disposition: null,
            service_step: null,
            tagcode: null,
            hangup_cause: null,
            has_human_answer: false,
            human_answered_at: null,
            is_right_party: false,
            right_party_at: null,
            is_debt_presented: false,
            debt_presented_at: null,
            is_agreement_reached: false,
            agreement_at: null,
            is_promise_to_pay: false,
            promise_to_pay_at: null,
          },
        });
        await tx.voice_session_telemetry.updateMany({
          where: scope,
          data: {
            conversation_id: null,
            asterisk_unique_id: null,
            caller_number: null,
            did_number: null,
            hangup_cause: null,
            metadata: Prisma.DbNull,
          },
        });
        await tx.conversations.deleteMany({
          where: { id: row.conversation_id, company_id: row.company_id },
        });
        await tx.call_exports.updateMany({
          where: { id: row.id, lease_token: token },
          data: {
            payload_enc: null,
            destination_enc: null,
            purged_at: new Date(),
            error_code:
              row.status === 'expired'
                ? row.error_code === 'source_missing'
                  ? 'source_missing'
                  : 'retention_expired'
                : null,
          },
        });
      },
      { timeout: 30000, maxWait: 10000 },
    );
  }
}
