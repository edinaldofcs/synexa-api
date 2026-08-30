import { CredentialsController } from './credentials.controller';
import { randomBytes } from 'crypto';

jest.mock('crypto', () => ({
  randomBytes: jest.fn(() => ({
    toString: () => 'a'.repeat(64),
  })),
}));

describe('CredentialsController - secret exposure', () => {
  const prisma = {
    channel_connections: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    painel_clients: { findFirst: jest.fn() },
  };
  const controller = new CredentialsController(prisma as never);
  const user = { id: 'user-1', company_id: 'company-1', role: 'company_admin' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('listKeys', () => {
    it('never returns inbound_secret_hash in listing', async () => {
      prisma.channel_connections.findMany.mockResolvedValue([
        {
          id: 'conn-1',
          company_id: 'company-1',
          client_id: 'client-1',
          channel_type: 'api',
          provider: 'custom_api',
          status: 'active',
          inbound_secret_hash: 'sk_raw_secret',
          painel_clients: { company_name: 'Acme' },
        },
        {
          id: 'conn-2',
          channel_type: 'api',
          inbound_secret_hash: null,
        },
      ]);

      const result = await controller.listKeys(user);

      expect(result[0]).not.toHaveProperty('inbound_secret_hash');
      expect(result[0]).toEqual(
        expect.objectContaining({ id: 'conn-1', has_secret: true }),
      );
      expect(result[1]).toHaveProperty('has_secret', false);
 expect(JSON.stringify(result)).not.toContain('sk_raw_secret');
    });
  });

  describe('rotateKey', () => {
    it('returns the new secret exactly once and persists hash', async () => {
      prisma.channel_connections.findFirst.mockResolvedValue({
        id: 'conn-1',
        client_id: 'client-1',
      });
      prisma.channel_connections.update.mockResolvedValue({ id: 'conn-1' });

      const result = await controller.rotateKey(user, 'conn-1');

      expect(result).toEqual({
        id: 'conn-1',
        client_id: 'client-1',
        inbound_secret: 'sk_' + 'a'.repeat(64),
      });
      expect(prisma.channel_connections.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ inbound_secret_hash: 'sk_' + 'a'.repeat(64) }),
        }),
      );
      expect(randomBytes).toHaveBeenCalledWith(32);
    });

    it('rejects rotation of connection from another tenant', async () => {
      prisma.channel_connections.findFirst.mockResolvedValue(null);

      await expect(
        controller.rotateKey(user, 'other-conn'),
      ).rejects.toMatchObject({ status: 404 });
 expect(prisma.channel_connections.update).not.toHaveBeenCalled();
    });
  });

  describe('createApiConnection', () => {
    it('returns one-time secret without echoing the stored hash', async () => {
      prisma.painel_clients.findFirst.mockResolvedValue({ id: 'client-1' });
      prisma.channel_connections.findFirst.mockResolvedValue(null);
      prisma.channel_connections.create.mockResolvedValue({
        id: 'conn-new',
        client_id: 'client-1',
        channel_type: 'api',
        status: 'active',
        inbound_secret_hash: 'sk_' + 'a'.repeat(64),
      });

      const result = await controller.createApiConnection(user, 'client-1');

      expect(result).toEqual({
        id: 'conn-new',
        client_id: 'client-1',
        channel_type: 'api',
        status: 'active',
        inbound_secret: 'sk_' + 'a'.repeat(64),
      });
    });
  });
});
