import { DeadLetterProcessor } from './dead-letter.processor';

describe('DeadLetterProcessor', () => {
  it('persists Bull job IDs without treating them as UUID aggregate IDs', async () => {
    const prisma = {
      outbox_events: { create: jest.fn().mockResolvedValue({}) },
    };
    const processor = new DeadLetterProcessor(prisma as never);
    const job = {
      data: {
        original_queue: 'agent-processing',
        original_job_id: '1',
        job_name: 'process-with-agent',
        data: {
          company_id: '00000000-0000-0000-0000-000000000001',
          client_id: '00000000-0000-0000-0000-000000000002',
        },
        failed_reason: 'provider failure',
        failed_stacktrace: [],
        attempts: 3,
        failed_at: new Date().toISOString(),
      },
    };

    await processor.process(job as never);

    expect(prisma.outbox_events.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        company_id: '00000000-0000-0000-0000-000000000001',
        client_id: '00000000-0000-0000-0000-000000000002',
        aggregate_id: null,
      }),
    });
  });

  it('acknowledges malformed jobs without a company context', async () => {
    const prisma = {
      outbox_events: { create: jest.fn() },
    };
    const processor = new DeadLetterProcessor(prisma as never);
    const job = {
      data: {
        original_queue: 'media-processing',
        original_job_id: '2',
        job_name: 'process-media',
        data: {},
        failed_reason: 'invalid payload',
        failed_stacktrace: [],
        attempts: 3,
        failed_at: new Date().toISOString(),
      },
    };

    await expect(processor.process(job as never)).resolves.toBeUndefined();
    expect(prisma.outbox_events.create).not.toHaveBeenCalled();
  });
});
