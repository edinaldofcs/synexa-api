import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PrismaService } from '../common/prisma/prisma.service';
import { CurrentUser } from '../common/auth/current-user.decorator';

export class TemplateScopeDto {
  @IsOptional() @IsUUID() clientId?: string;
}
export class SaveTemplateDto extends TemplateScopeDto {
  @IsOptional() @IsUUID() expectedCompanyId?: string;
  @IsString() @Matches(/^[a-zA-Z0-9_-]{1,100}$/) id: string;
  @IsString() @MinLength(1) @MaxLength(200) title: string;
  @IsIn([
    'persona',
    'step_goal',
    'rules',
    'tools',
    'style',
    'closing',
    'human_handover',
    'custom',
  ])
  category: string;
  @IsString() @MaxLength(100000) content: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(40) icon?: string;
}
@Injectable()
export class PromptTemplatesService {
  constructor(private readonly prisma: PrismaService) {}
  private async scope(companyId: string, clientId?: string) {
    if (!companyId) throw new UnauthorizedException();
    if (
      clientId &&
      !(await this.prisma.painel_clients.findFirst({
        where: { id: clientId, company_id: companyId },
        select: { id: true },
      }))
    )
      throw new NotFoundException('Cliente não encontrado');
    return { company_id: companyId, scope: clientId || 'global' };
  }
  async list(companyId: string, clientId?: string) {
    return this.prisma.prompt_templates.findMany({
      where: await this.scope(companyId, clientId),
      orderBy: { created_at: 'asc' },
      take: 1000,
    });
  }
  async save(companyId: string, dto: SaveTemplateDto) {
    if (dto.expectedCompanyId && dto.expectedCompanyId !== companyId)
      throw new UnauthorizedException('A empresa da sessão mudou');
    const scope = await this.scope(companyId, dto.clientId);
    const data = {
      title: dto.title,
      category: dto.category,
      content: dto.content,
      description: dto.description || '',
      icon: dto.icon || '',
    };
    return this.prisma.prompt_templates.upsert({
      where: { company_id_scope_id: { ...scope, id: dto.id } },
      create: {
        ...scope,
        ...data,
        id: dto.id,
        client_id: dto.clientId || null,
      },
      update: data,
    });
  }
  async remove(companyId: string, id: string, clientId?: string) {
    const scope = await this.scope(companyId, clientId);
    await this.prisma.prompt_templates.deleteMany({ where: { ...scope, id } });
    return { ok: true };
  }
}
@Controller('prompt-templates')
export class PromptTemplatesController {
  constructor(private readonly templates: PromptTemplatesService) {}
  @Get() list(
    @CurrentUser() user: { company_id: string },
    @Query() query: TemplateScopeDto,
  ) {
    return this.templates.list(user?.company_id, query.clientId);
  }
  @Post() save(
    @CurrentUser() user: { company_id: string },
    @Body() body: SaveTemplateDto,
  ) {
    return this.templates.save(user?.company_id, body);
  }
  @Delete(':id') remove(
    @CurrentUser() user: { company_id: string },
    @Param('id') id: string,
    @Query() query: TemplateScopeDto,
  ) {
    return this.templates.remove(user?.company_id, id, query.clientId);
  }
}
@Module({
  controllers: [PromptTemplatesController],
  providers: [PromptTemplatesService],
})
export class PromptTemplatesModule {}
