import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { AppConfig } from '../../config/configuration';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * SMTP transport. Locally this points at MailHog (http://localhost:8025) so password-reset and
 * verification links are genuinely delivered and inspectable — not swallowed by a no-op stub.
 * If SMTP is unreachable the failure is logged and the caller continues: an outage in the mail
 * server must not turn a successful password reset into a 500.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;

  constructor(private readonly config: ConfigService<{ mail: AppConfig['mail'] }, true>) {
    const mail = this.config.get('mail', { infer: true });
    this.from = mail.from;
    this.transporter = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      auth: mail.user ? { user: mail.user, pass: mail.password } : undefined,
      // MailHog presents a self-signed certificate; never relax this in production.
      tls: { rejectUnauthorized: mail.secure },
    });
  }

  async send(message: MailMessage): Promise<{ sent: boolean; error?: string }> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html ?? `<pre style="font-family:inherit">${escapeHtml(message.text)}</pre>`,
      });
      this.logger.log(`Mail sent to ${message.to}: ${message.subject}`);
      return { sent: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Mail to ${message.to} failed: ${reason}`);
      return { sent: false, error: reason };
    }
  }

  async verifyConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
