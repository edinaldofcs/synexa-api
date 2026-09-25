import { validate } from 'class-validator';
import {
  CreateWebhookEndpointDto,
  UpdateWebhookEndpointDto,
} from './create-webhook-endpoint.dto';
it('validates retention, transcript type and client UUID', async () => {
  const input = Object.assign(new CreateWebhookEndpointDto(), {
    url: 'https://example.com',
    client_id: 'invalid',
    events: ['call.completed'],
    retention_hours: 0,
    include_transcript: 'false',
  });
  const errors = await validate(input);
  expect(errors.map((error) => error.property)).toEqual(
    expect.arrayContaining([
      'client_id',
      'retention_hours',
      'include_transcript',
    ]),
  );
});
it('allows partial updates without requiring unrelated settings', async () => {
  expect(
    await validate(
      Object.assign(new UpdateWebhookEndpointDto(), { enabled: false }),
    ),
  ).toHaveLength(0);
});
it('rejects an unbounded retention or empty event selection', async () => {
  expect(
    (
      await validate(
        Object.assign(new UpdateWebhookEndpointDto(), {
          events: [],
          retention_hours: 169,
        }),
      )
    ).map((error) => error.property),
  ).toEqual(expect.arrayContaining(['events', 'retention_hours']));
});
