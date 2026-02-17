import { Controller, Post, Body } from '@nestjs/common';
import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post('create-company')
  async createCompany(
    @Body() body: { name: string; cnpj: string; plan?: string },
  ) {
    return this.adminService.createCompany(body);
  }

  @Post('create-user')
  async createUser(
    @Body()
    body: {
      email: string;
      password?: string;
      role?: string;
      company_id: string;
      name?: string;
    },
  ) {
    return this.adminService.createUser(body);
  }
}
