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
 * SMTP transport, optional. A desktop install usually has no mail server, so with no SMTP_HOST
 * mail is disabled and every send reports `sent: false` with a reason instead of trying to
 * connect. If SMTP is configured but unreachable the failure is logged and the caller continues:
 * an outage in the mail server must not turn a successful password reset into a 500.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter | null;
  private readonly from: string;

  constructor(private readonly config: ConfigService<{ mail: AppConfig['mail'] }, true>) {
    const mail = this.config.get('mail', { infer: true });
    this.from = mail.from;
    if (!mail.host) {
      this.transporter = null;
      this.logger.log('SMTP not configured — outgoing mail is disabled');
      return;
    }
    this.transporter = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      auth: mail.user ? { user: mail.user, pass: mail.password } : undefined,
      // Only verify certificates on TLS connections; a plain local relay has none to check.
      tls: { rejectUnauthorized: mail.secure },
    });
  }

  get isEnabled(): boolean {
    return this.transporter !== null;
  }

  async send(message: MailMessage): Promise<{ sent: boolean; error?: string }> {
    if (!this.transporter) {
      return { sent: false, error: 'L’envoi d’e-mails est désactivé (aucun serveur SMTP configuré)' };
    }
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
    if (!this.transporter) return false;
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
