import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { CreateMediaAssetDto } from './dto/create-media-asset.dto';
import { UpdateMediaAssetDto } from './dto/update-media-asset.dto';
import { UploadMediaAssetDto } from './dto/upload-media-asset.dto';
import { MediaService } from './media.service';

@Controller()
export class MediaController {
  constructor(
    private readonly mediaService: MediaService,
    private readonly configService: ConfigService,
  ) {}

  @Post('clients/:clientId/media/assets')
  createAsset(
    @Param('clientId') clientId: string,
    @Body() dto: CreateMediaAssetDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.mediaService.createAsset(clientId, dto, user.id);
  }

  @Get('media')
  findAll(@CurrentUser() user: { id: string }) {
    return this.mediaService.findAll(user.id);
  }

  @Get('clients/:clientId/media/assets')
  findAllByClient(
    @Param('clientId') clientId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.mediaService.findAllByClient(clientId, user.id);
  }

  @Get('media/assets/:assetId')
  findOne(
    @Param('assetId') assetId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.mediaService.findOne(assetId, user.id);
  }

  @Post('clients/:clientId/media/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: 50 * 1024 * 1024,
        files: 1,
      },
    }),
  )
  upload(
    @Param('clientId') clientId: string,
    @UploadedFile() file: any,
    @Body() dto: UploadMediaAssetDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.mediaService.uploadAsset(clientId, file, dto, user.id);
  }

  @Get('media/assets/:assetId/signed-url')
  createSignedUrl(
    @Param('assetId') assetId: string,
    @Query('expiresIn') expiresIn: string | undefined,
    @CurrentUser() user: { id: string },
  ) {
    const expiresInSeconds = expiresIn ? Number(expiresIn) : undefined;
    return this.mediaService.createSignedUrl(
      assetId,
      user.id,
      expiresInSeconds,
    );
  }

  @Patch('media/assets/:assetId')
  update(
    @Param('assetId') assetId: string,
    @Body() dto: UpdateMediaAssetDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.mediaService.update(assetId, dto, user.id);
  }
}
