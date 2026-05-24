import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  health() {
    return {
      status: 'ready',
      message: 'Orchestrator module is running',
    };
  }

  async deleteSession(clientPhone: string, companyPhone: string) {
    this.logger.warn({ clientPhone, companyPhone }, '[DEPRECATED] deleteSession called - legacy sessions removed');
    return true;
  }
}
