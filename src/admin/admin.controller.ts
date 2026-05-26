import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminService } from './admin.service';
import { Roles } from '../common/auth/roles.decorator';
import { RolesGuard } from '../common/auth/roles.guard';
import { AdminCreateCompanyDto } from './dto/create-company.dto';
import { AdminCreateUserDto } from './dto/create-user.dto';

@UseGuards(RolesGuard)
@Roles('admin')
@Throttle({ default: { limit: 5, ttl: 60000 } })
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post('create-company')
  @Roles('admin')
  async createCompany(@Body() body: AdminCreateCompanyDto) {
    return this.adminService.createCompany(body);
  }

  @Post('create-user')
  @Roles('admin')
  async createUser(@Body() body: AdminCreateUserDto) {
    return this.adminService.createUser(body);
  }
}
