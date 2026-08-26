import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsObject,
  IsArray,
  IsDate,
} from 'class-validator';

export class UpdateInteractionDto {
  @IsOptional()
  @IsString()
  agent_id?: string;

  @IsOptional()
  @IsString()
  agent_name?: string;

  @IsOptional()
  @IsString()
  client_name?: string;

  @IsOptional()
  @IsString()
  client_identifier?: string;

  // ── Funil ──
  @IsOptional()
  @IsBoolean()
  has_human_answer?: boolean;

  @IsOptional()
  human_answered_at?: Date | string;

  @IsOptional()
  @IsBoolean()
  is_right_party?: boolean;

  @IsOptional()
  right_party_at?: Date | string;

  @IsOptional()
  @IsBoolean()
  is_debt_presented?: boolean;

  @IsOptional()
  debt_presented_at?: Date | string;

  @IsOptional()
  @IsNumber()
  debt_amount?: number;

  @IsOptional()
  @IsBoolean()
  is_agreement_reached?: boolean;

  @IsOptional()
  agreement_at?: Date | string;

  @IsOptional()
  @IsString()
  agreement_id?: string;

  @IsOptional()
  @IsNumber()
  agreement_amount?: number;

  @IsOptional()
  @IsString()
  payment_method?: string;

  @IsOptional()
  @IsBoolean()
  is_promise_to_pay?: boolean;

  @IsOptional()
  promise_to_pay_at?: Date | string;

  @IsOptional()
  promise_due_date?: Date | string;

  @IsOptional()
  @IsNumber()
  promise_amount?: number;

  @IsOptional()
  @IsString()
  disposition?: string;

  @IsOptional()
  @IsString()
  service_step?: string;

  @IsOptional()
  @IsString()
  tagcode?: string;

  @IsOptional()
  @IsString()
  status?: string;

  // ── Telemetria e Voz ──
  @IsOptional()
  @IsNumber()
  barge_in_count?: number;

  @IsOptional()
  @IsNumber()
  avg_barge_in_latency_ms?: number;

  @IsOptional()
  @IsNumber()
  avg_first_byte_latency_ms?: number;

  @IsOptional()
  @IsBoolean()
  is_answering_machine?: boolean;

  @IsOptional()
  @IsString()
  call_id?: string;

  @IsOptional()
  @IsString()
  call_status?: string;

  @IsOptional()
  @IsString()
  recording_url?: string;

  @IsOptional()
  @IsNumber()
  duration_seconds?: number;

  @IsOptional()
  @IsNumber()
  billable_seconds?: number;

  @IsOptional()
  @IsString()
  hangup_cause?: string;

  // ── LLM ──
  @IsOptional()
  @IsString()
  llm_provider?: string;

  @IsOptional()
  @IsString()
  llm_model?: string;

  @IsOptional()
  @IsNumber()
  total_tokens?: number;

  @IsOptional()
  @IsNumber()
  prompt_tokens?: number;

  @IsOptional()
  @IsNumber()
  completion_tokens?: number;

  @IsOptional()
  @IsNumber()
  estimated_cost_usd?: number;

  @IsOptional()
  @IsNumber()
  avg_latency_ms?: number;

  // ── Pós-Atendimento ──
  @IsOptional()
  @IsString()
  sentiment?: string;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsArray()
  messages?: any[];

  @IsOptional()
  @IsObject()
  context_variables?: Record<string, any>;

  @IsOptional()
  started_at?: Date | string;

  @IsOptional()
  ended_at?: Date | string;
}
