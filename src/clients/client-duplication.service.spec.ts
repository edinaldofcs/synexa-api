import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'crypto';
import {
  ClientDuplicationService,
  remapFlowReferences,
} from './client-duplication.service';
import { DuplicateClientDto } from './dto/duplicate-client.dto';

describe('Flow duplication contract', () => {
  it('remaps nested references and UUID keys while preserving literal prompt text', () => {
    const old = randomUUID(),
      next = randomUUID();
    expect(
      remapFlowReferences(
        {
          [old]: {
            allowed_subagents: [old],
            rules: [{ next_api_id: old }],
            prompt: `Mention ${old} literally`,
          },
        },
        new Map([[old, next]]),
      ),
    ).toEqual({
      [next]: {
        allowed_subagents: [next],
        rules: [{ next_api_id: next }],
        prompt: `Mention ${old} literally`,
      },
    });
  });
  it('accepts an empty legacy body and trims names and numbers', async () => {
    expect(
      await validate(plainToInstance(DuplicateClientDto, {})),
    ).toHaveLength(0);
    const dto = plainToInstance(DuplicateClientDto, {
      company_name: ' Copy ',
      endpoints: [{ source_endpoint_id: randomUUID(), did_number: ' 8000 ' }],
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.company_name).toBe('Copy');
    expect(dto.endpoints![0].did_number).toBe('8000');
  });
  it('rejects blank names, invalid endpoint IDs and nested unknown properties', async () => {
    const dto = plainToInstance(DuplicateClientDto, {
      company_name: ' ',
      endpoints: [
        { source_endpoint_id: 'bad', did_number: '', company_id: randomUUID() },
      ],
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['company_name', 'endpoints']),
    );
  });
  it('rejects access without admin permissions before reading source credentials', async () => {
    const prisma = { painel_clients: { findFirst: jest.fn() } };
    const service = new ClientDuplicationService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
    );
    await expect(
      service.preview(randomUUID(), {
        id: randomUUID(),
        company_id: randomUUID(),
        role: 'operator',
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(prisma.painel_clients.findFirst).not.toHaveBeenCalled();
  });
});
