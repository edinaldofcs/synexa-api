import { AsyncLocalStorage } from 'async_hooks';

export interface TenantStore {
  companyId: string;
  userId?: string;
  role?: string;
}

export const tenantLocalStorage = new AsyncLocalStorage<TenantStore>();
