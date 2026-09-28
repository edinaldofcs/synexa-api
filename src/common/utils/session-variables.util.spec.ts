import {
  projectCollectedVariables,
  readVariable,
  savedRequestVariables,
} from './session-variables.util';
import {
  rejectLegacyMetadata,
  validateExtraction,
} from './extraction-validation.util';

it('saves only configured outgoing values with exact destinations and JSON types', () => {
  expect(
    savedRequestVariables(
      {
        'person.doc': { save_to_session: true, session_variable: '{{CPF}}' },
        confirmed: { save_to_session: 'true' },
        total: { save_to_session: true },
        empty: { save_to_session: true },
        missing: { save_to_session: true },
        ignored: { save_to_session: false },
      },
      {
        person: { doc: '00123' },
        confirmed: false,
        total: 0,
        empty: null,
        ignored: 'no',
      },
    ),
  ).toEqual({ CPF: '00123', confirmed: false, total: 0, empty: null });
  for (const session_variable of [
    '__proto__.polluted',
    'current_agent_id',
    '_internal',
  ]) {
    expect(() =>
      savedRequestVariables(
        { value: { save_to_session: true, session_variable } },
        { value: 'untrusted' },
      ),
    ).toThrow();
  }
});

it('projects arbitrary JSON without business aliases or classifications', () => {
  const data = {
    CPF: '00123',
    cpf: '00456',
    cpc: false,
    acordo: 0,
    promessa: null,
    Nome: 'Pessoa',
    Detalhes: { report_target: 'customer data', items: [false, 0, null] },
  };
  expect(
    projectCollectedVariables({
      ...data,
      current_agent_id: 'internal',
      _chainTrail: [],
      available_apis: [],
      llm_providers: { secret: 'hidden' },
      password: 'hidden',
      Extra: { authorization: 'hidden', code: '001' },
    }),
  ).toEqual({ ...data, Extra: { code: '001' } });
  expect(data.Detalhes.report_target).toBe('customer data');
  expect(readVariable(data, 'cpf')).toBe('00456');
  expect(readVariable(data, 'documento')).toBeUndefined();
  expect(readVariable(data, '__proto__.polluted')).toBeUndefined();
});

it('rejects retired configuration only at owned configuration paths', () => {
  expect(() =>
    validateExtraction({
      documento: { path: 'id', report_target: 'contact_document' },
    }),
  ).toThrow();
  expect(() =>
    validateExtraction({
      documento: { value: { report_target: 'customer data' } },
    }),
  ).not.toThrow();
  expect(() => rejectLegacyMetadata({ analytics_config: {} })).toThrow();
  expect(() =>
    rejectLegacyMetadata({ variable_schema: { session_output_config: {} } }),
  ).toThrow();
  expect(() =>
    rejectLegacyMetadata({ business: { analytics_config: 'customer data' } }),
  ).not.toThrow();
  expect(() => validateExtraction({ '__proto__.polluted': 'id' })).toThrow();
});
