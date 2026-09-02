import { OrchestratorController } from './orchestrator.controller';
import type { Response } from 'express';

const baseDto = {
  message: 'ola',
  provider: 'groq',
  model: 'llama-3.3-70b-versatile',
  clientId: 'client-1',
};

function mockRes(): Response & { json: jest.Mock; status: jest.Mock } {
  const res: any = {
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    on: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
  };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('OrchestratorController - SSE stream cap (S05)', () => {
  let controller: OrchestratorController;
  let testChatService: {
    send: jest.Mock;
    clear: jest.Mock;
    listModels: jest.Mock;
  };
  let redisClient: { incr: jest.Mock; decr: jest.Mock; expire: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    testChatService = {
      send: jest.fn().mockResolvedValue({ text: 'ok' }),
      clear: jest.fn().mockResolvedValue({ cleared: true }),
      listModels: jest.fn().mockResolvedValue([]),
    };
    redisClient = {
      incr: jest.fn().mockResolvedValue(1),
      decr: jest.fn().mockResolvedValue(0),
      expire: jest.fn().mockResolvedValue(1),
    };
    controller = new OrchestratorController(
      {} as any,
      {} as any,
      testChatService as any,
      { getClient: () => redisClient } as any,
    );
  });

  it('should return 429 BEFORE starting the pipeline when the cap is reached', async () => {
    process.env.LLM_MAX_CONCURRENT_STREAMS = '5';
    redisClient.incr.mockResolvedValue(6); // 5 slots ocupados + este

    const res = mockRes();
    await controller.testChatStream(
      { id: 'user-1', company_id: 'company-1', role: 'operator' },
      baseDto,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Too many concurrent streams',
    });
    // desfaz o INCR e nunca inicia o pipeline
    expect(redisClient.decr).toHaveBeenCalledWith('sse:streams:user-1');
    expect(testChatService.send).not.toHaveBeenCalled();
    delete process.env.LLM_MAX_CONCURRENT_STREAMS;
  });

  it('should proceed and release the slot in finally when under the cap', async () => {
    process.env.LLM_MAX_CONCURRENT_STREAMS = '5';
    redisClient.incr.mockResolvedValue(2);

    const res = mockRes();
    await controller.testChatStream(
      { id: 'user-1', company_id: 'company-1', role: 'operator' },
      baseDto,
      res,
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(testChatService.send).toHaveBeenCalledTimes(1);
    expect(redisClient.decr).toHaveBeenCalledWith('sse:streams:user-1');
    delete process.env.LLM_MAX_CONCURRENT_STREAMS;
  });

  it('should not touch the Redis counter when there is no authenticated user', async () => {
    const res = mockRes();
    await controller.testChatStream(undefined, baseDto, res);

    expect(redisClient.incr).not.toHaveBeenCalled();
    expect(redisClient.decr).not.toHaveBeenCalled();
    expect(testChatService.send).toHaveBeenCalledTimes(1);
    expect(testChatService.send).toHaveBeenCalledWith(
      baseDto,
      expect.any(Function),
      undefined,
    );
  });
});
