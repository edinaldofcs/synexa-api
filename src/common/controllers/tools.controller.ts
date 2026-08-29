import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { NativeToolsService } from '../services/native-tools.service';

@Public()
@Controller(['v1/tools', 'tools'])
export class ToolsController {
  constructor(private readonly nativeToolsService: NativeToolsService) {}

  @Post([
    'validate-variable',
    'validate_variable',
    'validate-variable-part',
    'validate_variable_part',
  ])
  @HttpCode(HttpStatus.OK)
  validateVariable(
    @Body()
    body: {
      variable_name?: string;
      name?: string;
      match_type?: string;
      type?: string;
      value_to_check?: string;
      value?: string;
      length?: number;
      session_data?: Record<string, unknown>;
      [key: string]: unknown;
    },
  ) {
    const sessionState = (body.session_data || body.state || body) as Record<
      string,
      unknown
    >;
    return this.nativeToolsService.validateVariablePart(body, sessionState);
  }

  @Post([
    'set-session-variable',
    'set_session_variable',
    'set-call-variable',
    'set_call_variable',
    'set-variable',
    'set_variable',
  ])
  @HttpCode(HttpStatus.OK)
  setSessionVariable(
    @Body()
    body: {
      name?: string;
      key?: string;
      value?: string | number | boolean;
      session_data?: Record<string, unknown>;
      [key: string]: unknown;
    },
  ) {
    const sessionState = (body.session_data || body.state || {}) as Record<
      string,
      unknown
    >;
    return this.nativeToolsService.setSessionVariable(body, sessionState);
  }

  @Post([
    'calculate-financial',
    'calculate_financial',
    'calculate-discount-installment',
    'calculate_discount_installment',
  ])
  @HttpCode(HttpStatus.OK)
  calculateFinancial(
    @Body()
    body: {
      operation?: string;
      principal_amount?: number | string;
      amount?: number | string;
      valor?: number | string;
      discount_percentage?: number;
      discount_fixed_amount?: number;
      installments_count?: number;
      interest_rate_monthly?: number;
      [key: string]: unknown;
    },
  ) {
    return this.nativeToolsService.calculateFinancial(body);
  }
}
