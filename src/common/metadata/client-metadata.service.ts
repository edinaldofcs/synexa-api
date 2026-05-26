import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface MetadataResult {
  result: Prisma.JsonValue;
}

@Injectable()
export class ClientMetadataService {
  private readonly logger = new Logger(ClientMetadataService.name);

  constructor(private readonly prisma: PrismaService) {}

  async refresh(clientId: string): Promise<void> {
    try {
      const result = await this.prisma.$queryRaw<MetadataResult[]>(Prisma.sql`
WITH agent_list AS (
  SELECT
    pa.id,
    pa.client_id,
    pa.execution_order,
    pa.service_step,
    pa.is_initial,
    pa.activation_conditions,
    pa.activation_mode
  FROM public.painel_agents pa
  WHERE pa.is_active = true
),
api_base AS (
  SELECT
    al.client_id,
    al.execution_order,
    al.id as agent_id,
    papi.name
  FROM agent_list al
  LEFT JOIN public.painel_apis papi
    ON al.id = papi.agent_id
  WHERE papi.name IS NOT NULL
),
api_cumulative AS (
  SELECT
    s.client_id,
    s.agent_id,
    jsonb_agg(DISTINCT b.name ORDER BY b.name) AS api_list
  FROM agent_list s
  JOIN api_base b
    ON b.client_id = s.client_id
   AND b.execution_order <= s.execution_order
  GROUP BY s.client_id, s.agent_id
),
regras AS (
  SELECT
    client_id,
    jsonb_object_agg(agent_id, api_list) AS activation_rules
  FROM api_cumulative
  GROUP BY client_id
),
agent_activation AS (
  SELECT
    client_id,
    jsonb_object_agg(
      id,
      jsonb_build_object(
        'is_initial', is_initial,
        'service_step', service_step,
        'activation_conditions', activation_conditions,
        'activation_mode', activation_mode
      )
    ) AS agent_configs
  FROM agent_list
  GROUP BY client_id
),
api_flags AS (
  SELECT
    client_id,
    jsonb_object_agg(DISTINCT name, false) AS api_booleans
  FROM api_base
  GROUP BY client_id
)
SELECT
  jsonb_build_object(
    'sessionId', NULL,
    'phone_number', a.phone_number,
    'company_name', a.company_name,
    'strategy', LOWER(a.strategy),
    'tentativas', 0,
    'ofertas_disponiveis', NULL
  )
  || COALESCE(f.api_booleans, '{}'::jsonb)
  || COALESCE(ac.agent_configs, '{}'::jsonb)
  || jsonb_build_object(
       'metadata', jsonb_build_object(
         'activation_rules', r.activation_rules
       )
     ) AS result
FROM public.painel_clients a
LEFT JOIN regras r ON r.client_id = a.id
LEFT JOIN api_flags f ON f.client_id = a.id
LEFT JOIN agent_activation ac ON ac.client_id = a.id
WHERE a.id = ${clientId}::uuid
`);

      const generatedMetadata = result[0]?.result ?? {};
      const client = await this.prisma.painel_clients.findUnique({
        where: { id: clientId },
        select: { metadata: true },
      });
      const currentMetadata =
        typeof client?.metadata === 'object' && client.metadata !== null
          ? (client.metadata as Record<string, unknown>)
          : {};
      const generatedMetadataObject =
        typeof generatedMetadata === 'object' && generatedMetadata !== null
          ? (generatedMetadata as Record<string, unknown>)
          : {};
      const metadata = {
        ...generatedMetadataObject,
        ...(currentMetadata.llm_providers
          ? { llm_providers: currentMetadata.llm_providers }
          : {}),
        ...(currentMetadata.llm_providers_updated_at
          ? {
              llm_providers_updated_at:
                currentMetadata.llm_providers_updated_at,
            }
          : {}),
      };
      await this.prisma.painel_clients.update({
        where: { id: clientId },
        data: { metadata },
      });
    } catch (error) {
      this.logger.error(
        `Error updating metadata for client ${clientId}:`,
        error,
      );
    }
  }
}
