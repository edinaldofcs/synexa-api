async function testEndpoints() {
  const cpf = '08334993942';

  console.log('--- Testando get_cpf ---');
  try {
    const res1 = await fetch('https://prd.naldofcs-ai.com/webhook/get_cpf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cpf }),
    });
    console.log('get_cpf Status:', res1.status, await res1.text());
  } catch (e: any) {
    console.log('get_cpf Error:', e.message);
  }

  console.log('\n--- Testando synexa_debts ---');
  try {
    const res2 = await fetch(
      'https://prd.naldofcs-ai.com/webhook/synexa_debts',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cpf }),
      },
    );
    console.log('synexa_debts Status:', res2.status, await res2.text());
  } catch (e: any) {
    console.log('synexa_debts Error:', e.message);
  }

  console.log('\n--- Testando synexa_offers ---');
  try {
    const res3 = await fetch(
      'https://prd.naldofcs-ai.com/webhook/synexa_offers',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cpf }),
      },
    );
    console.log('synexa_offers Status:', res3.status, await res3.text());
  } catch (e: any) {
    console.log('synexa_offers Error:', e.message);
  }

  console.log('\n--- Testando synexa_agreement ---');
  try {
    const res4 = await fetch(
      'https://prd.naldofcs-ai.com/webhook/synexa_agreement',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cpf, codigo_plano: 'NEG-001' }),
      },
    );
    console.log('synexa_agreement Status:', res4.status, await res4.text());
  } catch (e: any) {
    console.log('synexa_agreement Error:', e.message);
  }
}

testEndpoints();
