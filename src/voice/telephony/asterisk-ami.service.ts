import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as net from 'net';

@Injectable()
export class AsteriskAmiService {
  private readonly logger = new Logger(AsteriskAmiService.name);
  private host: string;
  private port: number;
  private user: string;
  private secret: string;

  constructor(private readonly configService: ConfigService) {
    this.host =
      this.configService.get<string>('ASTERISK_AMI_HOST') || 'dialer-asterisk';
    this.port = this.configService.get<number>('ASTERISK_AMI_PORT') || 5038;
    this.user =
      this.configService.get<string>('ASTERISK_AMI_USER') || 'synexa_voice';
    this.secret = this.configService.get<string>('ASTERISK_AMI_SECRET') || '';
  }

  public async hangupChannel(channel: string): Promise<boolean> {
    const cleanChannel = (channel || '').replace(/[\r\n]/g, '').trim();
    if (!cleanChannel) return false;

    if (!this.secret) {
      this.logger.debug(
        `[AsteriskAmi] ASTERISK_AMI_SECRET não configurado. Desconexão remota de "${cleanChannel}" simulada.`,
      );
      return true;
    }

    return new Promise((resolve) => {
      this.logger.log(
        `📞 [AsteriskAmi] Conectando ao AMI (${this.host}:${this.port}) para desligar canal: ${cleanChannel}`,
      );

      const client = net.createConnection({ host: this.host, port: this.port });
      let authenticated = false;

      client.setTimeout(5000);

      client.on('connect', () => {
        client.write(
          `Action: Login\r\nUsername: ${this.user}\r\nSecret: ${this.secret}\r\n\r\n`,
        );
      });

      client.on('data', (data) => {
        const response = data.toString();
        if (
          !authenticated &&
          response.includes('Response: Success') &&
          response.includes('Authentication accepted')
        ) {
          authenticated = true;
          client.write(`Action: Hangup\r\nChannel: ${cleanChannel}\r\n\r\n`);
          client.write('Action: Logoff\r\n\r\n');
          resolve(true);
        }
      });

      client.on('timeout', () => {
        this.logger.warn('[AsteriskAmi] Timeout ao conectar no AMI');
        client.destroy();
        resolve(false);
      });

      client.on('error', (err) => {
        this.logger.warn(`[AsteriskAmi] Erro na conexão AMI: ${err.message}`);
        resolve(false);
      });
    });
  }
}
