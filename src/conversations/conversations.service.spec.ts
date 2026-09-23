import { Prisma } from '@prisma/client';
import { ConversationsService } from './conversations.service';
import { InboundDataMapperService } from '../common/services/inbound-data-mapper.service';

jest.mock('../common/services/inbound-data-mapper.service', () => ({
  InboundDataMapperService: jest.fn().mockImplementation(() => ({
    mapInboundData: jest.fn().mockReturnValue({}),
  })),
}));

describe('ConversationsService - findOrCreate race (P2002)', () => {
  const conversationsRepo = {
    findByExternalKey: jest.fn(),
    findActiveByEndUser: jest.fn(),
    create: jest.fn(),
  };
  const prisma = {
    painel_clients: { findUnique: jest.fn().mockResolvedValue(null) },
    conversation_state: {
      upsert: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  const service = new ConversationsService(
    prisma as never,
    conversationsRepo as never,
    new InboundDataMapperService() as never,
    {} as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.painel_clients.findUnique.mockResolvedValue(null);
    conversationsRepo.findActiveByEndUser.mockResolvedValue(null);
    conversationsRepo.findByExternalKey.mockResolvedValue(null);
  });

  it('reaproveita conversa criada concorrentemente quando create falha com P2002', async () => {
    conversationsRepo.findByExternalKey.mockResolvedValue({
      id: 'conv-existing',
      company_id: 'company-1',
      client_id: 'client-1',
      status: 'active',
      mode: 'auto',
    });
    conversationsRepo.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (client_id, external_conversation_key)',
        { code: 'P2002', clientVersion: '5.22.0' },
      ),
    );

    const result = await service.findOrCreate({
      company_id: 'company-1',
      client_id: 'client-1',
      origin_channel: 'whatsapp',
      conversation_key: 'wa:55119999:msg123',
    } as any);

    expect(result.id).toBe('conv-existing');
    expect(result.status).toBe('active');
    expect(conversationsRepo.findByExternalKey).toHaveBeenCalledWith(
      'client-1',
      'wa:55119999:msg123',
    );
  });

  it('reaproveita conversa ativa e sincroniza inbound metadata no conversation_state', async () => {
    conversationsRepo.findActiveByEndUser.mockResolvedValue({
      id: 'conv-active-1',
      company_id: 'company-1',
      client_id: 'client-1',
      status: 'active',
      mode: 'auto',
    });
    prisma.conversation_state.findUnique.mockResolvedValue({
      conversation_id: 'conv-active-1',
      state: { anterior: 'antigo' },
    });

    const result = await service.findOrCreate({
      company_id: 'company-1',
      client_id: 'client-1',
      origin_channel: 'api',
      external_user_id: '+55119999',
      metadata: { cpf: '123.456.789-09' },
    } as any);

    expect(result.id).toBe('conv-active-1');
    expect(conversationsRepo.findActiveByEndUser).toHaveBeenCalledWith(
      'client-1',
      'api',
      '+55119999',
    );
  });

  it('repropaga P2002 quando a conversa concorrente não é encontrada', async () => {
    conversationsRepo.findByExternalKey.mockResolvedValue(null);
    const p2002 = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: '5.22.0',
    });
    conversationsRepo.create.mockRejectedValue(p2002);

    await expect(
      service.findOrCreate({
        company_id: 'company-1',
        client_id: 'client-1',
        origin_channel: 'whatsapp',
        conversation_key: 'wa:ghost',
      } as any),
    ).rejects.toThrow();
  });

  it('repropaga erros que não são P2002', async () => {
    conversationsRepo.findByExternalKey.mockResolvedValue(null);
    conversationsRepo.create.mockRejectedValue(new Error('db down'));

    await expect(
      service.findOrCreate({
        company_id: 'company-1',
        client_id: 'client-1',
        origin_channel: 'whatsapp',
        conversation_key: 'wa:x',
      } as any),
    ).rejects.toThrow('db down');
  });

  it('repropaga P2002 sem conversation_key (não há como reaproveitar por chave)', async () => {
    conversationsRepo.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '5.22.0',
      }),
    );

    await expect(
      service.findOrCreate({
        company_id: 'company-1',
        client_id: 'client-1',
        origin_channel: 'whatsapp',
      } as any),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
});
