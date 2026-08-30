import { BadRequestException } from '@nestjs/common';
import { ApisService } from './apis.service';

jest.mock('../common/utils/ssrf-guard', () => ({
  validateWebhookUrl: jest.fn(),
}));

import { validateWebhookUrl } from '../common/utils/ssrf-guard';

const mockedValidate = validateWebhookUrl as jest.Mock;

describe('ApisService - testProxy (SSRF)', () => {
  const build = () => {
    const apisRepository = {
      create: jest.fn(),
      findAllByClient: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    const metadataService = { refresh: jest.fn() };
    const prisma = {
      painel_clients: { findUnique: jest.fn() },
    };
    const service = new ApisService(
      apisRepository as never,
      metadataService as never,
      prisma as never,
    );
    return service;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn() as never;
  });

  it('rejeita URL sem http/https', async () => {
    const service = build();
    await expect(service.testProxy({ url: '/api/internal' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejeita URL http://127.0.0.1 (SSRF guard)', async () => {
    mockedValidate.mockRejectedValue(
      new BadRequestException('Access to private/internal IP is not allowed'),
    );
    const service = build();

    await expect(
      service.testProxy({ url: 'http://127.0.0.1:3000/api/tables' }),
    ).rejects.toThrow(BadRequestException);

    expect(mockedValidate).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/tables',
      expect.any(Boolean),
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('não converte mais URL relativa em localhost (removido)', async () => {
    mockedValidate.mockRejectedValue(
      new BadRequestException('Invalid URL format'),
    );
    const service = build();

    await expect(service.testProxy({ url: '/api/secret' })).rejects.toThrow(
      BadRequestException,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('executa fetch em URL pública válida', async () => {
    mockedValidate.mockResolvedValue(undefined);
    (global.fetch as jest.Mock).mockResolvedValue({
      status: 200,
      statusText: 'OK',
      text: async () => '{"ok":true}',
    });
    const service = build();

    const result = await service.testProxy({
      url: 'https://api.example.com/v1/data',
      method: 'GET',
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/data',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('propaga falha de rede como resultado estruturado (sem throw)', async () => {
    mockedValidate.mockResolvedValue(undefined);
    (global.fetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));
    const service = build();

    const result = await service.testProxy({
      url: 'https://down.example.com',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });
});
