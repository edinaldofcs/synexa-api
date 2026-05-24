import { Processor, Process } from '@nestjs/bull';
import type { Job } from 'bull';
import { BadRequestException, Logger } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI, { toFile } from 'openai';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JOB_PROCESS_MEDIA, QUEUE_MEDIA } from '../queue.constants';
import type { MediaJobData } from '../queue.service';

@Processor(QUEUE_MEDIA)
export class MediaProcessor {
  private readonly logger = new Logger(MediaProcessor.name);
  private readonly supabase: SupabaseClient | null;
  private readonly openai: OpenAI | null;
  private readonly gemini: GoogleGenerativeAI | null;

  constructor(private readonly prisma: PrismaService) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    this.supabase = supabaseUrl && serviceRoleKey
      ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
      : null;

    this.openai = process.env.OPENAI_API_KEY
      ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
      : null;

    this.gemini = process.env.GEMINI_API_KEY
      ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
      : null;
  }

  @Process(JOB_PROCESS_MEDIA)
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
      if (asset.mime_type.startsWith('audio/')) {
        const transcript = await this.transcribeAudio(asset);
        await this.prisma.media_assets.update({
          where: { id: asset.id },
          data: { transcript, status: 'ready' },
        });
        return;
      }

      if (asset.mime_type.startsWith('image/')) {
        const ocrText = await this.describeImage(asset);
        await this.prisma.media_assets.update({
          where: { id: asset.id },
          data: { ocr_text: ocrText, status: 'ready' },
        });
        return;
      }

      await this.prisma.media_assets.update({
        where: { id: asset.id },
        data: { status: 'ready' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown media processing error';
      this.logger.error({ media_asset_id: asset.id, error: message }, 'Media processing failed');
      await this.prisma.media_assets.update({
        where: { id: asset.id },
        data: { status: 'failed', error_message: message },
      });
      throw error;
    }
  }

  private async transcribeAudio(asset: {
    id: string;
    mime_type: string;
    storage_bucket: string | null;
    storage_path: string | null;
    source_url: string | null;
  }) {
    if (!this.openai) {
      throw new BadRequestException('OPENAI_API_KEY is required for audio transcription');
    }

    const buffer = await this.loadAssetBytes(asset);
    const file = await toFile(buffer, `${asset.id}.${this.audioExtension(asset.mime_type)}`, {
      type: asset.mime_type,
    });

    const response = await this.openai.audio.transcriptions.create({
      file,
      model: process.env.MEDIA_TRANSCRIPTION_MODEL || 'whisper-1',
    });

    return response.text;
  }

  private async describeImage(asset: {
    mime_type: string;
    storage_bucket: string | null;
    storage_path: string | null;
    source_url: string | null;
  }) {
    if (!this.gemini) {
      throw new BadRequestException('GEMINI_API_KEY is required for image OCR/vision');
    }

    const buffer = await this.loadAssetBytes(asset);
    const model = this.gemini.getGenerativeModel({
      model: process.env.MEDIA_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    });

    const result = await model.generateContent([
      'Descreva a imagem e extraia qualquer texto visível. Responda em português, de forma objetiva.',
      {
        inlineData: {
          mimeType: asset.mime_type,
          data: buffer.toString('base64'),
        },
      },
    ]);

    return result.response.text();
  }

  private async loadAssetBytes(asset: {
    storage_bucket: string | null;
    storage_path: string | null;
    source_url: string | null;
  }): Promise<Buffer> {
    if (asset.storage_bucket && asset.storage_path) {
      if (!this.supabase) throw new BadRequestException('Supabase storage is not configured');

      const { data, error } = await this.supabase.storage
        .from(asset.storage_bucket)
        .download(asset.storage_path);

      if (error) throw new BadRequestException(`Storage download failed: ${error.message}`);

      return Buffer.from(await data.arrayBuffer());
    }

    if (asset.source_url) {
      const response = await fetch(asset.source_url);
      if (!response.ok) throw new BadRequestException(`Source URL returned ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    }

    throw new BadRequestException('Media asset has no storage path or source URL');
  }

  private audioExtension(mimeType: string) {
    if (mimeType.includes('mpeg')) return 'mp3';
    if (mimeType.includes('wav')) return 'wav';
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('webm')) return 'webm';
    return 'audio';
  }
}
