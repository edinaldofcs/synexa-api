
import dotenv from 'dotenv';
dotenv.config();

const API_URL = 'http://localhost:3000/api/admin';

async function seed() {
    console.log('🌱 Starting Seed Process...');

    // 1. Create Company
    const companyName = 'Minha Empresa Demo';
    console.log(`\nCreating Company: "${companyName}"...`);

    const companyRes = await fetch(`${API_URL}/create-company`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: companyName,
            cnpj: '00.000.000/0001-00',
            plan: 'enterprise'
        })
    });

    const companyData = await companyRes.json();

    if (!companyData.success) {
        console.error('❌ Failed to create company:', companyData);
        return;
    }

    const companyId = companyData.company.id;
    console.log('✅ Company Created:', companyId);

    // 2. Create Admin User
    const adminEmail = 'edinaldofcs@gmail.com';
    const adminName = 'Admin User';
    const adminPassword = 'password123';

    console.log(`\nCreating Admin User: ${adminEmail}...`);

    const userRes = await fetch(`${API_URL}/create-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: adminEmail,
            password: adminPassword,
            name: adminName,
            role: 'admin',
            company_id: companyId
        })
    });

    const userData = await userRes.json();

    if (!userData.success) {
        console.error('❌ Failed to create user:', userData);
        return;
    }

    if (userData.existed) {
        console.log('✅ Admin User already exists:', userData.user.id);
    } else {
        console.log('✅ Admin User Created:', userData.user);
    }

    console.log('\n🎉 Seed Complete! You can now login with:');
    console.log(`Email: ${adminEmail}`);
    console.log(`Password: ${adminPassword}`);
}

seed();
