import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { sanitize } from '../common/utils/sanitize-log.util';
import { OrchestratorSessionService } from './services/session.service';
import { OrchestratorAgentService } from './services/agent.service';
import { OrchestratorChatService } from './services/chat.service';

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    private readonly sessionService: OrchestratorSessionService,
    private readonly agentService: OrchestratorAgentService,
    private readonly chatService: OrchestratorChatService,
  ) {}

  health() {
    return {
      status: 'ready',
      message: 'Orchestrator module is running',
    };
  }

  async processChat(clientPhone: string, companyPhone: string, message: string) {
    this.logger.log({ clientPhone, companyPhone, message: sanitize(message) }, '[Chat] Parâmetros recebidos');

    const sessionData = await this.sessionService.processarSessao(clientPhone, companyPhone);
    const sessionId = (sessionData as any).sessionId as string;

    const resultado = await this.agentService.selecionarAgente(sessionData, companyPhone);

    if (resultado.needsSessionUpdate && resultado.newStep) {
      await this.sessionService.updateSession(clientPhone, companyPhone, { current_step: resultado.newStep });
    }

    const agentConfig = await this.agentService.getAgentConfig(
      resultado.response_number,
      undefined,
      resultado.etapa_atendimento,
    );

    if (!agentConfig) {
      return { error: 'Configuração do agente não encontrada' };
    }

    const history = await this.sessionService.getChatHistory(sessionId);
    await this.sessionService.saveMessage(sessionId, 'user', message);

    const systemPrompt = this.agentService.buildAgentPrompt(agentConfig, sessionData!);
    const clientId = agentConfig.client_id;
    const personaId = agentConfig.persona_id;

    const aiResponse = await this.chatService.sendToAgent(
      systemPrompt,
      message,
      history,
      clientPhone,
      companyPhone,
      clientId,
      personaId,
    );

    const responseText = aiResponse.text || '';
    const action = aiResponse.action || 'speak';

    this.sessionService.saveMessage(sessionId, 'assistant', responseText)
      .catch(err => this.logger.error(`Erro ao salvar resposta: ${err.message}`));

    return { text: responseText, action };
  }

  async processWebhook(message: string, clientId: string, phone: string, requestOrigin?: string) {
    this.logger.log({ clientId, phone }, '[Webhook] Parâmetros recebidos');

    if (message.toLowerCase() === 'clear') {
      await this.sessionService.deleteClientConfig(phone, phone);
      return { success: true, message: 'Chat resetado com sucesso' };
    }

    const finalCompanyPhone = phone;
    const sessionData = await this.sessionService.processarSessao(phone, finalCompanyPhone);
    const sessionId = (sessionData as any).sessionId as string;

    const resultado = await this.agentService.selecionarAgente(sessionData, finalCompanyPhone);

    if (resultado.needsSessionUpdate && resultado.newStep) {
      await this.sessionService.updateSession(phone, finalCompanyPhone, { current_step: resultado.newStep });
    }

    const agentConfig = await this.agentService.getAgentConfig(
      resultado.response_number,
      undefined,
      resultado.etapa_atendimento,
    );

    if (!agentConfig) {
      return { error: 'Configuração do agente não encontrada' };
    }

    const history = await this.sessionService.getChatHistory(sessionId);
    await this.sessionService.saveMessage(sessionId, 'user', message);

    const systemPrompt = this.agentService.buildAgentPrompt(agentConfig, sessionData!);
    const dbClientId = agentConfig.client_id;
    const personaId = agentConfig.persona_id;

    const aiResponse = await this.chatService.sendToAgent(
      systemPrompt,
      message,
      history,
      phone,
      finalCompanyPhone,
      dbClientId,
      personaId,
    );

    const responseText = aiResponse.text || '';
    const action = aiResponse.action || 'speak';

    await this.sessionService.saveMessage(sessionId, 'assistant', responseText);

    const now = new Date();
    const messageDate = now.toISOString().split('T')[0] + 'T03:00:00.000Z';
    const messageTime = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const modelUsed = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

    const userPayload = {
      id: uuidv4(),
      client_id: clientId,
      session_id: sessionId,
      message_date: messageDate,
      message_time: messageTime,
      identifier: phone,
      intention: ((sessionData as any).intent as string) || 'NI01',
      message,
      message_type: 'User',
      request_origin: requestOrigin || 'api',
      metadata: null,
      created_at: now.toISOString(),
      agent_name: agentConfig.agent_name || 'Inicio',
      model: modelUsed,
    };

    const agentPayload = {
      id: uuidv4(),
      client_id: clientId,
      session_id: sessionId,
      message_date: messageDate,
      message_time: messageTime,
      identifier: phone,
      intention: ((sessionData as any).intent as string) || 'NI01',
      message: responseText,
      message_type: 'Agent',
      request_origin: requestOrigin || 'api',
      metadata: null,
      created_at: now.toISOString(),
      agent_name: agentConfig.agent_name || 'Inicio',
      model: modelUsed,
    };

    return [userPayload, agentPayload];
  }

  async deleteSession(clientPhone: string, companyPhone: string) {
    await this.sessionService.deleteClientConfig(clientPhone, companyPhone);
    return true;
  }
}
