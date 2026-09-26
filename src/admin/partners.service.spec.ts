import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { PartnersService } from './partners.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));

describe('PartnersService', () => {
  const identity = { id: 'new-user', email: 'partner@example.com' };
  const dto = {
    companyName: 'Partner',
    adminName: 'Partner Admin',
    email: ' PARTNER@example.com ',
    delivery: 'link' as const,
  };
  const profile = {
    ...identity,
    company_id: 'new-company',
    role: 'company_admin',
    invitation_pending: true,
    companies: { status: 'active' },
  };
  let prisma: any,
    auth: any,
    redis: any,
    sessions: any,
    service: PartnersService;

  beforeEach(() => {
    prisma = {
      users: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(identity),
        update: jest.fn(),
      },
      companies: {
        create: jest
          .fn()
          .mockResolvedValue({ id: 'new-company', name: 'Partner' }),
      },
      $transaction: jest.fn(async (fn) => fn(prisma)),
    };
    auth = {
      auth: {
        admin: {
          generateLink: jest.fn().mockResolvedValue({
            data: {
              user: identity,
              properties: {
                hashed_token: 'a'.repeat(64),
                redirect_to: 'https://app.example.com/activate-account',
              },
            },
            error: null,
          }),
          getUserById: jest
            .fn()
            .mockResolvedValue({ data: { user: identity }, error: null }),
          inviteUserByEmail: jest.fn().mockResolvedValue({ error: null }),
          updateUserById: jest.fn().mockResolvedValue({ error: null }),
        },
        verifyOtp: jest
          .fn()
          .mockResolvedValue({ data: { user: identity }, error: null }),
        getUser: jest
          .fn()
          .mockResolvedValue({ data: { user: identity }, error: null }),
      },
    };
    (createClient as jest.Mock).mockReturnValue(auth);
    redis = {
      acquireLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn(),
    };
    sessions = { destroyAllForUser: jest.fn() };
    const values = {
      AUTH_PROVIDER: 'supabase',
      SUPABASE_URL: 'https://auth.example.com',
      SUPABASE_SERVICE_ROLE_KEY: 'test-only',
      AUTH_FRONTEND_URL: 'https://app.example.com',
      ENVIRONMENT: 'production',
    };
    service = new PartnersService(
      prisma,
      { get: (key: string) => values[key] } as any,
      redis,
      sessions,
    );
  });

  it('cria empresa e administrador em transação sem enviar e-mail no modo link', async () => {
    const result = await service.create('owner', dto);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.users.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'partner@example.com',
          company_id: 'new-company',
          role: 'company_admin',
          invitation_pending: true,
        }),
      }),
    );
    expect(result.activationUrl).toContain(
      'https://app.example.com/activate-account#token=',
    );
    expect(result).not.toHaveProperty('password');
    expect(auth.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
    expect(redis.releaseLock).toHaveBeenCalled();
  });

  it('não cria duplicata nem altera outra empresa para e-mail existente', async () => {
    prisma.users.findUnique.mockResolvedValue(profile);
    await expect(service.create('owner', dto)).rejects.toThrow(
      ConflictException,
    );
    expect(auth.auth.admin.generateLink).not.toHaveBeenCalled();
    expect(prisma.companies.create).not.toHaveBeenCalled();
  });

  it('recusa criação concorrente antes de chamar o provedor', async () => {
    redis.acquireLock.mockResolvedValue(false);
    await expect(service.create('owner', dto)).rejects.toThrow(
      ConflictException,
    );
    expect(auth.auth.admin.generateLink).not.toHaveBeenCalled();
  });

  it('não cria empresa quando o provedor rejeita o convite', async () => {
    auth.auth.admin.generateLink.mockResolvedValue({ error: {}, data: {} });
    await expect(service.create('owner', dto)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('só envia e-mail quando solicitado e preserva cadastro em falha de entrega', async () => {
    prisma.users.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue(profile);
    auth.auth.admin.inviteUserByEmail.mockResolvedValue({
      error: { message: 'SMTP failed' },
    });
    const result = await service.create('owner', { ...dto, delivery: 'email' });
    expect(result.delivery).toBe('link');
    expect(result.message).toContain('falhou');
    expect(result).toHaveProperty('company');
    expect(result.activationUrl).toContain('#token=');
  });

  it('returns a direct link without sending mail when the provider rejects the activation redirect', async () => {
    prisma.users.findUnique.mockResolvedValue(profile);
    auth.auth.admin.generateLink.mockResolvedValue({
      data: {
        user: identity,
        properties: {
          hashed_token: 'a'.repeat(64),
          redirect_to: 'https://app.example.com/',
        },
      },
      error: null,
    });
    const result = await service.invite('owner', identity.id, 'email');
    expect(result.delivery).toBe('link');
    expect(auth.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'recusa reenvio para conta ativa/suspensa (%s)',
    async (suspended) => {
      prisma.users.findUnique.mockResolvedValue({
        ...profile,
        invitation_pending: suspended,
        companies: { status: suspended ? 'suspended' : 'active' },
      });
      await expect(
        service.invite('owner', identity.id, 'email'),
      ).rejects.toThrow(BadRequestException);
      expect(auth.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
    },
  );

  it('ativa a identidade verificada e invalida sessões anteriores', async () => {
    prisma.users.findUnique.mockResolvedValue(profile);
    await service.activate({
      tokenHash: 'a'.repeat(64),
      password: 'New-test-password123',
    });
    expect(auth.auth.admin.updateUserById).toHaveBeenCalledWith(identity.id, {
      password: 'New-test-password123',
      email_confirm: true,
    });
    expect(prisma.users.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ invitation_pending: false }),
      }),
    );
    expect(sessions.destroyAllForUser).toHaveBeenCalledWith(identity.id);
  });

  it('aceita a credencial do e-mail sem confiar em um ID enviado pelo navegador', async () => {
    prisma.users.findUnique.mockResolvedValue(profile);
    await service.activate({
      accessToken: 'opaque-session',
      password: 'New-test-password123',
    });
    expect(auth.auth.getUser).toHaveBeenCalledWith('opaque-session');
    expect(auth.auth.admin.updateUserById).toHaveBeenCalledWith(
      identity.id,
      expect.any(Object),
    );
  });

  it.each(['expired', 'used', 'suspended'])(
    'rejeita ativação %s sem alterar senha',
    async (reason) => {
      if (reason === 'expired')
        auth.auth.verifyOtp.mockResolvedValue({ error: {}, data: {} });
      prisma.users.findUnique.mockResolvedValue({
        ...profile,
        invitation_pending: reason !== 'used',
        companies: { status: reason === 'suspended' ? 'suspended' : 'active' },
      });
      await expect(
        service.activate({
          tokenHash: 'b'.repeat(64),
          password: 'New-test-password123',
        }),
      ).rejects.toThrow(UnauthorizedException);
      expect(auth.auth.admin.updateUserById).not.toHaveBeenCalled();
    },
  );
});
