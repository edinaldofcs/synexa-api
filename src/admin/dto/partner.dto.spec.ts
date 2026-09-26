import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ActivatePartnerDto,
  CompanyVoiceLimitDto,
  CreatePartnerDto,
} from './partner.dto';

describe('Partner input validation', () => {
  it.each([56, 64])(
    'accepts the Supabase invitation hash format: %s hex characters',
    async (size) => {
      const dto = plainToInstance(ActivatePartnerDto, {
        tokenHash: 'a'.repeat(size),
        verificationType: 'invite',
        password: 'Valid-test-password123',
      });
      expect(await validate(dto)).toHaveLength(0);
    },
  );
  it.each([0, -1, 1.5, 1001, '5', null, undefined])(
    'rejects invalid limits: %s',
    async (maxConcurrentCalls) => {
      expect(
        await validate(
          plainToInstance(CompanyVoiceLimitDto, { maxConcurrentCalls }),
        ),
      ).not.toHaveLength(0);
    },
  );
  it.each([1, 5, 1000])(
    'accepts an integer within capacity bounds: %s',
    async (maxConcurrentCalls) => {
      expect(
        await validate(
          plainToInstance(CompanyVoiceLimitDto, { maxConcurrentCalls }),
        ),
      ).toHaveLength(0);
    },
  );
  it('trims names and rejects empty or malformed company invitations', async () => {
    const dto = plainToInstance(CreatePartnerDto, {
      companyName: ' ',
      adminName: ' ',
      email: 'invalid',
      delivery: 'other',
    });
    expect(await validate(dto)).toHaveLength(4);
  });
});
