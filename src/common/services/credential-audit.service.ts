import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface LogCredentialActionParams {
  companyId: string;
  clientId: string;
  userId?: string;
  provider: string;
  action: 'created' | 'updated' | 'rotated' | 'revoked' | 'viewed' | 'tested';
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class CredentialAuditService {
  private readonly logger = new Logger(CredentialAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async logAction(params: LogCredentialActionParams): Promise<void> {
    try {
      // Garante que nenhuma chave bruta ou secreta vaze no metadata de auditoria
      const safeMetadata = this.sanitizeAuditMetadata(params.metadata || {});

      await this.prisma.credential_audit_logs.create({
        data: {
          company_id: params.companyId,
          client_id: params.clientId,
          user_id: params.userId || null,
          provider: params.provider.toLowerCase(),
          action: params.action,
          ip_address: params.ipAddress || null,
          user_agent: params.userAgent || null,
          metadata: safeMetadata as any,
        },
      });
    } catch (error) {
      this.logger.warn(
        {
          error: (error as Error).message,
          provider: params.provider,
          action: params.action,
        },
        'Falha não-bloqueante ao registrar log de auditoria de credencial',
      );
    }
  }

  private sanitizeAuditMetadata(
    meta: Record<string, unknown>,
  ): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (/key|secret|token|password|auth/i.test(k) && typeof v === 'string') {
        clean[k] =
          v.length > 8 ? `${v.slice(0, 4)}...${v.slice(-4)}` : '********';
      } else {
        clean[k] = v;
      }
    }
    return clean;
  }
}
