import { Prisma } from '@prisma/client';

/** Preserve billable usage while removing personal content and conversation links. */
export async function anonymizeConversationConsumption(
  tx: Prisma.TransactionClient,
  companyId: string,
  conversationIds: string[],
) {
  const where = {
    company_id: companyId,
    conversation_id: { in: conversationIds },
  };
  const runs = await tx.agent_runs.updateMany({
    where,
    data: {
      conversation_id: null,
      inbound_message_id: null,
      response_message_id: null,
      trace: Prisma.DbNull,
      error_message: null,
      request_id: null,
    },
  });
  const telemetry = await tx.voice_session_telemetry.updateMany({
    where,
    data: {
      conversation_id: null,
      asterisk_unique_id: null,
      caller_number: null,
      did_number: null,
      hangup_cause: null,
      metadata: Prisma.DbNull,
    },
  });
  return { runs: runs.count, telemetry: telemetry.count };
}
