import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { TabulationService } from './tabulation.service';

@Injectable()
export class TabulationSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TabulationSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly tabulationService: TabulationService,
  ) {}

  onModuleInit() {
    // Inicia o loop periódico a cada 60 segundos
    const intervalMs = 60_000;
    this.timer = setInterval(() => {
      void this.runTabulationCycle();
    }, intervalMs);

    this.logger.log('TabulationSchedulerService iniciado (intervalo: 60s)');
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Executa um ciclo de verificação e tabulação assíncrona
   */
  async runTabulationCycle(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    // Lock distribuído no Redis (TTL de 50s)
    const lockKey = 'tabulation:scheduler:lock';
    const acquired = await this.redis.acquireLock(lockKey, 50);
    if (!acquired) {
      this.logger.debug('Ciclo de tabulação ignorado: lock já adquirido por outra instância.');
      return;
    }

    this.isRunning = true;
    try {
      await this.processPendingConversations();
    } catch (err) {
      this.logger.error(`Erro ao executar ciclo de tabulação: ${(err as Error).message}`, (err as Error).stack);
    } finally {
      this.isRunning = false;
      await this.redis.releaseLock(lockKey).catch(() => {});
    }
  }

  private async processPendingConversations(): Promise<void> {
    // Buscar clientes ativos e seus respectivos tempos de inatividade
    const clients = await this.prisma.painel_clients.findMany({
      select: {
        id: true,
        tabulation_inactivity_minutes: true,
      },
    });

    const clientInactivityMap = new Map<string, number>();
    for (const c of clients) {
      clientInactivityMap.set(c.id, c.tabulation_inactivity_minutes || 30);
    }

    // Buscar conversas que podem ser candidatas:
    // 1. Fechadas (status = 'closed') e (nunca tabuladas ou com novas mensagens após tabulação)
    // 2. Abertas com last_message_at presente
    const candidateConversations = await this.prisma.conversations.findMany({
      where: {
        client_id: { not: null },
        last_message_at: { not: null },
        OR: [
          // Fechadas e desatualizadas
          {
            status: 'closed',
          },
          // Abertas
          {
            status: { not: 'closed' },
          },
        ],
      },
      select: {
        id: true,
        client_id: true,
        status: true,
        last_message_at: true,
        tabulated_at: true,
      },
      orderBy: { last_message_at: 'asc' },
      take: 50,
    });

    const now = Date.now();
    const eligibleIds: string[] = [];

    for (const conv of candidateConversations) {
      if (!conv.client_id || !conv.last_message_at) continue;

      const lastMsgTime = conv.last_message_at.getTime();
      const tabTime = conv.tabulated_at ? conv.tabulated_at.getTime() : null;

      // Se já foi tabulada e não teve mensagem posterior, já está em dia
      if (tabTime && lastMsgTime <= tabTime) {
        continue;
      }

      if (conv.status === 'closed') {
        // Conversa fechada é elegível imediatamente
        eligibleIds.push(conv.id);
      } else {
        // Conversa aberta: checar se ultrapassou o período de inatividade
        const inactivityMins = clientInactivityMap.get(conv.client_id) || 30;
        const inactivityMs = inactivityMins * 60 * 1000;
        const elapsedSinceLastMsg = now - lastMsgTime;

        if (elapsedSinceLastMsg >= inactivityMs) {
          eligibleIds.push(conv.id);
        }
      }

      // Limitar lote por ciclo para preservar recursos
      if (eligibleIds.length >= 20) {
        break;
      }
    }

    if (eligibleIds.length === 0) {
      return;
    }

    this.logger.log(`Encontradas ${eligibleIds.length} conversas elegíveis para tabulação.`);

    for (const convId of eligibleIds) {
      try {
        await this.tabulationService.tabulateConversation(convId);
      } catch (err) {
        this.logger.error(`Falha ao tabular conversa ${convId}: ${(err as Error).message}`);
      }
    }
  }
}
