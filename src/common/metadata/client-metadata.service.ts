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
WITH api_base AS (
  SELECT
    pa.client_id,
    pa.execution_order,
    papi.name,
    pa.id as agent_id
  FROM public.painel_agents pa
  LEFT JOIN public.painel_apis papi
    ON pa.id = papi.agent_id
  WHERE papi.name IS NOT NULL
),
api_steps AS (
  SELECT DISTINCT client_id, execution_order, agent_id
  FROM api_base
),
api_cumulative AS (
  SELECT
    s.client_id,
    s.agent_id,
    jsonb_agg(DISTINCT b.name ORDER BY b.name) AS api_list
  FROM api_steps s
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
  || jsonb_build_object(
       'metadata', jsonb_build_object(
         'activation_rules', r.activation_rules
       )
     ) AS result
FROM public.painel_clients a
LEFT JOIN regras r ON r.client_id = a.id
LEFT JOIN api_flags f ON f.client_id = a.id
WHERE a.id = ${clientId}::uuid
`);

      const metadata = result[0]?.result ?? {};
      await this.prisma.painel_clients.update({
        where: { id: clientId },
        data: { metadata },
      });
    } catch (error) {
      this.logger.error(`Error updating metadata for client ${clientId}:`, error);
    }
  }
}
