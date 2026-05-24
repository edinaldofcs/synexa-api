import { SetMetadata } from '@nestjs/common';
import { REQUIRES_API_KEY } from './api-key.guard';

export const RequiresApiKey = () => SetMetadata(REQUIRES_API_KEY, true);
