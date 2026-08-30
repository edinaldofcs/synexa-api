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
