import { Body, Controller, Global, Module, Post } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Can } from '../common/decorators.js';
import { SmsService } from './sms.service.js';

export { SmsService } from './sms.service.js';

// DTO
export class SendSmsDto {
  /** E.164 (+919876543210) or a local 10-digit number; the default country code is added */
  @IsString()
  @MinLength(8)
  @MaxLength(20)
  to: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1500)
  message: string;
}

// Controller
@Controller('sms')
export class SmsController {
  constructor(private readonly sms: SmsService) {}

  /** Free-text SMS to any number: limited to staff who may send customer reminders */
  @Post('send')
  @Can('customers.remind')
  sendSms(@Body() dto: SendSmsDto) {
    return this.sms.send(dto.to, dto.message);
  }
}

// Module
@Global()
@Module({
  controllers: [SmsController],
  providers: [SmsService],
  exports: [SmsService],
})
export class SmsModule {}
