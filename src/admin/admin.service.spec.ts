import { NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';

describe('AdminService - deleteCompany', () => {
  const buildTx = () => {
    const model = () => ({
      deleteMany: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
    });
    const tx: Record<string, any> = {
      webhook_deliveries: { deleteMany: jest.fn() },
      webhook_endpoints: { deleteMany: jest.fn() },
      tool_calls: { deleteMany: jest.fn() },
      agent_runs: { deleteMany: jest.fn() },
      message_events: { deleteMany: jest.fn() },
      business_events: { deleteMany: jest.fn() },
      inbound_events: { deleteMany: jest.fn() },
      outbox_events: { deleteMany: jest.fn() },
      knowledge_embeddings: { deleteMany: jest.fn() },
      knowledge_chunks: { deleteMany: jest.fn() },
      knowledge_documents: { deleteMany: jest.fn() },
      knowledge_bases: { deleteMany: jest.fn() },
      credential_audit_logs: { deleteMany: jest.fn() },
      provider_credentials: { deleteMany: jest.fn() },
      painel_interactions: { deleteMany: jest.fn() },
      voice_session_telemetry: { deleteMany: jest.fn() },
      telephony_endpoints: { deleteMany: jest.fn() },
      workflow_versions: { deleteMany: jest.fn() },
      media_assets: { deleteMany: jest.fn() },
      messages: { deleteMany: jest.fn() },
      conversations: { deleteMany: jest.fn() },
      channel_identities: { deleteMany: jest.fn() },
      end_users: { deleteMany: jest.fn() },
      channel_connections: { deleteMany: jest.fn() },
      painel_clients: model(),
      users: { deleteMany: jest.fn() },
      companies: model(),
      $transaction: jest.fn(),
    };
    tx.painel_clients.deleteMany = jest.fn();
    tx.users.deleteMany = jest.fn();
    tx.companies.delete = jest.fn().mockResolvedValue({ id: 'company-1' });
    tx.companies.findUnique.mockResolvedValue({ id: 'company-1' });
    tx.$transaction.mockImplementation(async (fn: any) => fn(tx));
    return tx;
  };

  const buildService = (tx: Record<string, any>) =>
    new AdminService(tx as never, {} as never);

  it('executa a exclusão completa dentro de uma única transação', async () => {
    const tx = buildTx();
    const service = buildService(tx);

    await service.deleteCompany('company-1');

    expect(tx.$transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(tx.painel_clients.deleteMany).toHaveBeenCalledWith({
      where: { company_id: 'company-1' },
    });
    expect(tx.users.deleteMany).toHaveBeenCalledWith({
      where: { company_id: 'company-1' },
    });
    expect(tx.companies.delete).toHaveBeenCalledWith({
      where: { id: 'company-1' },
    });
    expect(tx.webhook_endpoints.deleteMany).toHaveBeenCalled();
    expect(tx.knowledge_bases.deleteMany).toHaveBeenCalledWith({
      where: { company_id: 'company-1' },
    });
  });

  it('retorna a empresa removida', async () => {
    const tx = buildTx();
    const service = buildService(tx);

    const result = await service.deleteCompany('company-1');

    expect(result).toEqual({ id: 'company-1' });
  });

  it('rejeita empresa inexistente antes de qualquer delete', async () => {
    const tx = buildTx();
    tx.companies.findUnique = jest.fn().mockResolvedValue(null);
    const service = buildService(tx);

    await expect(service.deleteCompany('company-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.$transaction).not.toHaveBeenCalled();
  });

  it('propaga falha da transação (delete da empresa ocorre só dentro dela)', async () => {
    const tx = buildTx();
    tx.painel_clients.findUnique.mockResolvedValue({ id: 'company-1' });
    tx.$transaction.mockRejectedValue(new Error('fk constraint failed'));
    const service = buildService(tx);

    await expect(service.deleteCompany('company-1')).rejects.toThrow(
      'fk constraint',
    );
    expect(tx.companies.delete).not.toHaveBeenCalled();
  });
});

describe('AdminService - eraseEndUserData (LGPD art. 18, VI)', () => {
  const buildTx = () => {
    const tx: Record<string, any> = {
      conversations: { findMany: jest.fn().mockResolvedValue([{ id: 'conv-1' }, { id: 'conv-2' }]), deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
      channel_identities: { findMany: jest.fn().mockResolvedValue([{ external_user_id: '5511999@s.whatsapp.net', normalized_phone: '+5511999999999' }]), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      tool_calls: { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) },
      agent_runs: { deleteMany: jest.fn().mockResolvedValue({ count: 5 }) },
      media_assets: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
      voice_session_telemetry: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      messages: { deleteMany: jest.fn().mockResolvedValue({ count: 40 }) },
      business_events: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      painel_interactions: { updateMany: jest.fn().mockResolvedValue({ count: 4 }) },
      end_users: { findUnique: jest.fn().mockResolvedValue({ id: 'eu-1', name: 'Joao da Silva', company_id: 'company-1' }), delete: jest.fn().mockResolvedValue({ id: 'eu-1' }) },
      $transaction: jest.fn(),
    };
    tx.$transaction.mockImplementation(async (fn: any) => fn(tx));
    return tx;
  };

  const buildService = (tx: Record<string, any>) =>
    new AdminService(tx as never, {} as never);

  it('platform_admin apaga titular dentro de uma unica transacao', async () => {
    const tx = buildTx();
    const service = buildService(tx);

    const result = await service.eraseEndUserData(
      { id: 'admin-1', role: 'platform_admin' },
      'eu-1',
    );

    expect(result.erased).toBe(true);
    expect(tx.$transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(tx.tool_calls.deleteMany).toHaveBeenCalledWith({
      where: { conversation_id: { in: ['conv-1', 'conv-2'] } },
    });
    expect(tx.voice_session_telemetry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ caller_number: null }) }),
    );
    expect(tx.painel_interactions.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ company_id: 'company-1' }),
      }),
    );
    expect(tx.end_users.delete).toHaveBeenCalledWith({ where: { id: 'eu-1' } });
  });

  it('anonimiza interacoes pelos identificadores do titular (telefone/JID) e nome', async () => {
    const tx = buildTx();
    const service = buildService(tx);

    await service.eraseEndUserData({ id: 'admin-1', role: 'platform_admin' }, 'eu-1');

    const where = tx.painel_interactions.updateMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { client_identifier: { in: ['5511999@s.whatsapp.net', '+5511999999999'] } },
        { client_name: 'Joao da Silva' },
      ]),
    );
  });

  it('company_admin de outra empresa recebe Forbidden antes da transacao', async () => {
    const tx = buildTx();
    const service = buildService(tx);

    await expect(
      service.eraseEndUserData(
        { id: 'adm-2', role: 'company_admin', company_id: 'company-OTHER' },
        'eu-1',
      ),
    ).rejects.toThrow('Titular de outra empresa');
    expect(tx.$transaction).not.toHaveBeenCalled();
  });

  it('company_admin da mesma empresa consegue apagar', async () => {
    const tx = buildTx();
    const service = buildService(tx);

    const result = await service.eraseEndUserData(
      { id: 'adm-3', role: 'company_admin', company_id: 'company-1' },
      'eu-1',
    );
    expect(result.erased).toBe(true);
  });

  it('titular inexistente -> NotFound antes de qualquer operacao', async () => {
    const tx = buildTx();
    tx.end_users.findUnique = jest.fn().mockResolvedValue(null);
    const service = buildService(tx);

    await expect(
      service.eraseEndUserData({ id: 'admin-1', role: 'platform_admin' }, 'eu-x'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.$transaction).not.toHaveBeenCalled();
  });
});
