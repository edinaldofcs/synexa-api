import { encrypt, decrypt } from '../../common/utils/crypto.util';

export function sealWebhookSecret(secret: string): string {
  return `enc:${encrypt(secret, process.env.ENCRYPTION_KEY || '')}`;
}
export function openWebhookSecret(cipher: string | null): string | null {
  if (!cipher) return null;
  if (!cipher.startsWith('enc:')) throw new Error('invalid_webhook_secret');
  return decrypt(cipher.slice(4), process.env.ENCRYPTION_KEY || '');
}
export function publicWebhookEndpoint<
  T extends { signing_secret_enc?: string | null },
>(endpoint: T) {
  const { signing_secret_enc, ...visible } = endpoint;
  return { ...visible, has_signing_secret: !!signing_secret_enc };
}
