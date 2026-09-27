import { BadRequestException } from '@nestjs/common';
import { spawn } from 'child_process';
import { fileTypeFromBuffer } from 'file-type';

export interface WaitingMusicConfig {
  enabled: boolean;
  media_asset_id: string | null;
  volume: number;
}
export function readWaitingMusic(value: any): WaitingMusicConfig {
  return {
    enabled: value?.enabled === true,
    media_asset_id:
      typeof value?.media_asset_id === 'string' ? value.media_asset_id : null,
    volume:
      typeof value?.volume === 'number' && Number.isFinite(value.volume)
        ? Math.max(0, Math.min(100, value.volume))
        : 20,
  };
}
export const MAX_MUSIC_BYTES = 10 * 1024 * 1024;
const MAX_PCM_BYTES = 180 * 24000 * 2;

export function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export function wavToPcm(wav: Buffer): Buffer {
  if (
    wav.length < 46 ||
    wav.length > MAX_PCM_BYTES + 44 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
    wav.readUInt32LE(16) !== 16 ||
    wav.readUInt16LE(20) !== 1 ||
    wav.readUInt16LE(22) !== 1 ||
    wav.readUInt32LE(24) !== 24000 ||
    wav.readUInt16LE(34) !== 16 ||
    wav.toString('ascii', 36, 40) !== 'data' ||
    wav.readUInt32LE(40) !== wav.length - 44 ||
    wav.length % 2
  ) {
    throw new BadRequestException('Áudio de espera inválido');
  }
  return wav.subarray(44);
}

/** Decode only uploaded bytes; no shell, filesystem or network input protocols. */
export async function normalizeWaitingMusic(input: Buffer): Promise<Buffer> {
  if (!input?.length || input.length > MAX_MUSIC_BYTES)
    throw new BadRequestException('Envie MP3 ou WAV de até 10 MB');
  let type: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
  try {
    type = await fileTypeFromBuffer(input);
  } catch {
    throw new BadRequestException('Envie um arquivo MP3 ou WAV válido');
  }
  if (!type || !['mp3', 'wav'].includes(type.ext))
    throw new BadRequestException('Envie um arquivo MP3 ou WAV válido');
  const pcm = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-protocol_whitelist',
        'pipe',
        '-f',
        type.ext,
        '-i',
        'pipe:0',
        '-vn',
        '-t',
        '181',
        '-ac',
        '1',
        '-ar',
        '24000',
        '-threads',
        '1',
        '-f',
        's16le',
        'pipe:1',
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(
      () =>
        finish(
          new BadRequestException('Tempo de processamento do áudio excedido'),
        ),
      30000,
    );
    child.on('error', () =>
      finish(new BadRequestException('Conversor de áudio indisponível')),
    );
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PCM_BYTES)
        finish(new BadRequestException('A música deve ter até 3 minutos'));
      else chunks.push(chunk);
    });
    child.on('close', (code) =>
      finish(
        code || !size
          ? new BadRequestException('Arquivo de áudio inválido')
          : undefined,
      ),
    );
    child.stdin.on('error', () =>
      finish(new BadRequestException('Falha ao processar áudio')),
    );
    child.stdin.end(input);
  });
  return pcmToWav(pcm);
}
