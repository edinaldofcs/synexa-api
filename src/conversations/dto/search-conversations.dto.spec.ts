import { ValidationPipe } from '@nestjs/common';
import { SearchConversationsDto } from './search-conversations.dto';

describe('SearchConversationsDto', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const parse = (value: unknown) =>
    pipe.transform(value, { type: 'query', metatype: SearchConversationsDto });

  it('converts query parameters and supplies bounded defaults', async () => {
    await expect(parse({})).resolves.toMatchObject({ page: 1, limit: 50 });
    await expect(parse({ page: '2', limit: '20' })).resolves.toMatchObject({
      page: 2,
      limit: 20,
    });
  });

  it.each([
    { page: '0' },
    { page: '1.5' },
    { limit: '101' },
    { client_id: 'invalid' },
    { start: 'invalid' },
    { filter: 'unknown' },
    { search: 'x'.repeat(201) },
    { company_id: 'untrusted-tenant' },
  ])('rejects invalid or unsupported input: %j', async (query) => {
    await expect(parse(query)).rejects.toThrow();
  });
});
