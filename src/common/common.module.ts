import { Module, Global } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { SupabaseModule } from './supabase/supabase.module';

@Global()
@Module({
    imports: [PrismaModule, SupabaseModule],
    exports: [PrismaModule, SupabaseModule],
})
export class CommonModule { }
