import { Test, TestingModule } from '@nestjs/testing';
import { CredentialAuditService } from './credential-audit.service';
import { PrismaService } from '../prisma/prisma.service';

describe('CredentialAuditService', () => {
  let service: CredentialAuditService;
  let prisma: {
    credential_audit_logs: {
      create: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      credential_audit_logs: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialAuditService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<CredentialAuditService>(CredentialAuditService);
  });

  it('deve registrar ação de auditoria com metadados sanitizados', async () => {
    await service.logAction({
      companyId: 'company-1',
      clientId: 'client-1',
      userId: 'user-1',
      provider: 'GROQ',
      action: 'created',
      ipAddress: '127.0.0.1',
      metadata: {
        raw_key: 'gsk_1234567890abcdef',
        enabled_models_count: 3,
      },
    });

    expect(prisma.credential_audit_logs.create).toHaveBeenCalledWith({
      data: {
        company_id: 'company-1',
        client_id: 'client-1',
        user_id: 'user-1',
        provider: 'groq',
        action: 'created',
        ip_address: '127.0.0.1',
        user_agent: null,
        metadata: {
          raw_key: 'gsk_...cdef',
          enabled_models_count: 3,
        },
      },
    });
  });

  it('não deve lançar exceção se falhar ao gravar log', async () => {
    prisma.credential_audit_logs.create.mockRejectedValue(
      new Error('DB Error'),
    );

    await expect(
      service.logAction({
        companyId: 'company-1',
        clientId: 'client-1',
        provider: 'gemini',
        action: 'updated',
      }),
    ).resolves.not.toThrow();
  });
});
