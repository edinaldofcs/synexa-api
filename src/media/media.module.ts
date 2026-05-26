import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { LocalStorageProvider } from './providers/local-storage.provider';
import { StorageProvider } from './providers/storage-provider.interface';

const storageProviderFactory = {
  provide: 'STORAGE_PROVIDER',
  useFactory: () => {
    const isDevelopment = process.env.ENVIRONMENT === 'development';
    if (isDevelopment) {
      return new LocalStorageProvider();
    }
    return null; // production uses Supabase directly in the service
  },
};

@Module({
  imports: [CommonModule],
  controllers: [MediaController],
  providers: [MediaService, storageProviderFactory],
  exports: [MediaService, storageProviderFactory],
})
export class MediaModule {
  static readonly STORAGE_PROVIDER = 'STORAGE_PROVIDER';
}
