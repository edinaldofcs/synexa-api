import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { sanitize } from '../../common/utils/sanitize-log.util';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

@Injectable()
export class OrchestratorSessionService {
  private readonly logger = new Logger(OrchestratorSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async processarSessao(client_phone: string, company_phone: string): Promise<Record<string, unknown>> {
    let sessionData = await this.redis.get<Record<string, unknown>>(`session:${client_phone}:${company_phone}`);

    if (sessionData) {
      this.logger.log({ client_phone, company_phone }, 'Sessão recuperada do Redis');
      return sessionData;
    }

    const sessionState = await this.prisma.orchestrator_sessions.findUnique({
      where: { client_phone_company_phone: { client_phone, company_phone } },
    });

    if (sessionState && sessionState.session_state) {
      const data = sessionState.session_state as Record<string, unknown>;
      await this.redis.set(`session:${client_phone}:${company_phone}`, data);
      return data;
    }

    const painelClient = await this.prisma.painel_clients.findFirst({
      where: { phone_number: company_phone },
      include: { painel_agents: true },
    });

    const configAtendimento = painelClient || {};
    const initialStatus = ((configAtendimento as any).metadata as Record<string, unknown>) || {};

    sessionData = {
      ...configAtendimento,
      ...initialStatus,
      sessionId: uuidv4(),
      client_phone,
      company_phone,
    } as Record<string, unknown>;

    delete (sessionData as any).status_inicio_atendimento;

    await this.redis.set(`session:${client_phone}:${company_phone}`, sessionData);

    await this.prisma.orchestrator_sessions.upsert({
      where: { client_phone_company_phone: { client_phone, company_phone } },
      update: { session_state: sessionData as any },
      create: { client_phone, company_phone, session_state: sessionData as any },
    });

    return sessionData;
  }

  async deleteClientConfig(client_phone: string, company_phone: string) {
    const sessionState = await this.prisma.orchestrator_sessions.findUnique({
      where: { client_phone_company_phone: { client_phone, company_phone } },
    });

    if (sessionState) {
      const sessionId = (sessionState.session_state as any)?.sessionId as string;
      if (sessionId) {
        await this.redis.del(`session:${client_phone}:${company_phone}`);
        await this.redis.del(`history:${sessionId}`);
        await this.prisma.orchestrator_chat_messages.deleteMany({ where: { session_id: sessionId } });
      }
      await this.prisma.orchestrator_sessions.delete({
        where: { client_phone_company_phone: { client_phone, company_phone } },
      });
    }

    await this.redis.del(`session:${client_phone}:${company_phone}`);
  }

  async getChatHistory(sessionId: string) {
    const cachedHistory = await this.redis.lrange<{ role: string; content: string }>(`history:${sessionId}`);

    if (cachedHistory && cachedHistory.length > 0) return cachedHistory;

    const messages = await this.prisma.orchestrator_chat_messages.findMany({
      where: { session_id: sessionId },
      orderBy: { id: 'asc' },
    });

    const mapped = messages.map(m => ({ role: m.role, content: m.content }));

    if (mapped.length > 0) {
      for (const msg of mapped) {
        await this.redis.rpush(`history:${sessionId}`, msg);
      }
    }

    return mapped || [];
  }

  async saveMessage(sessionId: string, role: string, content: string) {
    const newMessage = { role, content };

    await this.redis.rpush(`history:${sessionId}`, newMessage);

    this.prisma.orchestrator_chat_messages
      .create({ data: { session_id: sessionId, role, content } })
      .catch(err => this.logger.error(`Erro ao persistir mensagem: ${err.message}`));
  }

  async updateSession(client_phone: string, company_phone: string, extractedData: Record<string, unknown>) {
    const session = await this.processarSessao(client_phone, company_phone);
    if (!session) return session;

    const updatedKeys = extractedData ? Object.keys(extractedData) : [];
    this.logger.log({ client_phone, updatedFields: updatedKeys }, 'Atualizando variáveis na sessão');

    if (extractedData) {
      Object.assign(session, extractedData);
    }

    const sessionVariables = { ...session };
    delete sessionVariables.sessionId;
    delete sessionVariables.client_phone;
    delete sessionVariables.company_phone;

    this.logger.log({ client_phone, updatedFields: updatedKeys, currentSessionState: sanitize(sessionVariables) },
      '>>> ESTADO ATUALIZADO DO SESSION_STATE <<<');

    await this.redis.set(`session:${client_phone}:${company_phone}`, session);

    await this.prisma.orchestrator_sessions.upsert({
      where: { client_phone_company_phone: { client_phone, company_phone } },
      update: { session_state: session as any },
      create: { client_phone, company_phone, session_state: session as any },
    });

    const sid = (session as any).sessionId as string;
    this.saveMessage(sid, 'user', JSON.stringify({ dados_relevantes: extractedData }))
      .catch(err => this.logger.error(`Erro ao salvar log de atualização: ${err.message}`));

    return session;
  }
}
