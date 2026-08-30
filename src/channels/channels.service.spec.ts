import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ChannelsService } from './services/channels.service';
import { WebhooksService } from '../webhooks/services/webhooks.service';
import { TextAiExecutionService } from '../queue/text-ai-execution.service';

describe('ChannelsService - corridas de escrita', () => {
  const buildService = (prisma: any) => {
    const webhooksService = { deliver: jest.fn() } as unknown as WebhooksService;
    const textAi = {
      dispatchIngestion: jest
        .fn()
        .mockResolvedValue({ mode: 'inline', run_id: 'run-1' }),
    } as unknown as TextAiExecutionService;
    const service = new ChannelsService(
      prisma as never,
      webhooksService,
      textAi,
      { channelType: 'whatsapp', normalize: jest.fn().mockReturnValue({}) } as never,
      { channelType: 'api', normalize: jest.fn().mockReturnValue({}) } as never,
    );
    return service;
  };

  const inboundDto: any = {
    client_id: 'client-1',
    origin_channel: 'whatsapp',
    external_user_id: '5511999999999',
    conversation_key: 'wa:key-1',
    message: { type: 'text', text: 'Olá' },
    idempotency_key: 'idem-1',
  };

  it('processInbound converte P2002 em 400 Duplicate idempotency_key', async () => {
    const prisma = {
      channel_connections: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'conn-1',
          company_id: 'company-1',
          client_id: 'client-1',
          channel_type: 'whatsapp',
        }),
      },
      inbound_events: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: '5.22.0',
          }),
        ),
      },
    };
    const service = buildService(prisma);

    await expect(service.processInbound(inboundDto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('resolveEndUser cria end_user + identity atomicamente e trata corrida', async () => {
    const existingIdentity = { end_user_id: 'end-user-existing' };
    const prisma = {
      channel_identities: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(existingIdentity),
        create: jest.fn(),
      },
      end_users: { create: jest.fn() },
      $transaction: jest.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup identity', {
          code: 'P2002',
          clientVersion: '5.22.0',
        }),
      ),
    };
    const service = buildService(prisma);

    const result = await (service as any).resolveEndUser(
      {
        id: 'conn-1',
        company_id: 'company-1',
        client_id: 'client-1',
        channel_type: 'whatsapp',
      } as any,
      inboundDto,
    );

    expect(result).toBe('end-user-existing');
    // nada de end_user órfão: create roda dentro da transação que deu rollback
    expect(prisma.end_users.create).not.toHaveBeenCalled();
  });

  it('resolveEndUser cria end_user dentro da transação em caminho feliz', async () => {
    const prisma = {
      channel_identities: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      end_users: { create: jest.fn() },
      $transaction: jest.fn().mockImplementation(async (fn: any) =>
        fn({
          end_users: {
            create: jest.fn().mockResolvedValue({ id: 'end-user-new' }),
          },
          channel_identities: {
            create: jest.fn().mockResolvedValue({ id: 'identity-1' }),
          },
        }),
      ),
    };
    const service = buildService(prisma);

    const result = await (service as any).resolveEndUser(
      {
        id: 'conn-1',
        company_id: 'company-1',
        client_id: 'client-1',
        channel_type: 'whatsapp',
      } as any,
      inboundDto,
    );

    expect(result).toBe('end-user-new');
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
  });
});
