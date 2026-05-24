import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class OrchestratorToolService {
  private readonly logger = new Logger(OrchestratorToolService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getActiveTools(client_id: string, persona_id: string) {
    const agent = await this.prisma.painel_agents.findUnique({
      where: { id: persona_id },
      select: { allowed_tool_names: true },
    });

    const allowedNames = (agent?.allowed_tool_names as string[])?.filter(Boolean) || [];

    const where: any = { client_id, active: true };
    if (allowedNames.length > 0) {
      where.name = { in: allowedNames };
    } else {
      where.agent_id = persona_id;
    }

    const tools = await this.prisma.painel_apis.findMany({ where }) as any[];

    if (tools.length === 0) {
      this.logger.warn({ client_id, persona_id }, 'Nenhuma ferramenta ativa encontrada');
    }

    return tools.map(tool => ({
      name: tool.name,
      next_tool: tool.next_tool,
      visible_to_agent: tool.visible_to_agent,
      description: tool.description,
      endpoint: tool.url,
      method: tool.method,
      parameters: tool.parameters,
      request_body_template: tool.body,
      headers: tool.headers,
      extract_data: tool.extract_data,
    }));
  }
}
