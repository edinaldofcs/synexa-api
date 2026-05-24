import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../common/prisma/prisma.service';
import { OrchestrationService } from './orchestration.service';

@Injectable()
export class CompatibilityService {
  private readonly logger = new Logger(CompatibilityService.name);
  private readonly deprecationLogged = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrationService: OrchestrationService,
  ) {}

  private logDeprecation(endpoint: string) {
    if (!this.deprecationLogged.has(endpoint)) {
      this.logger.warn(
        { endpoint },
        `[DEPRECATED] ${endpoint} foi chamado. Use POST /api/public/messages no lugar. Este endpoint sera removido.`,
      );
      this.deprecationLogged.add(endpoint);
    }
  }

  async processChat(clientPhone: string, companyPhone: string, messageText: string) {
    this.logDeprecation('/orchestrator/chat');
    this.logger.log({ clientPhone, companyPhone }, '[Compat] processChat wrapper');

    const result = await this.routeToNewPipeline(clientPhone, companyPhone, messageText, 'whatsapp');
    return result;
  }

  async processWebhook(messageText: string, clientId: string, phone: string, requestOrigin?: string) {
    this.logDeprecation('/orchestrator/webhook/painel_message');
    this.logger.log({ clientId, phone }, '[Compat] processWebhook wrapper');

    const painelClient = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
    });

    if (!painelClient) {
      return { error: 'Cliente nao encontrado' };
    }

    if (messageText.toLowerCase() === 'clear') {
      await this.prisma.orchestrator_sessions.deleteMany({
        where: { client_phone: phone },
      });
      return { success: true, message: 'Chat resetado com sucesso' };
    }

    const companyPhone = painelClient.phone_number || phone;

    const connection = await this.prisma.channel_connections.findFirst({
      where: { client_id: clientId, channel_type: 'whatsapp' },
    });

    if (!connection) {
      this.logger.warn({ clientId }, '[Compat] No channel_connection found for client, using legacy flow');
      return { error: 'Canal WhatsApp nao configurado. Configure em Canais no painel enterprise.' };
    }

    const result = await this.routeToNewPipeline(phone, companyPhone, messageText, 'whatsapp', requestOrigin);
    const responseText = result.text || '';
    const now = new Date();
    const modelUsed = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

    const userPayload = {
      id: uuidv4(),
      client_id: clientId,
      session_id: `compat-${phone}`,
      message_date: now.toISOString().split('T')[0] + 'T03:00:00.000Z',
      message_time: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      identifier: phone,
      intention: 'NI01',
      message: messageText,
      message_type: 'User',
      request_origin: requestOrigin || 'api',
      metadata: null,
      created_at: now.toISOString(),
      agent_name: 'Compat',
      model: modelUsed,
    };

    const agentPayload = {
      id: uuidv4(),
      client_id: clientId,
      session_id: `compat-${phone}`,
      message_date: now.toISOString().split('T')[0] + 'T03:00:00.000Z',
      message_time: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      identifier: phone,
      intention: 'NI01',
      message: responseText,
      message_type: 'Agent',
      request_origin: requestOrigin || 'api',
      metadata: null,
      created_at: now.toISOString(),
      agent_name: 'Compat',
      model: modelUsed,
    };

    return [userPayload, agentPayload];
  }

  private async routeToNewPipeline(
    clientPhone: string,
    companyPhone: string,
    messageText: string,
    channelType: string,
    requestOrigin?: string,
  ) {
    let connection;

    if (channelType === 'whatsapp') {
      const painelClient = await this.prisma.painel_clients.findFirst({
        where: { phone_number: companyPhone },
      });

      if (painelClient) {
        connection = await this.prisma.channel_connections.findFirst({
          where: { client_id: painelClient.id, channel_type: 'whatsapp' },
        });
      }
    }

    if (!connection) {
      this.logger.warn({ clientPhone, companyPhone }, '[Compat] No channel_connection, falling back to legacy OrchestrationService');
      return { text: 'Canal nao configurado no novo pipeline. Configure o canal WhatsApp no painel.', action: 'speak' };
    }

    const endUserId = await this.resolveOrCreateEndUser(connection.company_id, connection.client_id, clientPhone);

    const conversation = await this.findOrCreateConversation(
      connection.company_id,
      connection.client_id,
      connection.id,
      endUserId,
      clientPhone,
    );

    const inboundMessage = await this.prisma.messages.create({
      data: {
        conversation_id: conversation.id,
        company_id: connection.company_id,
        sender_type: 'customer',
        channel: 'whatsapp',
        direction: 'inbound',
        message_type: 'text',
        content: messageText,
        status: 'received',
      },
    });

    const result = await this.orchestrationService.processMessage(
      conversation.id,
      inboundMessage.id,
      connection.company_id,
      connection.client_id,
      messageText,
      uuidv4(),
    );

    return { text: result.responseText, action: 'speak' };
  }

  private async resolveOrCreateEndUser(companyId: string, clientId: string, phone: string): Promise<string> {
    const identity = await this.prisma.channel_identities.findFirst({
      where: { client_id: clientId, channel_type: 'whatsapp', external_user_id: phone },
    });

    if (identity) return identity.end_user_id;

    const endUser = await this.prisma.end_users.create({
      data: { company_id: companyId, client_id: clientId },
    });

    await this.prisma.channel_identities.create({
      data: {
        company_id: companyId,
        client_id: clientId,
        end_user_id: endUser.id,
        channel_type: 'whatsapp',
        external_user_id: phone,
        normalized_phone: phone,
      },
    });

    return endUser.id;
  }

  private async findOrCreateConversation(
    companyId: string,
    clientId: string,
    channelConnectionId: string,
    endUserId: string,
    phone: string,
  ) {
    let conversation = await this.prisma.conversations.findFirst({
      where: {
        client_id: clientId,
        end_user_id: endUserId,
        status: 'active',
      },
      orderBy: { created_at: 'desc' },
    });

    if (!conversation) {
      conversation = await this.prisma.conversations.create({
        data: {
          company_id: companyId,
          client_id: clientId,
          channel_connection_id: channelConnectionId,
          end_user_id: endUserId,
          origin_channel: 'whatsapp',
          external_conversation_key: phone,
          status: 'active',
          mode: 'auto',
        },
      });
    }

    return conversation;
  }
}
