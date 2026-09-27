import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { WaitingMusicService, MusicActor } from './waiting-music.service';
import { MAX_MUSIC_BYTES } from './waiting-music.util';

@Controller('clients/:clientId/waiting-music')
export class WaitingMusicController {
  constructor(private readonly music: WaitingMusicService) {}
  @Get()
  list(
    @Param('clientId', ParseUUIDPipe) id: string,
    @CurrentUser() actor: MusicActor,
  ) {
    return this.music.list(id, actor);
  }
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_MUSIC_BYTES, files: 1 },
    }),
  )
  upload(
    @Param('clientId', ParseUUIDPipe) id: string,
    @CurrentUser() actor: MusicActor,
    @UploadedFile() file: any,
  ) {
    return this.music.upload(id, actor, file);
  }
  @Get(':assetId/audio')
  async audio(
    @Param('clientId', ParseUUIDPipe) id: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @CurrentUser() actor: MusicActor,
    @Res() response: Response,
  ) {
    await this.music.authorize(id, actor);
    const wav = await this.music.audio(id, assetId);
    response
      .set({
        'Content-Type': 'audio/wav',
        'Cache-Control': 'private, no-store',
      })
      .send(wav);
  }
}
