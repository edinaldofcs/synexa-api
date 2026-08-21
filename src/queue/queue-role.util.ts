import {
  QUEUE_AGENT,
  QUEUE_DISPATCHER,
  QUEUE_INGESTION,
  QUEUE_KNOWLEDGE,
  QUEUE_MEDIA,
} from './queue.constants';

const SOURCE_QUEUE_BY_ROLE: Record<string, string | undefined> = {
  'worker-ingestion': QUEUE_INGESTION,
  'worker-agent': QUEUE_AGENT,
  'worker-dispatcher': QUEUE_DISPATCHER,
  'worker-media': QUEUE_MEDIA,
  'worker-knowledge': QUEUE_KNOWLEDGE,
};

export function getSourceQueuesForRole(serviceRole: string): string[] {
  const role = serviceRole.toLowerCase();
  if (role === 'worker' || role === 'worker-all') {
    return [
      QUEUE_INGESTION,
      QUEUE_AGENT,
      QUEUE_DISPATCHER,
      QUEUE_MEDIA,
      QUEUE_KNOWLEDGE,
    ];
  }

  const queue = SOURCE_QUEUE_BY_ROLE[role];
  return queue ? [queue] : [];
}
