import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { OperatorPresenceService } from './operator-presence.service';

@Injectable()
export class HandoffDistributorService {
  private readonly logger = new Logger(HandoffDistributorService.name);
  private readonly OFFLINE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos sem heartbeat

  constructor(
    private readonly prisma: PrismaService,
    private readonly presenceService: OperatorPresenceService,
  ) {}

  /**
   * Distribui uma conversa para o operador online com menor carga
   */
  async distribute(
    conversationId: string,
    companyId: string,
    clientId?: string | null,
  ): Promise<string | null> {
    const availableOperatorIds =
      await this.presenceService.listAvailable(companyId);

    if (!availableOperatorIds || availableOperatorIds.length === 0) {
      this.logger.log(
        { conversation_id: conversationId, company_id: companyId },
        'Nenhum operador disponível para novos atendimentos. Conversa mantida na fila de espera.',
      );
      await this.prisma.conversations.update({
        where: { id: conversationId },
        data: { assigned_to: null },
      });
      return null;
    }

    // Determina capacidade máxima configurada no cliente (ou padrão)
    let maxCapacity = Infinity;
    if (clientId) {
      const client = await this.prisma.painel_clients.findUnique({
        where: { id: clientId },
        select: { metadata: true },
      });
      const meta = (client?.metadata as any) || {};
      if (
        meta.max_concurrent_chats &&
        typeof meta.max_concurrent_chats === 'number'
      ) {
        maxCapacity = meta.max_concurrent_chats;
      }
    }

    // Busca operadores válidos e suas cargas de atendimento
    const operators = await this.prisma.users.findMany({
      where: {
        id: { in: availableOperatorIds },
        company_id: companyId,
      },
      select: { id: true, name: true },
    });

    if (operators.length === 0) {
      return null;
    }

    // Contagem de conversas ativas para cada operador
    const loads = await Promise.all(
      operators.map(async (op) => {
        const activeCount = await this.prisma.conversations.count({
          where: {
            company_id: companyId,
            mode: 'manual',
            status: 'active',
            assigned_to: op.id,
          },
        });
        return {
          operatorId: op.id,
          name: op.name,
          activeCount,
        };
      }),
    );

    // Filtra operadores que ainda possuem capacidade disponível
    const eligible = loads.filter((op) => op.activeCount < maxCapacity);

    if (eligible.length === 0) {
      this.logger.warn(
        { conversation_id: conversationId },
        `Todos os ${operators.length} operadores online atingiram a capacidade máxima (${maxCapacity}). Conversa na fila.`,
      );
      await this.prisma.conversations.update({
        where: { id: conversationId },
        data: { assigned_to: null },
      });
      return null;
    }

    // Ordena pelo operador com MENOR número de atendimentos ativos
    eligible.sort((a, b) => a.activeCount - b.activeCount);
    const selectedOperator = eligible[0];

    await this.prisma.conversations.update({
      where: { id: conversationId },
      data: {
        assigned_to: selectedOperator.operatorId,
      },
    });

    await this.prisma.message_events.create({
      data: {
        company_id: companyId,
        client_id: clientId || null,
        conversation_id: conversationId,
        event_type: 'handoff.assigned',
        status: 'manual',
        payload: {
          assigned_to: selectedOperator.operatorId,
          operator_name: selectedOperator.name,
          active_chats_count: selectedOperator.activeCount + 1,
          algorithm: 'least_loaded_round_robin',
        } as any,
      },
    });

    this.logger.log(
      {
        conversation_id: conversationId,
        assigned_to: selectedOperator.operatorId,
        operator_name: selectedOperator.name,
      },
      `Conversa atribuída automaticamente ao operador ${selectedOperator.name}`,
    );

    return selectedOperator.operatorId;
  }

  /**
   * Verifica se operadores atribuídos estão offline há mais de 5 minutos
   * e redistribui seus atendimentos
   */
  async checkAndRedistributeAbandoned(companyId: string): Promise<void> {
    const activeManualConvs = await this.prisma.conversations.findMany({
      where: {
        company_id: companyId,
        mode: 'manual',
        status: 'active',
        assigned_to: { not: null },
      },
      select: {
        id: true,
        client_id: true,
        assigned_to: true,
      },
    });

    const now = Date.now();

    for (const conv of activeManualConvs) {
      if (!conv.assigned_to) continue;

      const isOnline = await this.presenceService.isOnline(
        conv.assigned_to,
        companyId,
      );

      if (!isOnline) {
        const lastSeen = await this.presenceService.getLastSeen(
          conv.assigned_to,
        );
        const isExceededTimeout =
          !lastSeen || now - lastSeen > this.OFFLINE_TIMEOUT_MS;

        if (isExceededTimeout) {
          this.logger.warn(
            { conversation_id: conv.id, operator_id: conv.assigned_to },
            'Operador desconectado há mais de 5 minutos. Redistribuindo atendimento.',
          );

          await this.prisma.message_events.create({
            data: {
              company_id: companyId,
              client_id: conv.client_id,
              conversation_id: conv.id,
              event_type: 'handoff.redistributed_timeout',
              status: 'manual',
              payload: {
                previous_operator_id: conv.assigned_to,
                reason: 'operator_offline_over_5_minutes',
              } as any,
            },
          });

          // Tenta redistribuir para o próximo operador online
          await this.distribute(conv.id, companyId, conv.client_id);
        }
      }
    }
  }

  /**
   * Tenta distribuir conversas da fila de espera que estão sem operador
   */
  async redistributeQueue(companyId: string): Promise<void> {
    const unassignedConvs = await this.prisma.conversations.findMany({
      where: {
        company_id: companyId,
        mode: 'manual',
        status: 'active',
        assigned_to: null,
      },
      select: { id: true, client_id: true },
      orderBy: { created_at: 'asc' },
    });

    for (const conv of unassignedConvs) {
      await this.distribute(conv.id, companyId, conv.client_id);
    }
  }
}
