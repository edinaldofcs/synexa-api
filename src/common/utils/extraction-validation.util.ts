import { BadRequestException } from '@nestjs/common';
import {
  assertBusinessVariable,
  isSafePath,
  variableKey,
} from './session-variables.util';

export function rejectLegacyMetadata(metadata: unknown): void {
  if (!metadata || typeof metadata !== 'object') return;
  const providers = (metadata as Record<string, any>).llm_providers;
  if (
    providers &&
    typeof providers === 'object' &&
    Object.values(providers).some(
      (config: any) =>
        config &&
        typeof config === 'object' &&
        ('apiKey' in config || 'api_key' in config),
    )
  )
    throw new BadRequestException(
      'Edite credenciais na configuração de provedores, não no metadata.',
    );
  const schema = (metadata as Record<string, unknown>).variable_schema;
  if (
    schema &&
    typeof schema === 'object' &&
    Object.prototype.hasOwnProperty.call(schema, 'session_output_config')
  ) {
    throw new BadRequestException({
      code: 'REMOVED_CONFIGURATION',
      message: 'Configuração de BI não é mais suportada.',
    });
  }
  for (const key of [
    'analytics_config',
    'session_output_config',
    'report_bindings',
    'report_values',
    'session_record',
    'session_data',
    'ai_summary',
    'sentiment',
  ]) {
    if (Object.prototype.hasOwnProperty.call(metadata, key))
      throw new BadRequestException({
        code: 'REMOVED_CONFIGURATION',
        message: 'Configuração de BI não é mais suportada.',
      });
  }
}
export function validateVariableDefinitions(
  definitions: Array<{ key: string; report_target?: unknown }>,
) {
  for (const definition of definitions) {
    assertBusinessVariable(variableKey(definition.key));
    if (definition.report_target !== undefined)
      throw new BadRequestException({
        code: 'REMOVED_CONFIGURATION',
        message: 'Finalidade de relatório não é mais suportada.',
      });
  }
}
export const EXTRACTION_SETTINGS = new Set([
  '_fallback_message',
  'fallback_message',
  'validate_field',
  '_chaining',
]);
export function validateExtraction(config: unknown) {
  if (!config || typeof config !== 'object') return;
  validateConfiguredPaths(config);
  for (const [key, value] of Object.entries(config)) {
    if (
      !EXTRACTION_SETTINGS.has(key) &&
      typeof value === 'string' &&
      value &&
      !isSafePath(value)
    ) {
      throw new BadRequestException({
        code: 'INVALID_PATH',
        message: 'Caminho de dados inválido.',
      });
    }
  }
  validateVariableDefinitions(
    Object.entries(config)
      .filter(([key]) => !EXTRACTION_SETTINGS.has(key))
      .map(([key, value]) => ({
        key,
        report_target:
          value && typeof value === 'object' ? value.report_target : undefined,
      })),
  );
}

export function validateConfiguredPaths(config: unknown): void {
  if (!config || typeof config !== 'object') return;
  for (const [key, value] of Object.entries(config)) {
    if (!isSafePath(key))
      throw new BadRequestException({
        code: 'INVALID_PATH',
        message: 'Caminho de dados inválido.',
      });
    if (
      ['path', 'source_field'].includes(key) &&
      typeof value === 'string' &&
      value &&
      !isSafePath(value)
    ) {
      throw new BadRequestException({
        code: 'INVALID_PATH',
        message: 'Caminho de dados inválido.',
      });
    }
    validateConfiguredPaths(value);
  }
}
