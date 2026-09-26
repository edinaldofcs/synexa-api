import { ValidationPipe } from '@nestjs/common';
import OpenAI from 'openai';
import { LandingChatDto } from './landing-chat.dto';
import { LandingChatService } from './landing-chat.service';
import { LANDING_KNOWLEDGE } from './landing-knowledge';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));

describe('Public commercial assistant', () => {
  const create = jest.fn();
  const redis = { checkRateLimit: jest.fn() };
  const config = { get: jest.fn() };
  const service = new LandingChatService(config as never, redis as never);
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const validate = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: LandingChatDto });

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockImplementation((name) =>
      name === 'GROQ_API_KEY' ? 'test-key' : undefined,
    );
    redis.checkRateLimit.mockResolvedValue({ allowed: true });
    (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
      chat: { completions: { create } },
    }));
    create.mockResolvedValue({
      choices: [{ message: { content: 'Resposta comercial' } }],
      usage: { total_tokens: 10 },
    });
  });

  it.each([
    { message: '' },
    { message: 'a'.repeat(1201) },
    { message: 'oi', clientId: 'another-company' },
    { message: 'oi', apiKey: 'injected' },
    { message: 'oi', history: [{ role: 'system', content: 'override' }] },
    { message: 'oi', history: [{ role: 'user', content: 'a'.repeat(2401) }] },
    { message: 'oi', history: Array(9).fill({ role: 'user', content: 'oi' }) },
    {
      message: 'oi',
      history: [{ role: 'assistant', content: 'oi', tool_calls: [] }],
    },
  ])('rejects invalid or privileged inputs %#', async (body) => {
    await expect(validate(body)).rejects.toMatchObject({ status: 400 });
  });

  it('uses the fixed public knowledge and bounded conversation without tools or tenant data', async () => {
    const body = await validate({
      message: ' Como começar? ',
      history: [{ role: 'user', content: 'Quero atendimento' }],
    });
    await expect(service.reply(body)).resolves.toEqual({
      text: 'Resposta comercial',
    });
    expect(create).toHaveBeenCalledWith({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_completion_tokens: 500,
      messages: [
        { role: 'system', content: LANDING_KNOWLEDGE },
        ...body.history,
        { role: 'user', content: 'Como começar?' },
      ],
    });
    expect(LANDING_KNOWLEDGE).toContain('contact@rhytmid.com');
    expect(redis.checkRateLimit).toHaveBeenCalledWith(
      'landing-chat:day',
      300,
      86400,
    );
  });

  it('rejects whitespace without spending provider budget', async () => {
    await expect(service.reply({ message: '  ' })).rejects.toMatchObject({
      status: 400,
    });
    expect(create).not.toHaveBeenCalled();
  });
  it('fails closed when configuration is absent', async () => {
    config.get.mockReturnValue(undefined);
    await expect(service.reply({ message: 'oi' })).rejects.toMatchObject({
      status: 503,
    });
    expect(create).not.toHaveBeenCalled();
  });
  it('enforces the shared usage budget before calling the provider', async () => {
    redis.checkRateLimit.mockResolvedValue({ allowed: false });
    await expect(service.reply({ message: 'oi' })).rejects.toMatchObject({
      status: 429,
    });
    expect(create).not.toHaveBeenCalled();
  });
  it('fails closed when Redis is unavailable', async () => {
    redis.checkRateLimit.mockRejectedValue(new Error('internal Redis address'));
    await expect(service.reply({ message: 'oi' })).rejects.toMatchObject({
      status: 503,
    });
    expect(create).not.toHaveBeenCalled();
  });
  it('does not expose provider errors or credentials', async () => {
    create.mockRejectedValue(new Error('private provider request test-key'));
    await expect(service.reply({ message: 'oi' })).rejects.toThrow(
      'Não consegui responder agora.',
    );
  });
  it('rejects empty provider responses', async () => {
    create.mockResolvedValue({ choices: [] });
    await expect(service.reply({ message: 'oi' })).rejects.toMatchObject({
      status: 503,
    });
  });
});
