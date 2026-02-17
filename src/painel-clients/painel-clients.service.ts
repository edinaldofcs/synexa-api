import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseService } from '../common/supabase/supabase.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreatePainelClientDto } from './dto/create-painel-client.dto';
import { UpdatePainelClientDto } from './dto/update-painel-client.dto';

interface MetadataResult {
  result: any;
}

interface PainelClient {
  id: string;
  company_name: string;
  agent_name: string;
  [key: string]: any;
}

interface PainelAgent {
  id: string;
  client_id: string;
  [key: string]: any;
}

interface PainelIntention {
  id: string;
  client_id: string;
  [key: string]: any;
}

interface PainelApi {
  id: string;
  agent_id: string;
  next_api_id: string | null;
  [key: string]: any;
}

@Injectable()
export class PainelClientsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly prisma: PrismaService,
  ) {}

  private async updateClientMetadata(clientId: string) {
    try {
      const query = `
WITH api_base AS (
  SELECT 
    pa.client_id,
    pa.execution_order,
    papi.name
  FROM public.painel_agents pa
  LEFT JOIN public.painel_apis papi 
    ON pa.id = papi.agent_id
  WHERE pa.client_id = '${clientId}' AND papi.name IS NOT NULL
),

api_steps AS (
  SELECT DISTINCT client_id, execution_order
  FROM api_base
),

api_cumulative AS (
  SELECT
    s.client_id,
    s.execution_order,
    jsonb_agg(DISTINCT b.name ORDER BY b.name) AS api_list
  FROM api_steps s
  JOIN api_base b
    ON b.client_id = s.client_id
   AND b.execution_order <= s.execution_order
  GROUP BY s.client_id, s.execution_order
),

regras AS (
  SELECT
    client_id,
    jsonb_object_agg(
      execution_order::text,
      api_list
    ) AS activation_rules
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
  || COALESCE(jsonb_build_object(
       'activation_rules', r.activation_rules
     ), '{}'::jsonb) AS result

FROM public.painel_clients a
LEFT JOIN regras r ON r.client_id = a.id
LEFT JOIN api_flags f ON f.client_id = a.id
WHERE a.id = '${clientId}'
`;

      const result = await this.prisma.$queryRawUnsafe<MetadataResult[]>(query);

      if (result && result.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const metadata = result[0].result;
        await this.prisma.painel_clients.update({
          where: { id: clientId },
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: { metadata: metadata || {} },
        });
      }
    } catch (error) {
      console.error(
        'Error updating metadata for client ' + clientId + ':',
        error,
      );
    }
  }

  async create(
    createPainelClientDto: CreatePainelClientDto,
  ): Promise<PainelClient | null> {
    const { user_id, ...rest } = createPainelClientDto;

    if (!user_id) {
      throw new BadRequestException('User ID is required');
    }

    // Find company_id from user_id using Prisma
    const user = await this.prisma.users.findUnique({
      where: { id: user_id },
      select: { company_id: true },
    });

    if (!user || !user.company_id) {
      throw new NotFoundException(
        `User with ID ${user_id} not found or has no company associated.`,
      );
    }

    const company_id = user.company_id;

    // Insert into painel_clients
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin
      .from('painel_clients')
      .insert({
        ...rest,
        company_id: company_id,
      })
      .select()
      .single();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (data) {
      const client = data as PainelClient;
      void this.updateClientMetadata(client.id);
    }

    return data as PainelClient | null;
  }

  async findAll(): Promise<PainelClient[] | null> {
    const { data, error } = await this.supabase.admin
      .from('painel_clients')
      .select('*')
      .order('id', { ascending: true });

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return data as PainelClient[] | null;
  }

  async findOne(id: string): Promise<PainelClient | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin
      .from('painel_clients')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new NotFoundException(`PainelClient with ID ${id} not found`);
      }
      throw new InternalServerErrorException(error.message);
    }
    return data as PainelClient | null;
  }

  async update(
    id: string,
    updatePainelClientDto: UpdatePainelClientDto,
  ): Promise<PainelClient | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin
      .from('painel_clients')
      .update(updatePainelClientDto)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (data) {
      const client = data as PainelClient;
      void this.updateClientMetadata(client.id);
    }

    return data as PainelClient | null;
  }

  async remove(id: string): Promise<{ success: boolean }> {
    const { error } = await this.supabase.admin
      .from('painel_clients')
      .delete()
      .eq('id', id);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return { success: true };
  }

  // --- Agents ---

  async createAgent(createDto: {
    client_id: string;
    [key: string]: any;
  }): Promise<PainelAgent | null> {
    const { client_id, ...rest } = createDto;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin
      .from('painel_agents')
      .insert({
        ...rest,
        client_id: client_id,
      })
      .select()
      .single();

    if (error) throw new InternalServerErrorException(error.message);

    if (data) {
      const agent = data as PainelAgent;
      void this.updateClientMetadata(agent.client_id);
    }

    return data as PainelAgent | null;
  }

  async findAllAgents(clientId: string): Promise<PainelAgent[] | null> {
    const { data, error } = await this.supabase.admin
      .from('painel_agents')
      .select('*')
      .eq('client_id', clientId)
      .order('execution_order', { ascending: true });

    if (error) throw new InternalServerErrorException(error.message);
    return data as PainelAgent[] | null;
  }

  async findOneAgent(id: string): Promise<PainelAgent | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin
      .from('painel_agents')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116')
        throw new NotFoundException(`Agent with ID ${id} not found`);
      throw new InternalServerErrorException(error.message);
    }
    return data as PainelAgent | null;
  }

  async updateAgent(
    id: string,
    updateDto: Record<string, any>,
  ): Promise<PainelAgent | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin
      .from('painel_agents')
      .update(updateDto)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new InternalServerErrorException(error.message);

    if (data) {
      const agent = data as PainelAgent;
      void this.updateClientMetadata(agent.client_id);
    }

    return data as PainelAgent | null;
  }

  async removeAgent(id: string): Promise<{ success: boolean }> {
    // First get the agent to know the client_id
    const { data: agent, error: fetchError } = await this.supabase.admin
      .from('painel_agents')
      .select('client_id')
      .eq('id', id)
      .single();

    if (fetchError) throw new InternalServerErrorException(fetchError.message);

    const { error } = await this.supabase.admin
      .from('painel_agents')
      .delete()
      .eq('id', id);

    if (error) throw new InternalServerErrorException(error.message);

    if (agent) {
      const agentData = agent as PainelAgent;
      void this.updateClientMetadata(agentData.client_id);
    }

    return { success: true };
  }

  // --- Intentions ---

  async createIntention(createDto: {
    client_id: string;
    [key: string]: any;
  }): Promise<PainelIntention | null> {
    const { client_id, ...rest } = createDto;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin
      .from('painel_intentions')
      .insert({
        ...rest,
        client_id: client_id,
      })
      .select()
      .single();

    if (error) throw new InternalServerErrorException(error.message);
    return data as PainelIntention | null;
  }

  async findAllIntentions(clientId: string): Promise<PainelIntention[] | null> {
    const { data, error } = await this.supabase.admin
      .from('painel_intentions')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: true });

    if (error) throw new InternalServerErrorException(error.message);
    return data as PainelIntention[] | null;
  }

  async findOneIntention(id: string): Promise<PainelIntention | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin
      .from('painel_intentions')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116')
        throw new NotFoundException(`Intention with ID ${id} not found`);
      throw new InternalServerErrorException(error.message);
    }
    return data as PainelIntention | null;
  }

  async updateIntention(
    id: string,
    updateDto: Record<string, any>,
  ): Promise<PainelIntention | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin
      .from('painel_intentions')
      .update(updateDto)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new InternalServerErrorException(error.message);
    return data as PainelIntention | null;
  }

  async removeIntention(id: string): Promise<{ success: boolean }> {
    const { error } = await this.supabase.admin
      .from('painel_intentions')
      .delete()
      .eq('id', id);

    if (error) throw new InternalServerErrorException(error.message);
    return { success: true };
  }

  // --- APIs ---

  async createApi(createDto: {
    agent_id: string;
    [key: string]: any;
  }): Promise<PainelApi | null> {
    const { agent_id, ...rest } = createDto;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin
      .from('painel_apis')
      .insert({
        ...rest,
        agent_id: agent_id,
      })
      .select()
      .single();

    if (error) throw new InternalServerErrorException(error.message);

    // Get client_id from agent_id
    const { data: agent } = await this.supabase.admin
      .from('painel_agents')
      .select('client_id')
      .eq('id', agent_id)
      .single();

    if (agent) {
      const agentData = agent as { client_id: string };
      void this.updateClientMetadata(agentData.client_id);
    }

    return data as PainelApi | null;
  }

  async findAllApisByClient(clientId: string): Promise<PainelApi[] | null> {
    // First get all agent IDs for this client
    const { data: agents, error: agentsError } = await this.supabase.admin
      .from('painel_agents')
      .select('id')
      .eq('client_id', clientId);

    if (agentsError)
      throw new InternalServerErrorException(agentsError.message);
    if (!agents || agents.length === 0) return [];

    const agentIds = agents.map((a) => (a as { id: string }).id);

    const { data, error } = await this.supabase.admin
      .from('painel_apis')
      .select('*')
      .in('agent_id', agentIds)
      .order('execution_order', { ascending: true });

    if (error) throw new InternalServerErrorException(error.message);
    return data as PainelApi[] | null;
  }

  async findOneApi(id: string): Promise<PainelApi | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin
      .from('painel_apis')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116')
        throw new NotFoundException(`API with ID ${id} not found`);
      throw new InternalServerErrorException(error.message);
    }
    return data as PainelApi | null;
  }

  async updateApi(
    id: string,
    updateDto: Record<string, any>,
  ): Promise<PainelApi | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin
      .from('painel_apis')
      .update(updateDto)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new InternalServerErrorException(error.message);

    // Get client_id from agent
    if (data) {
      const apiData = data as { agent_id: string };
      const { data: agent } = await this.supabase.admin
        .from('painel_agents')
        .select('client_id')
        .eq('id', apiData.agent_id)
        .single();

      if (agent) {
        const agentData = agent as { client_id: string };
        void this.updateClientMetadata(agentData.client_id);
      }
    }

    return data as PainelApi | null;
  }

  async removeApi(id: string): Promise<{ success: boolean }> {
    // Get the API first to know agent_id
    const { data: api, error: fetchError } = await this.supabase.admin
      .from('painel_apis')
      .select('agent_id')
      .eq('id', id)
      .single();

    if (fetchError) throw new InternalServerErrorException(fetchError.message);

    const { error } = await this.supabase.admin
      .from('painel_apis')
      .delete()
      .eq('id', id);

    if (error) throw new InternalServerErrorException(error.message);

    if (api) {
      const apiData = api as { agent_id: string };
      const { data: agent } = await this.supabase.admin
        .from('painel_agents')
        .select('client_id')
        .eq('id', apiData.agent_id)
        .single();

      if (agent) {
        const agentData = agent as { client_id: string };
        void this.updateClientMetadata(agentData.client_id);
      }
    }

    return { success: true };
  }

  async duplicateClient(clientId: string): Promise<PainelClient> {
    // 1. Fetch original client data
    const originalClient = await this.findOne(clientId);
    if (!originalClient) {
      throw new NotFoundException(
        `originalClient with ID ${clientId} not found`,
      );
    }

    const clientObj = originalClient;

    // 2. Create new client
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _ignoredId, ...clientData } = clientObj;
    const newClientPayload = {
      ...clientData,
      company_name: `${String(clientObj.company_name || '')} (Cópia)`,
      agent_name: `${String(clientObj.agent_name || '')} (Cópia)`,
      metadata: {}, // Reset metadata, will be regenerated
      id: undefined, // Let DB generate new ID
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: newClient, error: createClientError } =
      await this.supabase.admin
        .from('painel_clients')
        .insert(newClientPayload)
        .select()
        .single();

    if (createClientError)
      throw new InternalServerErrorException(createClientError.message);
    if (!newClient)
      throw new InternalServerErrorException(
        'Failed to create duplicated client',
      );

    const newClientData = newClient as PainelClient;

    // 3. Duplicate Agents
    const originalAgents = await this.findAllAgents(clientId);
    const agentIdMap = new Map<string, string>(); // Old ID -> New ID

    if (originalAgents) {
      for (const agent of originalAgents) {
        const agentObj = agent;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id: oldAgentId, client_id: _cid, ...agentData } = agentObj;
        const newAgentPayload = {
          ...agentData,
          client_id: newClientData.id,
          id: undefined,
        };

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const { data: newAgent, error: createAgentError } =
          await this.supabase.admin
            .from('painel_agents')
            .insert(newAgentPayload)
            .select()
            .single();

        if (createAgentError) {
          console.error('Error duplicating agent', createAgentError);
          continue;
        }
        if (newAgent) {
          const newAgentData = newAgent as PainelAgent;
          agentIdMap.set(String(oldAgentId), String(newAgentData.id));
        }
      }
    }

    // 4. Duplicate Intentions
    const originalIntentions = await this.findAllIntentions(clientId);
    if (originalIntentions) {
      for (const intention of originalIntentions) {
        const intObj = intention;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id: _oid, client_id: _cid, ...intentionData } = intObj;
        const newIntentionPayload = {
          ...intentionData,
          client_id: newClientData.id,
          id: undefined,
        };
        void this.supabase.admin
          .from('painel_intentions')
          .insert(newIntentionPayload);
      }
    }

    // 5. Duplicate APIs
    const originalApis = await this.findAllApisByClient(clientId);
    const apiIdMap = new Map<string, string>(); // Old ID -> New ID

    if (originalApis) {
      // 5.1 Create APIs
      for (const api of originalApis) {
        const apiObj = api;
        const {
          id: oldApiId,
          agent_id,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          next_api_id: _napi,
          ...apiData
        } = apiObj;

        // Resolve new agent ID
        const newAgentId = agentIdMap.get(String(agent_id));
        if (!newAgentId) continue;

        const newApiPayload = {
          ...apiData,
          agent_id: newAgentId,
          next_api_id: null, // Set null initially
          id: undefined,
        };

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const { data: newApi, error: createApiError } =
          await this.supabase.admin
            .from('painel_apis')
            .insert(newApiPayload)
            .select()
            .single();

        if (createApiError) {
          console.error('Error duplicating API', createApiError);
          continue;
        }
        if (newApi) {
          const newApiData = newApi as PainelApi;
          apiIdMap.set(String(oldApiId), String(newApiData.id));
        }
      }

      // 5.2 Update next_api_id references
      for (const api of originalApis) {
        const apiObj = api;
        if (apiObj.next_api_id) {
          const newApiId = apiIdMap.get(String(apiObj.id));
          const newNextApiId = apiIdMap.get(String(apiObj.next_api_id));

          if (newApiId && newNextApiId) {
            void this.supabase.admin
              .from('painel_apis')
              .update({ next_api_id: newNextApiId })
              .eq('id', newApiId);
          }
        }
      }
    }

    // 6. Update Metadata for new client
    void this.updateClientMetadata(newClientData.id);

    return newClient as PainelClient;
  }
}
