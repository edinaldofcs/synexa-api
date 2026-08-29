import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ClientMetadataService } from '../common/metadata/client-metadata.service';
import { ApisRepository } from './repositories/apis.repository';
import { CreateApiDto } from './dto/create-api.dto';
import { UpdateApiDto } from './dto/update-api.dto';

@Injectable()
export class ApisService {
  constructor(
    private readonly apisRepository: ApisRepository,
    private readonly metadataService: ClientMetadataService,
    private readonly prisma: PrismaService,
  ) {}

  private async validateClientAccess(clientId: string, companyId: string) {
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`Client not found`);
    }
  }

  async create(clientId: string, payload: CreateApiDto, companyId: string) {
    await this.validateClientAccess(clientId, companyId);
    const api = await this.apisRepository.create(clientId, payload as any);
    void this.metadataService.refresh(clientId);
    return api;
  }

  async findAllByClient(clientId: string, companyId: string) {
    await this.validateClientAccess(clientId, companyId);
    return this.apisRepository.findAllByClient(clientId);
  }

  async findOne(id: string, companyId: string) {
    const api = await this.apisRepository.findOne(id);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: api.client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`API with ID ${id} not found`);
    }
    return api;
  }

  async update(id: string, payload: UpdateApiDto, companyId: string) {
    const existing = await this.apisRepository.findOne(id);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: existing.client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`API with ID ${id} not found`);
    }
    const api = await this.apisRepository.update(id, payload as any);
    const clientId = api?.client_id;
    if (clientId) void this.metadataService.refresh(clientId);
    return api;
  }

  async remove(id: string, companyId: string) {
    const existing = await this.apisRepository.findOne(id);
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: existing.client_id },
      select: { company_id: true },
    });
    if (!client || client.company_id !== companyId) {
      throw new NotFoundException(`API with ID ${id} not found`);
    }
    const { api, result } = await this.apisRepository.remove(id);
    const clientId = api?.client_id;
    if (clientId) void this.metadataService.refresh(clientId);
    return result;
  }

  async testProxy(payload: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  }) {
    if (!payload.url || !payload.url.startsWith('http')) {
      throw new BadRequestException(
        'URL inválida. Deve iniciar com http:// ou https://',
      );
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const isPostOrPut =
        payload.method &&
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
          payload.method.toUpperCase(),
        );
      const bodyToSend =
        isPostOrPut && payload.body
          ? typeof payload.body === 'string'
            ? payload.body
            : JSON.stringify(payload.body)
          : undefined;

      let targetUrl = payload.url;
      if (targetUrl.startsWith('/')) {
        const port = process.env.PORT || 3000;
        targetUrl = `http://127.0.0.1:${port}${targetUrl}`;
      }

      const response = await fetch(targetUrl, {
        method: payload.method || 'GET',
        headers: {
          'User-Agent': 'Synexa-Api-Tester/1.0',
          ...(payload.headers || {}),
        },
        body: bodyToSend,
        signal: controller.signal,
      });

      const latency = Date.now() - startTime;
      const text = await response.text();
      let rawData: any;
      try {
        rawData = JSON.parse(text);
      } catch {
        rawData = text;
      }

      return {
        success: true,
        status: response.status,
        statusText: response.statusText,
        latency,
        rawData,
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        success: false,
        status: 0,
        statusText: 'Network / Connection Error',
        latency,
        error:
          err.name === 'AbortError'
            ? 'Tempo limite esgotado (15s)'
            : err.message,
        rawData: null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
