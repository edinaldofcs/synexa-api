import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly configService: ConfigService) {}

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    const smtpHost = this.configService.get<string>('SMTP_HOST', '');
    if (!smtpHost) {
      this.logger.log(
        `[DEV] SMTP não configurado. Link de redefinição para ${to}: ${resetUrl}`,
      );
      return;
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: this.configService.get<number>('SMTP_PORT', 587),
      secure: this.configService.get<string>('SMTP_SECURE', 'false') === 'true',
      auth: {
        user: this.configService.get<string>('SMTP_USER', ''),
        pass: this.configService.get<string>('SMTP_PASS', ''),
      },
    });

    await transporter.sendMail({
      from: this.configService.get<string>(
        'SMTP_FROM',
        'Synexa <no-reply@synexa.com.br>',
      ),
      to,
      subject: 'Redefinição de senha - Synexa',
      text: `Use o link abaixo para redefinir sua senha (válido por 30 minutos): ${resetUrl}`,
      html: `<p>Use o botão abaixo para redefinir sua senha. O link expira em 30 minutos.</p><p><a href="${resetUrl}">Redefinir senha</a></p><p>Se você não solicitou isso, ignore este e-mail.</p>`,
    });
  }
}
