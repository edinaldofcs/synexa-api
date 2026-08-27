import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ImpersonateDto } from './impersonate.dto';

describe('ImpersonateDto', () => {
  it.each([
    ['v4 padrão', '11111111-1111-4111-8111-111111111111'],
    ['legado de seeds (v0)', '00000000-0000-0000-0000-000000000001'],
    ['legado com sufixo hex (v0)', '00000000-0000-0000-0000-00000000000b'],
    ['maiúsculas', '00000000-0000-0000-0000-00000000000B'],
  ])('aceita UUID %s', async (_label, company_id) => {
    const dto = plainToInstance(ImpersonateDto, { company_id });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it.each([
    ['texto livre', 'nao-e-uuid'],
    ['uuid curto demais', '00000000-0000-0000-0000-00000000000'],
    ['string vazia', ''],
  ])('rejeita %s como company_id', async (_label, company_id) => {
    const dto = plainToInstance(ImpersonateDto, { company_id });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejeita payload sem company_id', async () => {
    const dto = plainToInstance(ImpersonateDto, {});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
