import { buildCallExportPayload } from './call-export-payload';
import { validate } from 'class-validator';
import { CallPreviewDto } from '../dto/call-preview.dto';
import {
  CreateWebhookEndpointDto,
  UpdateWebhookEndpointDto,
} from '../dto/create-webhook-endpoint.dto';

it('v3 delivers collected values only, while preserving transport and usage', () => {
  const payload = buildCallExportPayload({
    eventId: 'event',
    companyId: 'tenant',
    clientId: 'client',
    conversation: {
      id: 'conversation',
      current_agent_id: 'agent',
      started_at: new Date(0),
      metadata: { session_record: { nome: 'ignored' }, ai_summary: 'ignored' },
    },
    endedAt: new Date(60000),
    telemetry: {
      duration_sec: 60,
      total_tokens: 25,
      cost_usd: 0.1,
      caller_number: 'transport',
      did_number: 'dialed',
      hangup_cause: 'normal',
    },
    variables: {
      cpf: '00123',
      cpc: false,
      acordo: 0,
      promessa: null,
      Lista: [1, false],
      Objeto: { report_target: 'free' },
      _execution: {},
      current_agent_id: 'hidden',
    },
    tools: [],
  });
  expect(payload.schema_version).toBe(3);
  expect(payload.call).toMatchObject({
    duration_seconds: 60,
    end_reason: 'normal',
    agent_id: 'agent',
    caller_number: 'transport',
    dialed_number: 'dialed',
    usage: { total_tokens: 25, estimated_cost_usd: 0.1 },
    variables: {
      cpf: '00123',
      cpc: false,
      acordo: 0,
      promessa: null,
      Lista: [1, false],
      Objeto: { report_target: 'free' },
    },
  });
  for (const key of [
    'customer_name',
    'customer_identifier',
    'summary',
    'transcript',
    'tools',
  ])
    expect(payload.call).not.toHaveProperty(key);
  expect(payload.call.variables).not.toHaveProperty('current_agent_id');
});

it.each([CallPreviewDto, CreateWebhookEndpointDto, UpdateWebhookEndpointDto])(
  'rejects v1 and v2 in %p',
  async (Dto) => {
    for (const version of [1, 2]) {
      const errors = await validate(
        Object.assign(new Dto(), { payload_version: version }),
      );
      expect(errors.some((error) => error.property === 'payload_version')).toBe(
        true,
      );
    }
    const errors = await validate(
      Object.assign(new Dto(), { payload_version: 3 }),
    );
    expect(errors.some((error) => error.property === 'payload_version')).toBe(
      false,
    );
  },
);
