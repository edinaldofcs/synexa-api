import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class ClientsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(payload: Record<string, unknown>) {
    return this.prisma.painel_clients.create({
      data: payload as any,
      include: { companies: { select: { max_concurrent_calls: true } } },
    });
  }

  async findAll() {
    return this.prisma.painel_clients.findMany({
      orderBy: { id: 'asc' },
    });
  }

  async findOne(id: string) {
    const client = await this.prisma.painel_clients.findUnique({
      where: { id },
    });
    if (!client) throw new NotFoundException(`Client with ID ${id} not found`);
    return client;
  }

  async update(id: string, payload: Record<string, unknown>) {
    return this.prisma.painel_clients.update({
      where: { id },
      data: payload as any,
    });
  }

  async remove(id: string) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Limpar eventos de entrada do cliente
      await tx.inbound_events.deleteMany({
        where: { client_id: id },
      });

      // 2. Limpar entregas de webhooks associadas aos endpoints do cliente
      const endpoints = await tx.webhook_endpoints.findMany({
        where: { client_id: id },
        select: { id: true },
      });
      if (endpoints.length > 0) {
        const endpointIds = endpoints.map((ep) => ep.id);
        await tx.webhook_deliveries.deleteMany({
          where: { webhook_endpoint_id: { in: endpointIds } },
        });
      }

      // 3. Limpar endpoints de webhook do cliente
      await tx.webhook_endpoints.deleteMany({
        where: { client_id: id },
      });

      // 4. Limpar conversas do cliente (mensagens e estados são deletados em cascata)
      await tx.conversations.deleteMany({
        where: { client_id: id },
      });

      // 5. Limpar conexões de canal do cliente
      await tx.channel_connections.deleteMany({
        where: { client_id: id },
      });

      // 6. Limpar identidades de canal vinculadas ao cliente
      await tx.channel_identities.deleteMany({
        where: { client_id: id },
      });

      // 7. Limpar usuários finais (end_users) do cliente
      await tx.end_users.deleteMany({
        where: { client_id: id },
      });

      // 8. Deletar o cliente em painel_clients
      // As demais tabelas (painel_agents, painel_apis, painel_tracks, media_assets,
      // telephony_endpoints, provider_credentials, knowledge_*, etc.) possuem
      // ON DELETE CASCADE configurado no banco de dados.
      await tx.painel_clients.delete({
        where: { id },
      });

      return { success: true };
    });
  }
}
