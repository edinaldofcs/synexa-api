import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { LocalAdminService } from '../common/auth/local/local-admin.service';
import { SessionService } from '../common/auth/session.service';
import { ROLES, isPlatformAdmin } from '../common/auth/roles.constants';

export interface ActorContext {
  id: string;
  role?: string;
  company_id?: string | null;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private readonly isDevelopment = process.env.ENVIRONMENT === 'development';

  constructor(
    private prisma: PrismaService,
    private localAdminService: LocalAdminService,
    @Optional() private sessionService?: SessionService,
  ) {}

  private get adminClient(): SupabaseClient<any, 'public', any> {
    return createClient<any, 'public', any>(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    );
  }

  // ── Companies (exclusivo platform_admin) ───────────────────────────────

  async createCompany(data: { name: string }) {
    const { name } = data;

    if (!name) throw new BadRequestException('Name is required');

    try {
      const company = await this.prisma.companies.create({
        data: { name: name.trim(), status: 'active' },
      });

      return { success: true, company };
    } catch (err: unknown) {
      this.logInternalError('Create Company Error', err);
      throw new InternalServerErrorException('Internal server error');
    }
  }

  async listCompanies() {
    return this.prisma.companies.findMany({
      include: {
        _count: {
          select: {
            users: true,
            painel_clients: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async updateCompany(id: string, data: { name?: string; status?: string }) {
    await this.ensureCompanyExists(id);

    return this.prisma.companies.update({
      where: { id },
      data: {
        ...data,
        updated_at: new Date(),
      },
    });
  }

  async deleteCompany(id: string) {
    await this.ensureCompanyExists(id);

    // Transação única + ordem que respeita as FKs Restrict: qualquer falha
    // no meio da exclusão não pode deixar o tenant parcialmente removido.
    return this.prisma.$transaction(async (tx) => {
      // 1. Filhos diretos de webhook_endpoints (Restrict)
      await tx.webhook_deliveries.deleteMany({
        where: { webhook_endpoints: { painel_clients: { company_id: id } } },
      });
      await tx.webhook_endpoints.deleteMany({
        where: { painel_clients: { company_id: id } },
      });

      // 2. Execuções e eventos (FKs Restrict para end_users/users/conversations)
      await tx.tool_calls.deleteMany({ where: { company_id: id } });
      await tx.agent_runs.deleteMany({ where: { company_id: id } });
      await tx.message_events.deleteMany({ where: { company_id: id } });
      await tx.business_events.deleteMany({ where: { company_id: id } });
      await tx.inbound_events.deleteMany({ where: { company_id: id } });
      await tx.outbox_events.deleteMany({ where: { company_id: id } });

      // 3. Knowledge
      await tx.knowledge_embeddings.deleteMany({ where: { company_id: id } });
      await tx.knowledge_chunks.deleteMany({ where: { company_id: id } });
      await tx.knowledge_documents.deleteMany({ where: { company_id: id } });
      await tx.knowledge_bases.deleteMany({ where: { company_id: id } });

      // 4. Credenciais e auditoria
      await tx.credential_audit_logs.deleteMany({ where: { company_id: id } });
      await tx.provider_credentials.deleteMany({ where: { company_id: id } });

      // 5. Voz, telefonia, interações, workflow e mídia
      await tx.painel_interactions.deleteMany({ where: { company_id: id } });
      await tx.voice_session_telemetry.deleteMany({
        where: { company_id: id },
      });
      await tx.telephony_endpoints.deleteMany({ where: { company_id: id } });
      await tx.workflow_versions.deleteMany({ where: { company_id: id } });
      await tx.media_assets.deleteMany({ where: { company_id: id } });

      // 6. Conversas e mensagens (message_parts/conversation_state cascateiam)
      await tx.messages.deleteMany({ where: { company_id: id } });
      await tx.conversations.deleteMany({ where: { company_id: id } });

      // 7. Identidades e canais (Restrict com painel_clients/conversations)
      await tx.channel_identities.deleteMany({ where: { company_id: id } });
      await tx.end_users.deleteMany({ where: { company_id: id } });
      await tx.channel_connections.deleteMany({ where: { company_id: id } });

      // 8. Filhos de painel_clients com FK Restrict e o próprio cliente
      await tx.painel_clients.deleteMany({ where: { company_id: id } });

      // 9. Usuários (NoAction) e a empresa
      await tx.users.deleteMany({ where: { company_id: id } });

      return tx.companies.delete({ where: { id } });
    });
  }

  // ── Erasure de titular (LGPD art. 18, VI) ─────────────────────────────

  /**
   * Remove/anonimiza dados pessoais de um end_user mantendo integridade
   * financeira (valores de acordo permanecem p/ defesa legal - art. 16, II).
   * Arquivos fisicos de midia NAO sao removidos do bucket (limitacao
   * documentada; as linhas com transcript/ocr_text sao removidas).
   */
  async eraseEndUserData(actor: ActorContext, endUserId: string) {
    const endUser = await this.prisma.end_users.findUnique({
      where: { id: endUserId },
      select: { id: true, name: true, company_id: true },
    });
    if (!endUser) throw new NotFoundException('Titular nao encontrado');

    if (!isPlatformAdmin(actor.role)) {
      this.assertActorCompany(actor);
      if (actor.company_id !== endUser.company_id) {
        throw new ForbiddenException('Titular de outra empresa');
      }
    }

    const conversations = await this.prisma.conversations.findMany({
      where: { end_user_id: endUserId },
      select: { id: true },
    });
    const convIds = conversations.map((c) => c.id);

    const identities = await this.prisma.channel_identities.findMany({
      where: { end_user_id: endUserId },
      select: { external_user_id: true, normalized_phone: true },
    });
    const identifiers = [
      ...new Set(
        identities
          .flatMap((i) => [i.external_user_id, i.normalized_phone])
          .filter((v): v is string => !!v),
      ),
    ];

    const erasedAt = new Date().toISOString();
    const counts = await this.prisma.$transaction(async (tx) => {
      // 1. Conteudo de execucao com PII (arguments/result/trace)
      const toolCalls = await tx.tool_calls.deleteMany({
        where: { conversation_id: { in: convIds } },
      });
      const agentRuns = await tx.agent_runs.deleteMany({
        where: { conversation_id: { in: convIds } },
      });

      // 2. Midia com transcript/ocr do titular (linhas; arquivos em bucket
      //    precisam de cleanup de storage - ver plano LGPD)
      const media = await tx.media_assets.deleteMany({
        where: { messages: { conversation_id: { in: convIds } } },
      });

      // 3. Telemetria de voz: mantem metricas, remove numero do chamador
      const telemetry = await tx.voice_session_telemetry.updateMany({
        where: { conversation_id: { in: convIds } },
        data: { caller_number: null, metadata: {} },
      });

      // 4. Conversas, mensagens (parts/state cascateiam) e eventos
      const messages = await tx.messages.deleteMany({
        where: { conversation_id: { in: convIds } },
      });
      const removedConversations = await tx.conversations.deleteMany({
        where: { end_user_id: endUserId },
      });

      // 5. Eventos de negocio sobreviventes sem conversa: desvincula titular
      const businessEvents = await tx.business_events.updateMany({
        where: { end_user_id: endUserId },
        data: { end_user_id: null, values: {} },
      });

      // 6. Interacoes de cobranca: remove conteudo pessoal, preserva valores
      //    financeiros (obrigacao legal/defesa de direitos - art. 16, II)
      const interactions = await tx.painel_interactions.updateMany({
        where: {
          company_id: endUser.company_id,
          OR: [
            ...(identifiers.length
              ? [{ client_identifier: { in: identifiers } }]
              : []),
            ...(endUser.name ? [{ client_name: endUser.name }] : []),
          ],
        },
        data: {
          client_identifier: null,
          client_name: null,
          summary: null,
          messages: [],
          context_variables: {},
          recording_url: null,
        },
      });

      // 7. Identidades de canal e o registro do titular
      await tx.channel_identities.deleteMany({
        where: { end_user_id: endUserId },
      });
      await tx.end_users.delete({ where: { id: endUserId } });

      return {
        conversations_removed: removedConversations.count,
        messages_removed: messages.count,
        media_removed: media.count,
        tool_calls_removed: toolCalls.count,
        agent_runs_removed: agentRuns.count,
        telemetry_anonymized: telemetry.count,
        business_events_stripped: businessEvents.count,
        interactions_anonymized: interactions.count,
      };
    });

    this.logger.log({
      event: 'lgpd_erasure',
      request_id: (actor as any)?.request_id,
      end_user_id: endUserId,
      company_id: endUser.company_id,
      ...counts,
    });

    return {
      erased: true,
      end_user_id: endUserId,
      erased_at: erasedAt,
      ...counts,
    };
  }

  // ── Users (platform_admin global; company_admin restrito à própria empresa) ──

  async listUsers(actor: ActorContext) {
    if (isPlatformAdmin(actor.role)) {
      return this.prisma.users.findMany({
        orderBy: { created_at: 'desc' },
        select: this.userPublicSelect(),
      });
    }

    this.assertActorCompany(actor);

    return this.prisma.users.findMany({
      where: { company_id: actor.company_id as string },
      orderBy: { created_at: 'desc' },
      select: this.userPublicSelect(),
    });
  }

  async getUser(actor: ActorContext, id: string) {
    const user = await this.findUserOrThrow(id);
    this.assertCanManageUser(actor, user);

    const { password_hash: _ignored, ...safe } = user;
    void _ignored;
    return safe;
  }

  async createUser(
    actor: ActorContext,
    data: {
      email: string;
      password?: string;
      role?: string;
      company_id?: string;
      name?: string;
    },
  ) {
    const role = data.role || ROLES.OPERATOR;

    if (role === ROLES.PLATFORM_ADMIN && !isPlatformAdmin(actor.role)) {
      throw new ForbiddenException(
        'Somente platform_admin pode conceder esse papel',
      );
    }

    let companyId = data.company_id;
    if (isPlatformAdmin(actor.role)) {
      if (!companyId) {
        throw new BadRequestException(
          'company_id é obrigatório para platform_admin',
        );
      }
    } else {
      companyId = this.assertActorCompany(actor);
    }

    try {
      const targetCompany = await this.prisma.companies.findUnique({
        where: { id: companyId as string },
      });
      if (!targetCompany || targetCompany.status !== 'active') {
        throw new BadRequestException('Empresa destino inválida ou suspensa');
      }
    } catch (err: unknown) {
      if (err instanceof BadRequestException) throw err;
      this.logInternalError('Create User Company Lookup Error', err);
      throw new InternalServerErrorException('Internal server error');
    }

    if (this.isDevelopment) {
      return this.localAdminService.createUser({
        email: data.email,
        password: data.password,
        role,
        company_id: companyId as string,
        name: data.name,
      });
    }

    const { email, password, name } = data;

    if (!email) throw new BadRequestException('Email is required');

    try {
      let userId: string;

      const { data: authUser, error: authError } =
        await this.adminClient.auth.admin.createUser({
          email,
          password: password || undefined,
          email_confirm: true,
          user_metadata: { name: name || '' },
        });

      if (authError) {
        if (authError.message.includes('already registered')) {
          userId = await this.findExistingSupabaseUserId(email);
        } else {
          throw authError;
        }
      } else {
        if (!authUser || !authUser.user)
          throw new Error('User creation returned no data');
        userId = authUser.user.id;
      }

      const existingProfile = await this.prisma.users.findUnique({
        where: { id: userId },
      });

      if (existingProfile) {
        return { success: true, user: existingProfile, existed: true };
      }

      const user = await this.prisma.users.create({
        data: {
          id: userId,
          company_id: companyId as string,
          role,
          name: name || '',
        },
      });

      return { success: true, user };
    } catch (err: unknown) {
      this.logInternalError('Create User Error', err);
      throw new InternalServerErrorException('Internal server error');
    }
  }

  async updateUser(
    actor: ActorContext,
    id: string,
    dto: {
      email?: string;
      name?: string;
      role?: string;
      is_active?: boolean;
      password?: string;
    },
  ) {
    const target = await this.findUserOrThrow(id);
    this.assertCanManageUser(actor, target);

    if (dto.role === ROLES.PLATFORM_ADMIN && !isPlatformAdmin(actor.role)) {
      throw new ForbiddenException(
        'Somente platform_admin pode conceder esse papel',
      );
    }

    if (dto.password && this.isDevelopment) {
      const password_hash = await bcrypt.hash(dto.password, 10);
      await this.prisma.users.update({
        where: { id },
        data: { password_hash },
      });
      await this.sessionService?.destroyAllForUser(id);
      delete dto.password;
    }

    const data: Record<string, unknown> = {};
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.role !== undefined) data.role = dto.role;
    data.updated_at = new Date();

    const user = await this.prisma.users.update({
      where: { id },

      data: data as any,
      select: this.userPublicSelect(),
    });

    if (!this.isDevelopment) {
      await this.syncSupabaseMetadata(id, dto).catch((err: Error) => {
        this.logger.warn(
          `Supabase metadata sync failed for ${id}: ${err.message}`,
        );
      });
    }

    return { success: true, user };
  }

  async deleteUser(actor: ActorContext, id: string) {
    if (actor.id === id) {
      throw new BadRequestException('Não é possível remover o próprio usuário');
    }

    const target = await this.findUserOrThrow(id);
    this.assertCanManageUser(actor, target);

    if (!this.isDevelopment) {
      await this.adminClient.auth.admin.deleteUser(id).catch((err: Error) => {
        this.logger.warn(
          `Supabase user delete failed for ${id}: ${err.message}`,
        );
      });
    }

    await this.prisma.users.delete({ where: { id } });
    return { success: true };
  }

  async resetUserPassword(actor: ActorContext, id: string) {
    const target = await this.findUserOrThrow(id);
    this.assertCanManageUser(actor, target);

    if (this.isDevelopment) {
      const temporaryPassword = `Synexa-${randomBytes(6).toString('hex')}`;
      const password_hash = await bcrypt.hash(temporaryPassword, 10);
      await this.prisma.users.update({
        where: { id },
        data: { password_hash },
      });
      await this.sessionService?.destroyAllForUser(id);
      return { success: true, temporary_password: temporaryPassword };
    }

    if (!target.email) {
      throw new BadRequestException('Usuário sem email vinculado');
    }

    const { error } = await this.adminClient.auth.resetPasswordForEmail(
      target.email,
    );
    if (error) throw new InternalServerErrorException(error.message);

    return { success: true, message: 'Email de redefinição enviado' };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private userPublicSelect(): Record<string, boolean> {
    return {
      id: true,
      email: true,
      name: true,
      role: true,
      company_id: true,
      created_at: true,
      updated_at: true,
    };
  }

  private assertActorCompany(actor: ActorContext): string {
    if (!actor.company_id) {
      throw new ForbiddenException(
        'Usuário sem vínculo com uma empresa (company_id ausente)',
      );
    }
    return actor.company_id;
  }

  private assertCanManageUser(
    actor: ActorContext,
    target: { company_id: string; role?: string | null },
  ): void {
    if (!isPlatformAdmin(actor.role)) {
      const actorCompany = this.assertActorCompany(actor);
      if (target.company_id !== actorCompany) {
        throw new ForbiddenException(
          'Acesso negado: usuário pertence a outra empresa',
        );
      }
      if (isPlatformAdmin(target.role)) {
        throw new ForbiddenException(
          'Sem permissão para gerenciar um platform_admin',
        );
      }
    }
  }

  private async findUserOrThrow(id: string) {
    const user = await this.prisma.users.findUnique({
      where: { id },
    });
    if (!user) throw new NotFoundException('Usuário não encontrado');
    return user;
  }

  private async ensureCompanyExists(id: string) {
    const company = await this.prisma.companies.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Empresa não encontrada');
  }

  private async findExistingSupabaseUserId(email: string): Promise<string> {
    const listResult = await this.adminClient.auth.admin.listUsers();
    if (listResult.error) throw listResult.error;

    const usersList = listResult.data.users as Array<{
      id: string;
      email?: string;
    }>;
    const existingUser = usersList.find((u) => u.email === email);
    if (!existingUser)
      throw new Error('User reported existing but not found in list');
    return existingUser.id;
  }

  private async syncSupabaseMetadata(
    id: string,
    dto: {
      name?: string;
      role?: string;
    },
  ): Promise<void> {
    if (dto.name === undefined && dto.role === undefined) return;
    await this.adminClient.auth.admin.updateUserById(id, {
      user_metadata: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.role !== undefined ? { role: dto.role } : {}),
      },
    });
  }

  private logInternalError(context: string, err: unknown): void {
    const error = err as Error;
    this.logger.error(`${context}:`, error?.message || error);
  }
}
