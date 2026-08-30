import {
  acquireSseStream,
  releaseSseStream,
  parseMaxConcurrentStreams,
  sseStreamKey,
  SSE_STREAM_TTL_SECONDS,
} from './sse-stream-counter.util';

describe('sse-stream-counter.util (S05)', () => {
  let client: { incr: jest.Mock; decr: jest.Mock; expire: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    client = {
      incr: jest.fn().mockResolvedValue(1),
      decr: jest.fn().mockResolvedValue(0),
      expire: jest.fn().mockResolvedValue(1),
    };
  });

  describe('acquireSseStream', () => {
    it('should INCR the per-user counter and set EX 120', async () => {
      client.incr.mockResolvedValue(3);

      const count = await acquireSseStream(client as any, 'user-1');

      expect(count).toBe(3);
      expect(client.incr).toHaveBeenCalledWith('sse:streams:user-1');
      expect(client.expire).toHaveBeenCalledWith(
        'sse:streams:user-1',
        SSE_STREAM_TTL_SECONDS,
      );
    });

    it('should use key format sse:streams:<userId>', () => {
      expect(sseStreamKey('abc-123')).toBe('sse:streams:abc-123');
    });
  });

  describe('releaseSseStream', () => {
    it('should DECR the counter in finally paths', async () => {
      await releaseSseStream(client as any, 'user-1');

      expect(client.decr).toHaveBeenCalledWith('sse:streams:user-1');
    });

    it('should not propagate Redis errors (key expires via EX 120)', async () => {
      client.decr.mockRejectedValue(new Error('redis down'));

      await expect(
        releaseSseStream(client as any, 'user-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('parseMaxConcurrentStreams', () => {
    it('should parse valid positive values', () => {
      expect(parseMaxConcurrentStreams('10')).toBe(10);
    });

    it('should default to 5 when unset/invalid', () => {
      expect(parseMaxConcurrentStreams(undefined)).toBe(5);
      expect(parseMaxConcurrentStreams('')).toBe(5);
      expect(parseMaxConcurrentStreams('abc')).toBe(5);
      expect(parseMaxConcurrentStreams('0')).toBe(5);
      expect(parseMaxConcurrentStreams('-3')).toBe(5);
    });
  });
});
