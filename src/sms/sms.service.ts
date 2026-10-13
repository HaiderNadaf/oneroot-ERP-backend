import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import twilio from 'twilio';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly client: ReturnType<typeof twilio> | null;
  private readonly from: string;
  private readonly countryCode: string;

  constructor(private readonly config: ConfigService) {
    const sid = this.config.get<string>('TWILIO_ACCOUNT_SID');
    const token = this.config.get<string>('TWILIO_AUTH_TOKEN');
    this.from = this.config.get<string>('TWILIO_FROM_NUMBER') ?? '';
    this.countryCode = (this.config.get<string>('SMS_DEFAULT_COUNTRY_CODE') ?? '+91').replace(/[^\d+]/g, '');

    if (!sid || !token || !this.from) {
      this.logger.warn(
        'Twilio configuration is missing. Check TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER. SMS sending is disabled.',
      );
      this.client = null;
      return;
    }

    this.client = twilio(sid, token);
  }

  /** Turns "98765 43210", "09876543210" or "+91 98765-43210" into E.164; null if it can't */
  normalize(phone: string | null | undefined): string | null {
    if (!phone) return null;
    const cleaned = phone.trim().replace(/[\s\-().]/g, '');
    let e164: string;
    if (cleaned.startsWith('+')) e164 = cleaned;
    else if (cleaned.startsWith('00')) e164 = `+${cleaned.slice(2)}`;
    else e164 = `${this.countryCode}${cleaned.replace(/^0+/, '')}`;
    return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
  }

  /** Common send: throws on bad input or Twilio failure. Use for user-initiated sends. */
  async send(to: string, message: string) {
    if (!this.client) {
      throw new ServiceUnavailableException('SMS service is not configured');
    }

    const phone = this.normalize(to);
    if (!phone) {
      throw new BadRequestException('Enter a valid phone number with country code');
    }

    const body = message?.trim();
    if (!body || body.length > 1500) {
      throw new BadRequestException('Message must contain 1–1500 characters');
    }

    try {
      const result = await this.client.messages.create({ from: this.from, to: phone, body });
      return {
        success: true,
        messageSid: result.sid,
        status: result.status,
        to: result.to,
      };
    } catch (error: unknown) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown error';
      this.logger.error(`SMS to ${phone} failed: ${code}`);
      throw new InternalServerErrorException('Unable to submit SMS. Please try again later.');
    }
  }

  /**
   * Fire-and-forget send for business events (PO created, invoice booked, …).
   * Never throws, so a missing phone or a Twilio outage can't fail the document being saved.
   */
  notify(to: string | null | undefined, message: string, context = 'SMS') {
    if (!this.client) return;
    if (!this.normalize(to)) {
      this.logger.warn(`${context}: skipped, no valid phone number (${to ?? 'empty'})`);
      return;
    }
    this.send(to!, message).then(
      (r) => this.logger.log(`${context}: sent to ${r.to} (${r.status}, ${r.messageSid})`),
      (e: unknown) => this.logger.warn(`${context}: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
}
