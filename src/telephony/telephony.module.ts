import { Module } from '@nestjs/common';
import { SipAccessController } from './sip-access.controller';
import { SipAccessService } from './sip-access.service';
import { TelephonyEndpointsController } from './telephony-endpoints.controller';
import { TelephonyEndpointResolverService } from '../voice/services/telephony-endpoint-resolver.service';

/**
 * API admin de roteamento telefônico (telephony_endpoints).
 * Vive na API principal (:3000), protegida pelo AuthGuard global — o
 * processo de voz (:3001) não expõe CRUD.
 */
@Module({
  controllers: [TelephonyEndpointsController, SipAccessController],
  providers: [TelephonyEndpointResolverService, SipAccessService],
})
export class TelephonyModule {}
