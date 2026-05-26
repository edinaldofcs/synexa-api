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
    it('should resolve for a valid public URL with public IP', async () => {
      (dns.resolve4 as jest.Mock).mockResolvedValue(['8.8.8.8']);
      (dns.resolve6 as jest.Mock).mockResolvedValue([]);

      await expect(
        validateWebhookUrl('https://example.com/webhook'),
      ).resolves.toBeUndefined();
    });

    it('should throw BadRequestException for invalid URL format', async () => {
      await expect(validateWebhookUrl('not-a-valid-url')).rejects.toThrow(
        'Invalid URL format',
      );
    });

    it('should throw BadRequestException for non-HTTP/HTTPS protocol (ftp://)', async () => {
      await expect(
        validateWebhookUrl('ftp://files.example.com'),
      ).rejects.toThrow('Only HTTP and HTTPS URLs are allowed');
    });

    it('should throw BadRequestException for localhost URL when allowLocalInDev=false', async () => {
      await expect(
        validateWebhookUrl('http://localhost:3000/api'),
      ).rejects.toThrow('Access to localhost is not allowed');
    });

    it('should resolve for localhost URL when allowLocalInDev=true', async () => {
      await expect(
        validateWebhookUrl('http://localhost:3000/api', true),
      ).resolves.toBeUndefined();
      expect(dns.resolve4).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException for 0.0.0.0', async () => {
      await expect(validateWebhookUrl('http://0.0.0.0/api')).rejects.toThrow(
        'Access to localhost is not allowed',
      );
    });

    it('should throw when DNS resolves to private IP 127.0.0.1', async () => {
      (dns.resolve4 as jest.Mock).mockResolvedValue(['127.0.0.1']);
      (dns.resolve6 as jest.Mock).mockResolvedValue([]);

      await expect(
        validateWebhookUrl('https://internal.example.com'),
      ).rejects.toThrow(
        'Access to private/internal IP ranges is not allowed: 127.0.0.1',
      );
    });

    it('should throw when DNS resolves to private IP 10.x.x.x', async () => {
      (dns.resolve4 as jest.Mock).mockResolvedValue(['10.0.0.1']);
      (dns.resolve6 as jest.Mock).mockResolvedValue([]);

      await expect(
        validateWebhookUrl('https://internal.example.com'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fall back to direct IP parsing when DNS resolution fails', async () => {
      (dns.resolve4 as jest.Mock).mockRejectedValue(new Error('DNS failed'));
      (dns.resolve6 as jest.Mock).mockRejectedValue(new Error('DNS failed'));

      await expect(
        validateWebhookUrl('https://93.184.216.34/webhook'),
      ).resolves.toBeUndefined();
    });

    it('should throw when DNS fails and hostname is a private IP', async () => {
      (dns.resolve4 as jest.Mock).mockRejectedValue(new Error('DNS failed'));
      (dns.resolve6 as jest.Mock).mockRejectedValue(new Error('DNS failed'));

      await expect(validateWebhookUrl('https://10.0.0.1/api')).rejects.toThrow(
        'Access to private/internal IP is not allowed: 10.0.0.1',
      );
    });

    it('should throw when DNS fails and hostname is 127.0.0.1', async () => {
      (dns.resolve4 as jest.Mock).mockRejectedValue(new Error('DNS failed'));
      (dns.resolve6 as jest.Mock).mockRejectedValue(new Error('DNS failed'));

      await expect(validateWebhookUrl('https://127.0.0.1/api')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
