import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { SessionService } from '../common/auth/session.service';
import { ActivatePartnerDto, CreatePartnerDto } from './dto/partner.dto';

@Injectable()
export class PartnersService {
  private readonly logger = new Logger(PartnersService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly sessions: SessionService,
  ) {}

  list() {
    return this.prisma.companies.findMany({
      orderBy: { created_at: 'desc' },
      take: 100,
      select: {
        id: true,
        name: true,
        status: true,
        max_concurrent_calls: true,
        created_at: true,
        users: {
          where: { role: 'company_admin' },
          select: {
            id: true,
            name: true,
            email: true,
            invitation_pending: true,
          },
        },
        _count: { select: { users: true, painel_clients: true } },
      },
    });
  }

  async updateLimit(actorId: string, companyId: string, limit: number) {
    const company = await this.prisma.companies.update({
      where: { id: companyId },
      data: { max_concurrent_calls: limit, updated_at: new Date() },
      select: { id: true, max_concurrent_calls: true },
    });
    this.logger.log(
      JSON.stringify({
        event: 'company_voice_limit_updated',
        actor_id: actorId,
        company_id: companyId,
        limit,
      }),
    );
    return company;
  }

  private auth() {
    const provider =
      this.config.get<string>('AUTH_PROVIDER') ??
      (this.config.get('ENVIRONMENT') === 'production' ? 'supabase' : 'local');
    const url = this.config.get<string>('SUPABASE_URL');
    const key = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (provider !== 'supabase' || !url || !key)
      throw new ServiceUnavailableException(
        'Convites exigem o provedor de autenticação Supabase configurado.',
      );
    return createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }

  private activationBase() {
    const base = this.config.get<string>('AUTH_FRONTEND_URL');
    if (!base)
      throw new ServiceUnavailableException(
        'Endereço público de ativação não configurado.',
      );
    const url = new URL('/activate-account', base);
    if (
      url.protocol !== 'https:' &&
      this.config.get('ENVIRONMENT') !== 'development'
    )
      throw new ServiceUnavailableException('A ativação requer HTTPS.');
    return url.toString();
  }

  async create(actorId: string, dto: CreatePartnerDto) {
    const email = dto.email.trim().toLowerCase();
    const lock = `partner:create:${createHash('sha256').update(email).digest('hex')}`;
    if (!(await this.redis.acquireLock(lock, 60)))
      throw new ConflictException(
        'Cadastro em andamento. Aguarde antes de tentar novamente.',
      );
    try {
      if (
        await this.prisma.users.findUnique({
          where: { email },
          select: { id: true },
        })
      )
        throw new ConflictException(
          'Este e-mail já possui acesso. Nenhuma empresa foi criada.',
        );
      const auth = this.auth();
      const redirectTo = this.activationBase();
      const { data, error } = await auth.auth.admin.generateLink({
        type: 'invite',
        email,
        options: { redirectTo, data: { name: dto.adminName } },
      });
      if (error || !data.user || !data.properties?.hashed_token)
        throw new BadRequestException(
          'Não foi possível preparar o convite. Verifique se o e-mail já possui uma conta.',
        );
      const result = await this.prisma.$transaction(async (tx) => {
        const company = await tx.companies.create({
          data: {
            name: dto.companyName.trim(),
            status: 'active',
            max_concurrent_calls: dto.maxConcurrentCalls ?? 5,
          },
          select: { id: true, name: true },
        });
        const user = await tx.users.create({
          data: {
            id: data.user.id,
            email,
            name: dto.adminName.trim(),
            company_id: company.id,
            role: 'company_admin',
            invitation_pending: true,
          },
          select: { id: true, email: true, name: true },
        });
        return { company, user };
      });
      this.logger.log(
        JSON.stringify({
          event: 'partner_created',
          actor_id: actorId,
          company_id: result.company.id,
          user_id: result.user.id,
        }),
      );
      const activationUrl = `${redirectTo}#token=${encodeURIComponent(data.properties.hashed_token)}&type=invite`;
      if (dto.delivery === 'link')
        return {
          ...result,
          delivery: 'link' as const,
          activationUrl,
          message: undefined as string | undefined,
        };
      // Sending is a separate step: a delivery failure must not pretend the company was rolled back.
      const invitation = await this.invite(actorId, result.user.id, 'email');
      return { ...result, ...invitation };
    } finally {
      await this.redis.releaseLock(lock);
    }
  }

