import { Processor, Process } from '@nestjs/bull';
import type { Job } from 'bull';
import { BadRequestException, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI, { toFile } from 'openai';
import { PrismaService } from '../../common/prisma/prisma.service';
import { decrypt } from '../../common/utils/crypto.util';
import { JOB_PROCESS_MEDIA, QUEUE_MEDIA } from '../queue.constants';
import type { MediaJobData } from '../queue.service';
import { StorageProvider } from '../../media/providers/storage-provider.interface';
import { llmConfig } from '../../orchestrator/providers/llm-config';

@Processor(QUEUE_MEDIA)
export class MediaProcessor {
  private readonly logger = new Logger(MediaProcessor.name);
  private readonly supabase: SupabaseClient | null;
  private readonly isDevelopment = process.env.ENVIRONMENT === 'development';
  private readonly maxMediaBytes =
    Number(process.env.MAX_MEDIA_BYTES) || 26_214_400;

  constructor(
    private readonly prisma: PrismaService,
    @Inject('STORAGE_PROVIDER')
    private readonly storageProvider: StorageProvider | null,
    private readonly configService: ConfigService,
  ) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    this.supabase =
      supabaseUrl && serviceRoleKey
        ? createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
          })
        : null;
  }

  @Process({
    name: JOB_PROCESS_MEDIA,
    concurrency: Number(process.env.WORKER_MEDIA_CONCURRENCY) || 2,
  })
  async process(job: Job<MediaJobData>) {
    const asset = await this.prisma.media_assets.findUnique({
      where: { id: job.data.media_asset_id },
    });
    if (!asset) return;

    await this.prisma.media_assets.update({
      where: { id: asset.id },
      data: { status: 'processing', error_message: null },
    });

    try {
      if (asset.file_size && asset.file_size > this.maxMediaBytes) {
        this.logger.error(
          {
            media_asset_id: asset.id,
            file_size: asset.file_size,
            max_media_bytes: this.maxMediaBytes,
          },
          'Media asset exceeds the maximum allowed size; failing job before download',
        );
        throw new BadRequestException(
          `Media asset ${asset.id} exceeds the maximum allowed size (${asset.file_size} > ${this.maxMediaBytes} bytes)`,
        );
      }

      if (asset.mime_type.startsWith('audio/')) {
        const buffer = await this.loadAssetBytes(asset);
        const transcript = await this.transcribeAudio(asset, buffer);
        await this.prisma.media_assets.update({
          where: { id: asset.id },
          data: { transcript, status: 'ready' },
        });
        await this.ensureAssetPersisted(asset, buffer);
        return;
      }

      if (asset.mime_type.startsWith('image/')) {
        const buffer = await this.loadAssetBytes(asset);
        const ocrText = await this.describeImage(asset, buffer);
        await this.prisma.media_assets.update({
          where: { id: asset.id },
          data: { ocr_text: ocrText, status: 'ready' },
        });
        await this.ensureAssetPersisted(asset, buffer);
        return;
      }

      await this.prisma.media_assets.update({
        where: { id: asset.id },
        data: { status: 'ready' },
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown media processing error';
      this.logger.error(
        { media_asset_id: asset.id, error: message },
        'Media processing failed',
      );
      await this.prisma.media_assets.update({
        where: { id: asset.id },
        data: { status: 'failed', error_message: message },
      });
      throw error;
    }
  }

  private async transcribeAudio(
    asset: {
      id: string;
      client_id: string;
      mime_type: string;
      storage_bucket: string | null;
      storage_path: string | null;
      source_url: string | null;
    },
    buffer: Buffer,
  ) {
    const apiKey = await this.resolveClientApiKey(asset.client_id, 'groq');

    const file = await toFile(
      buffer,
      `${asset.id}.${this.audioExtension(asset.mime_type)}`,
      {
        type: asset.mime_type,
      },
    );

    const response = await new OpenAI({
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey,
    }).audio.transcriptions.create({
      file,
      // whisper-1 é id da OpenAI e não existe na Groq (model_not_found);
      // default Groq: whisper-large-v3-turbo (mesmo padrão do hybrid-stt)
      model: process.env.MEDIA_TRANSCRIPTION_MODEL || 'whisper-large-v3-turbo',
    });

    return response.text;
  }

  private async describeImage(
    asset: {
      client_id: string;
      mime_type: string;
      storage_bucket: string | null;
      storage_path: string | null;
      source_url: string | null;
    },
    buffer: Buffer,
  ) {
    let provider = llmConfig.mediaVisionProvider || 'gemini';
    let apiKey = await this.resolveClientApiKey(asset.client_id, provider);
    if (!apiKey && provider !== 'gemini') {
      provider = 'gemini';
      apiKey = await this.resolveClientApiKey(asset.client_id, 'gemini');
    }
    if (!apiKey) {
      apiKey = process.env.GEMINI_API_KEY || '';
      if (apiKey) provider = 'gemini';
    }
    if (!apiKey) {
      throw new BadRequestException(
        `Chave de API para visão (${provider}) não configurada. Configure o Google Gemini em Configurações > Provedores.`,
      );
    }
    const model =
      process.env.MEDIA_VISION_MODEL ||
      (llmConfig.visionModels as Record<string, string>)[provider] ||
      'gemini-2.5-flash-lite';

    const prompt =
      'Descreva esta imagem em português de forma concisa. Apenas a descrição, sem comentários adicionais. Se houver texto visível, transcreva-o.';

    this.logger.log(
      `Processando visão com provider: ${provider}, modelo: ${model}`,
    );

    switch (provider) {
      case 'groq':
        return this.describeWithOpenAICompatible(
          buffer,
          asset.mime_type,
          prompt,
          model,
          { baseURL: 'https://api.groq.com/openai/v1', apiKey },
        );

      case 'openrouter':
        return this.describeWithOpenAICompatible(
          buffer,
          asset.mime_type,
          prompt,
          model,
          {
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey,
            defaultHeaders: {
              'HTTP-Referer': 'https://github.com/antigravity',
              'X-Title': 'Synexa',
            },
          },
        );

      default:
        return this.describeWithGemini(
          buffer,
          asset.mime_type,
          prompt,
          model,
          apiKey,
        );
    }
  }

  private async describeWithGemini(
    buffer: Buffer,
    mimeType: string,
    prompt: string,
    model: string,
    apiKey: string,
  ) {
    const genAI = new GoogleGenerativeAI(apiKey);
    const geminiModel = genAI.getGenerativeModel({ model });

    const result = await geminiModel.generateContent([
      prompt,
      {
        inlineData: {
          mimeType,
          data: buffer.toString('base64'),
        },
      },
    ]);

    return result.response.text();
  }

  private async describeWithOpenAICompatible(
    buffer: Buffer,
    mimeType: string,
    prompt: string,
    model: string,
    options: {
      baseURL: string;
      apiKey: string;
      defaultHeaders?: Record<string, string>;
    },
  ) {
    const client = new OpenAI({
      baseURL: options.baseURL,
      apiKey: options.apiKey,
      ...(options.defaultHeaders
        ? { defaultHeaders: options.defaultHeaders }
        : {}),
    });

    const response = await client.chat.completions.create({
      model,
      max_completion_tokens: 500,
      temperature: 0.2,
      messages: [
        {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: prompt },
            {
              type: 'image_url' as const,
              image_url: {
                url: `data:${mimeType};base64,${buffer.toString('base64')}`,
              },
            },
          ],
        },
      ],
    });

    const raw = response.choices[0]?.message?.content || '';
    return this.stripThinkingBlock(raw);
  }

  private stripThinkingBlock(content: string): string {
    const endTag = '</think>';
    const endIdx = content.indexOf(endTag);
    if (endIdx !== -1) {
      const after = content.substring(endIdx + endTag.length).trim();
      return this.stripEnglishPreamble(after);
    }

    const startTag = '<think>';
    const startIdx = content.indexOf(startTag);
    if (startIdx !== -1) {
      const remaining = content.substring(startIdx + startTag.length).trim();
      return this.stripEnglishPreamble(remaining);
    }

    return this.stripEnglishPreamble(content);
  }

  private stripEnglishPreamble(content: string): string {
    const markers = [
      'A imagem mostra',
      'A imagem exibe',
      'A imagem apresenta',
      'A foto mostra',
      'A fotografia mostra',
      'A cena mostra',
      'Na imagem',
      'Trata-se de',
      'Esta imagem',
      'Esta foto',
      'A imagem',
      'A fotografia',
      'A cena',
    ];
    let bestIdx = -1;
    for (const marker of markers) {
      const idx = content.lastIndexOf(marker);
      if (idx > bestIdx) bestIdx = idx;
    }
    if (bestIdx > 0) {
      return content.substring(bestIdx).trim();
    }
    return content.trim();
  }

  private async resolveClientApiKey(
    clientId: string,
    provider: string,
  ): Promise<string> {
    const client = await this.prisma.painel_clients.findUnique({
      where: { id: clientId },
      select: { metadata: true },
    });

    const providers = (client?.metadata as any)?.llm_providers || {};
    const config = providers[provider];
    let apiKey = config?.apiKey || '';

    if (apiKey && typeof apiKey === 'string' && apiKey.startsWith('enc:')) {
      const encryptionKey = this.configService.get<string>('ENCRYPTION_KEY');
      if (encryptionKey) {
        try {
          apiKey = decrypt(apiKey.slice(4), encryptionKey);
        } catch (err) {
          this.logger.warn(
            { provider, clientId, error: (err as Error).message },
            'Falha ao descriptografar API key',
          );
          apiKey = '';
        }
      }
    }

    return apiKey;
  }

  private async ensureAssetPersisted(
    asset: {
      id: string;
      company_id: string;
      client_id: string;
      source_url: string | null;
      storage_bucket: string | null;
      storage_path: string | null;
      mime_type: string;
    },
    buffer: Buffer,
  ) {
    if (asset.storage_bucket && asset.storage_path) return;
    if (!asset.source_url) return;

    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'media-assets';
    const ext = this.mimeToExt(asset.mime_type);
    const storagePath = `companies/${asset.company_id}/clients/${asset.client_id}/${asset.id}.${ext}`;

    this.logger.log({ storagePath }, 'Persistindo mídia no storage');

    if (this.isDevelopment && this.storageProvider) {
      const { error } = await this.storageProvider.upload(
        bucket,
        storagePath,
        buffer,
        {
          contentType: asset.mime_type,
        },
      );
      if (error)
        this.logger.error({ error }, 'Falha ao persistir no storage local');
    } else if (this.supabase) {
      const { error } = await this.supabase.storage
        .from(bucket)
        .upload(storagePath, buffer, {
          contentType: asset.mime_type,
          upsert: true,
        });
      if (error) {
        this.logger.error({ error }, 'Falha ao persistir no storage Supabase');
        return;
      }
    } else {
      this.logger.warn('Nenhum storage configurado, pulando persistência');
      return;
    }

    await this.prisma.media_assets.update({
      where: { id: asset.id },
      data: {
        storage_bucket: bucket,
        storage_path: storagePath,
        file_size: buffer.length,
      },
    });

    this.logger.log({ storagePath }, 'Mídia persistida com sucesso');
  }

  private mimeToExt(mimeType: string): string {
    const parts = mimeType.split('/');
    if (parts.length === 2) {
      if (parts[1] === 'mpeg') return 'mp3';
      if (parts[1] === 'quicktime') return 'mov';
      if (parts[1] === 'x-m4a') return 'm4a';
      return parts[1].split('+')[0].split(';')[0];
    }
    return 'bin';
  }

  private async loadAssetBytes(asset: {
    storage_bucket: string | null;
    storage_path: string | null;
    source_url: string | null;
  }): Promise<Buffer> {
    if (asset.storage_bucket && asset.storage_path) {
      if (this.isDevelopment && this.storageProvider) {
        const { data, error } = await this.storageProvider.download(
          asset.storage_bucket,
          asset.storage_path,
        );
        if (error)
          throw new BadRequestException(`Storage download failed: ${error}`);
        return data;
      }

      if (!this.supabase)
        throw new BadRequestException('Supabase storage is not configured');

      const { data, error } = await this.supabase.storage
        .from(asset.storage_bucket)
        .download(asset.storage_path);

      if (error)
        throw new BadRequestException(
          `Storage download failed: ${error.message}`,
        );

      return Buffer.from(await data.arrayBuffer());
    }

    if (asset.source_url) {
      const response = await fetch(asset.source_url);
      if (!response.ok)
        throw new BadRequestException(`Source URL returned ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    }

    throw new BadRequestException(
      'Media asset has no storage path or source URL',
    );
  }

  private audioExtension(mimeType: string) {
    if (mimeType.includes('mpeg')) return 'mp3';
    if (mimeType.includes('wav')) return 'wav';
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('webm')) return 'webm';
    return 'audio';
  }
}
