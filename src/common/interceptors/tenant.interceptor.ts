import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { extractTenantContext } from '../utils/tenant-access.helper';
import { tenantLocalStorage } from '../auth/tenant-context';

@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (user) {
      try {
        const tenantCtx = extractTenantContext(user);
        if (tenantCtx.companyId) {
          return new Observable((subscriber) => {
            tenantLocalStorage.run(
              {
                companyId: tenantCtx.companyId,
                userId: tenantCtx.userId,
                role: tenantCtx.role,
              },
              () => {
                next.handle().subscribe({
                  next: (val) => subscriber.next(val),
                  error: (err) => subscriber.error(err),
                  complete: () => subscriber.complete(),
                });
              },
            );
          });
        }
      } catch (error) {
        // Prossegue sem tenant se não conseguir extrair (ex: rota sem autenticação ou dev-only)
      }
    }

    return next.handle();
  }
}
