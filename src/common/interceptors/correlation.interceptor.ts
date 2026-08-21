import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';

@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const requestId =
      (req.headers['x-request-id'] as string) ||
      (req.headers['x-correlation-id'] as string) ||
      randomUUID();

    // Propaga request_id no objeto e no header de resposta
    req.headers['x-request-id'] = requestId;
    res.setHeader('x-request-id', requestId);

    const startTime = Date.now();
    const { method, originalUrl } = req;

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - startTime;
          const statusCode = res.statusCode;
          this.logger.log({
            request_id: requestId,
            method,
            url: originalUrl,
            status_code: statusCode,
            duration_ms: duration,
            company_id:
              (req as any).user?.companyId ||
              (req as any).user?.company_id ||
              undefined,
          });
        },
        error: (err) => {
          const duration = Date.now() - startTime;
          this.logger.error({
            request_id: requestId,
            method,
            url: originalUrl,
            error: err.message,
            duration_ms: duration,
            company_id:
              (req as any).user?.companyId ||
              (req as any).user?.company_id ||
              undefined,
          });
        },
      }),
    );
  }
}