  async invite(
    actorId: string,
    userId: string,
    delivery: 'link' | 'email',
  ): Promise<{
    delivery: 'link' | 'email';
    activationUrl?: string;
    message?: string;
  }> {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      include: { companies: { select: { status: true } } },
    });
    if (
      !user?.email ||
      user.role !== 'company_admin' ||
      !user.invitation_pending ||
      user.companies.status !== 'active'
    )
      throw new BadRequestException(
        'Este usuário não possui convite pendente em uma empresa ativa.',
      );
    const auth = this.auth();
    const redirectTo = this.activationBase();
    const identity = await auth.auth.admin.getUserById(user.id);
    if (
      identity.error ||
      !identity.data.user ||
      identity.data.user.email?.toLowerCase() !== user.email.toLowerCase()
    )
      throw new ServiceUnavailableException(
        'Não foi possível verificar o destinatário do convite.',
      );
    const type = identity.data.user.email_confirmed_at ? 'recovery' : 'invite';
    if (delivery === 'email') {
      const preview = await auth.auth.admin.generateLink({
        type,
        email: user.email,
        options: { redirectTo },
      });
      if (
        preview.error ||
        preview.data.user?.id !== user.id ||
        preview.data.properties?.redirect_to !== redirectTo
      ) {
        const fallback = await this.invite(actorId, userId, 'link');
        return {
          ...fallback,
          message:
            'O envio requer configurar o endereço de ativação no provedor. Compartilhe o link abaixo.',
        };
      }
      const result =
        type === 'invite'
          ? await auth.auth.admin.inviteUserByEmail(user.email, { redirectTo })
          : await auth.auth.resetPasswordForEmail(user.email, { redirectTo });
      if (!result.error) {
        this.logger.log(
          JSON.stringify({
            event: 'partner_invitation_sent',
            actor_id: actorId,
            user_id: user.id,
          }),
        );
        return {
          delivery: 'email',
          message: 'Convite enviado. Verifique também a pasta de spam.',
        };
      }
      this.logger.warn(
        JSON.stringify({
          event: 'partner_invitation_delivery_failed',
          actor_id: actorId,
          user_id: user.id,
        }),
      );
    }
    const { data, error } = await auth.auth.admin.generateLink({
      type,
      email: user.email,
      options: { redirectTo },
    });
    if (error || !data.properties?.hashed_token || data.user?.id !== user.id)
      throw new ServiceUnavailableException(
        'Empresa e acesso estão cadastrados, mas o convite não foi gerado. Tente gerar outro link na lista.',
      );
    return {
      delivery: 'link',
      activationUrl: `${redirectTo}#token=${encodeURIComponent(data.properties.hashed_token)}&type=${type}`,
      ...(delivery === 'email'
        ? {
            message:
              'O envio de e-mail falhou. Compartilhe o link de ativação abaixo.',
          }
        : {}),
    };
  }

  async activate(dto: ActivatePartnerDto) {
    if (!!dto.tokenHash === !!dto.accessToken)
      throw new BadRequestException(
        'Informe somente uma credencial de ativação.',
      );
    const auth = this.auth();
    const identity = dto.tokenHash
      ? await auth.auth.verifyOtp({
          token_hash: dto.tokenHash,
          type: dto.verificationType ?? 'invite',
        })
      : await auth.auth.getUser(dto.accessToken!);
    if (identity.error || !identity.data.user)
      throw new UnauthorizedException(
        'Link inválido ou expirado. Solicite um novo convite.',
      );
    const userId = identity.data.user.id;
    const lock = `partner:activate:${userId}`;
    if (!(await this.redis.acquireLock(lock, 60)))
      throw new ConflictException('Ativação em andamento.');
    try {
      const user = await this.prisma.users.findUnique({
        where: { id: userId },
        include: { companies: { select: { status: true } } },
      });
      if (
        !user?.invitation_pending ||
        user.companies.status !== 'active' ||
        user.email?.toLowerCase() !== identity.data.user.email?.toLowerCase()
      )
        throw new UnauthorizedException(
          'Convite indisponível ou já utilizado.',
        );
      const { error } = await auth.auth.admin.updateUserById(userId, {
        password: dto.password,
        email_confirm: true,
      });
      if (error)
        throw new BadRequestException(
          'Não foi possível definir a senha. Solicite um novo link se necessário.',
        );
      await this.prisma.users.update({
        where: { id: userId },
        data: { invitation_pending: false, updated_at: new Date() },
      });
      await this.sessions.destroyAllForUser(userId);
      this.logger.log(
        JSON.stringify({
          event: 'partner_activated',
          user_id: userId,
          company_id: user.company_id,
        }),
      );
    } finally {
      await this.redis.releaseLock(lock);
    }
  }
}
