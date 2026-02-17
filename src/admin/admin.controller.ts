import { Controller, Post, Body } from '@nestjs/common';
import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
    constructor(private readonly adminService: AdminService) { }

    @Post('create-company')
    async createCompany(@Body() body: any) {
        return this.adminService.createCompany(body);
    }

    @Post('create-user')
    async createUser(@Body() body: any) {
        return this.adminService.createUser(body);
    }
}
