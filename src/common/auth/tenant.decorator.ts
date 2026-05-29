import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { tenantLocalStorage } from './tenant-context';

export const Tenant = createParamDecorator(
  (data: string, ctx: ExecutionContext) => {
    const store = tenantLocalStorage.getStore();
    if (!store) {
      return null;
    }
    return data ? store[data] : store;
  },
);
