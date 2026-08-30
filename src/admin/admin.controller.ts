import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminService, ActorContext } from './admin.service';
import { Roles } from '../common/auth/roles.decorator';
import { RolesGuard } from '../common/auth/roles.guard';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { ROLES } from '../common/auth/roles.constants';
import { AdminCreateCompanyDto } from './dto/create-company.dto';
import { AdminCreateUserDto } from './dto/create-user.dto';
import { AdminUpdateUserDto } from './dto/update-user.dto';

@UseGuards(RolesGuard)
@Throttle({ default: { limit: 20, ttl: 60000 } })
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ── Companies: exclusivo da plataforma ─────────────────────────────────

  @Post('companies')
  @Roles(ROLES.PLATFORM_ADMIN)
  async createCompany(@Body() body: AdminCreateCompanyDto) {
    return this.adminService.createCompany(body);
  }

  @Get('companies')
  @Roles(ROLES.PLATFORM_ADMIN)
  async listCompanies() {
    return this.adminService.listCompanies();
  }

  @Patch('companies/:id')
  @Roles(ROLES.PLATFORM_ADMIN)
  async updateCompany(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { name?: string; status?: string },
  ) {
    return this.adminService.updateCompany(id, body);
  }

  @Delete('companies/:id')
  @Roles(ROLES.PLATFORM_ADMIN)
  async deleteCompany(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('confirm') confirm?: string,
  ) {
    if (confirm !== id) {
      throw new BadRequestException(
        'Confirmation required: provide ?confirm=<company_id>',
      );
    }
    return this.adminService.deleteCompany(id);
  }

  // ── Users: plataforma global / empresa restrito ao próprio tenant ───────

  @Get('users')
  @Roles(ROLES.PLATFORM_ADMIN, ROLES.COMPANY_ADMIN)
  async listUsers(@CurrentUser() actor: ActorContext) {
    return this.adminService.listUsers(actor);
  }

  @Get('users/:id')
  @Roles(ROLES.PLATFORM_ADMIN, ROLES.COMPANY_ADMIN)
  async getUser(
    @CurrentUser() actor: ActorContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adminService.getUser(actor, id);
  }

  @Post('users')
  @Roles(ROLES.PLATFORM_ADMIN, ROLES.COMPANY_ADMIN)
  async createUser(
    @CurrentUser() actor: ActorContext,
    @Body() body: AdminCreateUserDto,
  ) {
    return this.adminService.createUser(actor, body);
  }

  @Patch('users/:id')
  @Roles(ROLES.PLATFORM_ADMIN, ROLES.COMPANY_ADMIN)
  async updateUser(
    @CurrentUser() actor: ActorContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AdminUpdateUserDto,
  ) {
    return this.adminService.updateUser(actor, id, body);
  }

  @Delete('users/:id')
  @Roles(ROLES.PLATFORM_ADMIN, ROLES.COMPANY_ADMIN)
  async deleteUser(
    @CurrentUser() actor: ActorContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adminService.deleteUser(actor, id);
  }

  @Post('users/:id/reset-password')
  @Roles(ROLES.PLATFORM_ADMIN, ROLES.COMPANY_ADMIN)
  async resetUserPassword(
    @CurrentUser() actor: ActorContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adminService.resetUserPassword(actor, id);
  }

  // ── LGPD: direito ao esquecimento do titular final (art. 18, VI) ────────

  @Delete('end-users/:id')
  @Roles(ROLES.PLATFORM_ADMIN, ROLES.COMPANY_ADMIN)
  async eraseEndUser(
    @CurrentUser() actor: ActorContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('confirm') confirm?: string,
  ) {
    if (confirm !== id) {
      throw new BadRequestException(
        'Confirmation required: provide ?confirm=<end_user_id>',
      );
    }
    return this.adminService.eraseEndUserData(actor, id);
  }
}
