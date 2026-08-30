import { BadRequestException } from '@nestjs/common';
import { promises as dns } from 'dns';
import { validateWebhookUrl } from './ssrf-guard';

jest.mock('dns', () => ({
  promises: {
    resolve4: jest.fn(),
    resolve6: jest.fn(),
  },
}));

describe('ssrf-guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('validateWebhookUrl', () => {
    it('resolves for a valid public URL with public IP', async () => {
      (dns.resolve4 as jest.Mock).mockResolvedValue(['8.8.8.8']);
      (dns.resolve6 as jest.Mock).mockResolvedValue([]);

      await expect(
        validateWebhookUrl('https://example.com/webhook'),
      ).resolves.toBeUndefined();
    });

    it('throws BadRequestException for invalid URL format', async () => {
      await expect(validateWebhookUrl('not-a-valid-url')).rejects.toThrow(
        'Invalid URL format',
      );
    });

    it('throws BadRequestException for non-HTTP/HTTPS protocol (ftp://)', async () => {
      await expect(
        validateWebhookUrl('ftp://files.example.com'),
      ).rejects.toThrow('Only HTTP and HTTPS URLs are allowed');
    });

    it('throws BadRequestException for localhost URL when allowLocalInDev=false', async () => {
      await expect(
        validateWebhookUrl('http://localhost:3000/api'),
      ).rejects.toThrow('Access to localhost is not allowed');
    });

    it('resolves for localhost URL when allowLocalInDev=true', async () => {
      await expect(
        validateWebhookUrl('http://localhost:3000/api', true),
      ).resolves.toBeUndefined();
      expect(dns.resolve4).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for 0.0.0.0 (blocked hostname list)', async () => {
      await expect(validateWebhookUrl('http://0.0.0.0/api')).rejects.toThrow(
        'Access to localhost is not allowed',
      );
    });

    it('throws for 0.0.0.5 (0.0.0.0/8 range, fora da lista de hostnames)', async () => {
      await expect(validateWebhookUrl('http://0.0.0.5/api')).rejects.toThrow(
        'Access to private/internal IP is not allowed: 0.0.0.5',
      );
    });

    it('throws when DNS resolves to private IP 127.0.0.1', async () => {
      (dns.resolve4 as jest.Mock).mockResolvedValue(['127.0.0.1']);
      (dns.resolve6 as jest.Mock).mockResolvedValue([]);

      await expect(
        validateWebhookUrl('https://internal.example.com'),
      ).rejects.toThrow(
        'Access to private/internal IP ranges is not allowed: 127.0.0.1',
      );
    });

    it('throws when DNS resolves to private IP 10.x.x.x', async () => {
      (dns.resolve4 as jest.Mock).mockResolvedValue(['10.0.0.1']);
      (dns.resolve6 as jest.Mock).mockResolvedValue([]);

      await expect(
        validateWebhookUrl('https://internal.example.com'),
      ).rejects.toThrow(BadRequestException);
    });

    it('blocks CGNAT range 100.64.0.0/10 (regression)', async () => {
      (dns.resolve4 as jest.Mock).mockResolvedValue(['100.100.1.1']);
      (dns.resolve6 as jest.Mock).mockResolvedValue([]);

      await expect(
        validateWebhookUrl('https://cgnat.example.com'),
      ).rejects.toThrow('Access to private/internal IP ranges');
    });

    it('blocks IPv4-mapped IPv6 ::ffff:10.0.0.5 (regression)', async () => {
      (dns.resolve4 as jest.Mock).mockResolvedValue([]);
      (dns.resolve6 as jest.Mock).mockResolvedValue(['::ffff:10.0.0.5']);

      await expect(
        validateWebhookUrl('https://mapped.example.com'),
      ).rejects.toThrow('Access to private/internal IP ranges');
    });

    it('allows IPv4-mapped public IPv6 ::ffff:8.8.8.8', async () => {
      (dns.resolve4 as jest.Mock).mockResolvedValue([]);
      (dns.resolve6 as jest.Mock).mockResolvedValue(['::ffff:8.8.8.8']);

      await expect(
        validateWebhookUrl('https://mapped-public.example.com'),
      ).resolves.toBeUndefined();
    });

    it('is FAIL-CLOSED: rejects unresolvable hostname (DNS rebinding protection)', async () => {
      (dns.resolve4 as jest.Mock).mockRejectedValue(new Error('DNS failed'));
      (dns.resolve6 as jest.Mock).mockRejectedValue(new Error('DNS failed'));

      await expect(
        validateWebhookUrl('https://unresolvable.example.com'),
      ).rejects.toThrow(/DNS resolution failed/i);
    });

    it('allows public IP literal directly without DNS', async () => {
      await expect(
        validateWebhookUrl('https://93.184.216.34/webhook'),
      ).resolves.toBeUndefined();
      expect(dns.resolve4).not.toHaveBeenCalled();
    });

    it('throws when hostname is a private IP literal', async () => {
      await expect(validateWebhookUrl('https://10.0.0.1/api')).rejects.toThrow(
        'Access to private/internal IP is not allowed: 10.0.0.1',
      );
    });

    it('throws when hostname is 127.0.0.1', async () => {
      await expect(validateWebhookUrl('https://127.0.0.1/api')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('allows private IP literal in dev mode', async () => {
      await expect(
        validateWebhookUrl('https://10.0.0.1/api', true),
      ).resolves.toBeUndefined();
    });
  });
});
