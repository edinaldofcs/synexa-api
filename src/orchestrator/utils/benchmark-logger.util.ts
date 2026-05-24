import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';

const benchmarkLogger = new Logger('Benchmark');

interface BenchmarkData {
  userMessage: string;
  aiResponse: string | null;
  provider: string;
  model: string;
  startTime: Date;
  endTime: Date;
  hadToolCalls: boolean;
  calledTools: string[];
  latencyMs: number;
  status: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cost?: number;
}

export function logBenchmark(data: BenchmarkData): void {
  try {
    const logsDir = path.join(process.env.LOG_DIR || '/tmp', 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const logFilePath = path.join(logsDir, 'benchmark.log');

    const logEntry = {
      timestamp: new Date().toISOString(),
      userMessage: data.userMessage,
      aiResponse: data.aiResponse,
      provider: data.provider,
      model: data.model,
      startTime: data.startTime instanceof Date ? data.startTime.toISOString() : new Date(data.startTime).toISOString(),
      endTime: data.endTime instanceof Date ? data.endTime.toISOString() : new Date(data.endTime).toISOString(),
      latencyMs: data.latencyMs,
      hadToolCalls: data.hadToolCalls,
      calledTools: data.calledTools,
      status: data.status,
      inputTokens: data.inputTokens || 0,
      outputTokens: data.outputTokens || 0,
      totalTokens: data.totalTokens || 0,
      cost: data.cost || 0,
    };

    fs.appendFileSync(logFilePath, JSON.stringify(logEntry) + '\n', 'utf8');
  } catch (error) {
    benchmarkLogger.error('Erro ao gravar log de benchmark:', error);
  }
}
