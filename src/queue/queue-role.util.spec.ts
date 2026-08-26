import { getSourceQueuesForRole } from './queue-role.util';
import {
  QUEUE_AGENT,
  QUEUE_DISPATCHER,
  QUEUE_INGESTION,
  QUEUE_KNOWLEDGE,
  QUEUE_MEDIA,
  QUEUE_WEBHOOK,
} from './queue.constants';

describe('getSourceQueuesForRole', () => {
  it('maps each specialist worker to only its source queue', () => {
    expect(getSourceQueuesForRole('worker-agent')).toEqual([QUEUE_AGENT]);
    expect(getSourceQueuesForRole('worker-media')).toEqual([QUEUE_MEDIA]);
    expect(getSourceQueuesForRole('worker-webhook')).toEqual([QUEUE_WEBHOOK]);
    expect(getSourceQueuesForRole('worker-dlq')).toEqual([]);
  });

  it('maps the legacy all-workers role to all source queues', () => {
    expect(getSourceQueuesForRole('worker-all')).toEqual([
      QUEUE_INGESTION,
      QUEUE_AGENT,
      QUEUE_DISPATCHER,
      QUEUE_MEDIA,
      QUEUE_KNOWLEDGE,
      QUEUE_WEBHOOK,
    ]);
  });

  it('does not activate an unknown role', () => {
    expect(getSourceQueuesForRole('unknown')).toEqual([]);
  });
});
