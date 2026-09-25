import { Prisma } from '@prisma/client';
import { encrypt } from '../../common/utils/crypto.util';
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma/prisma.service';
const logger = new Logger('VoiceHeartbeat');
/** A stale lease lets the delivery worker recover calls lost with a process crash. */
export function startVoiceHeartbeat(
  prisma: PrismaService,
  id: string,
): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    void (async () => {
      try {
        await prisma.conversations.updateMany({
          where: { id, status: 'active' },
          data: { voice_heartbeat_at: new Date() },
        });
      } catch {
        logger.error(
          { conversation_id: id },
          'Voice heartbeat persistence failed',
        );
      }
    })();
  }, 15000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Enroll atomically at call creation; later endpoint changes cannot lose an export. */
export async function createVoiceConversation(
  prisma: PrismaService,
  args: Prisma.conversationsCreateArgs,
) {
  return prisma.$transaction(async (tx) => {
    const conversation = await tx.conversations.create({
      ...args,
      data: { ...args.data, voice_heartbeat_at: new Date() },
    });
    const endpoint = conversation.client_id
      ? await tx.webhook_endpoints.findFirst({
          where: {
            client_id: conversation.client_id,
            enabled: true,
            events: { array_contains: 'call.completed' },
          },
        })
      : null;
    if (endpoint) {
      const policy = (endpoint.retry_policy || {}) as Record<string, unknown>;
      const retentionHours = Math.max(
        1,
        Math.min(168, Number(policy.retention_hours) || 24),
      );
      await tx.call_exports.create({
        data: {
          conversation_id: conversation.id,
          company_id: conversation.company_id,
          client_id: conversation.client_id!,
          endpoint_id: endpoint.id,
          status: 'collecting',
          expires_at: new Date(Date.now() + retentionHours * 3600000),
          destination_enc: encrypt(
            JSON.stringify({
              url: endpoint.url,
              secret: endpoint.secret_hash,
              include_transcript: policy.include_transcript === true,
              retention_hours: retentionHours,
            }),
            process.env.ENCRYPTION_KEY || '',
          ),
        },
      });
    }
    return { ...conversation, exportEnabled: !!endpoint };
  });
}

export async function finalizeVoiceConversation(
  prisma: PrismaService,
  id: string,
) {
  await prisma.conversations.updateMany({
    where: { id, voice_finalized_at: null },
    data: {
      status: 'closed',
      closed_at: new Date(),
      voice_finalized_at: new Date(),
    },
  });
}
