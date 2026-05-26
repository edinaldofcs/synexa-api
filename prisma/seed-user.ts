import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load production environment variables (which has the correct credentials)
dotenv.config({ path: path.join(__dirname, '../.env.prod') });

const prisma = new PrismaClient();
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function main() {
  console.log('Iniciando o seed da empresa e do usuário administrador...');

  // 1. Criar Empresa Padrão
  const company = await prisma.companies.upsert({
    where: { cnpj: '12.345.678/0001-90' },
    update: {},
    create: {
      name: 'Synexa Admin',
      cnpj: '12.345.678/0001-90',
      plan: 'scale',
      status: 'active',
    },
  });
  console.log(`Empresa criada/encontrada: ${company.name} | ID: ${company.id}`);

  // 2. Criar Usuário no Supabase Auth
  const email = 'admin@synexa.com.br';
  const password = process.env.SEED_ADMIN_PASSWORD || 'SynexaAdmin2026!';
  
  console.log(`Criando usuário no Supabase Auth: ${email}...`);
  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: 'Administrador Synexa' },
  });

  let userId: string;
  if (authError) {
    if (authError.message.includes('already registered')) {
      console.log('Usuário já existe no Supabase Auth. Buscando ID...');
      const listResult = await supabase.auth.admin.listUsers();
      if (listResult.error) throw listResult.error;
      const existingUser = listResult.data.users.find(u => u.email === email);
      if (!existingUser) throw new Error('Usuário reportado como existente mas não encontrado na lista.');
      userId = existingUser.id;
    } else {
      throw authError;
    }
  } else {
    userId = authUser.user!.id;
  }
  console.log(`ID do Usuário no Supabase Auth: ${userId}`);

  // 3. Criar Perfil de Usuário na Tabela 'users' do Prisma
  const userProfile = await prisma.users.upsert({
    where: { id: userId },
    update: {},
    create: {
      id: userId,
      company_id: company.id,
      name: 'Administrador Synexa',
      role: 'admin',
    },
  });
  console.log(`Perfil de Usuário criado/encontrado no banco: ${userProfile.name}`);
  console.log('\n🎉 Seed finalizado com sucesso!');
  console.log(`Utilize os dados abaixo para fazer login no localhost:`);
  console.log(`📧 E-mail: ${email}`);
  console.log(`🔒 Senha: ${password}`);
}

main()
  .catch(err => {
    console.error('Erro no seed do banco de dados:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
