import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import { hasPerm, type Permission } from '../common/permissions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.module.js';

/** What a file can be attached to, and who may see / add files on it */
const TYPES = {
  PO: { label: 'purchase order', view: ['purchases.view', 'po.create', 'po.edit', 'purchases.approve'], manage: ['po.create', 'po.edit'] },
  GRN: { label: 'GRN', view: ['grn.view', 'purchases.receive'], manage: ['purchases.receive'] },
  NOTE: { label: 'debit / credit note', view: ['notes.view', 'notes.create'], manage: ['notes.create', 'notes.edit'] },
} satisfies Record<string, { label: string; view: Permission[]; manage: Permission[] }>;
type EntityType = keyof typeof TYPES;

export const MAX_FILE_MB = 25;
export const MAX_FILES_PER_UPLOAD = 10;
const MAX_FILES_PER_ENTRY = 50;

/** Video is the one kind of file that can't be attached (size); everything else is accepted */
const VIDEO_EXT = /\.(mp4|m4v|mov|avi|mkv|webm|wmv|flv|3gp|3g2|mpe?g|mts|m2ts|ts|vob|ogv)$/i;
const isVideo = (name: string, mime: string) => mime.toLowerCase().startsWith('video/') || VIDEO_EXT.test(name);

/** Shown in the browser when opened; anything else (HTML, SVG, Office files…) always downloads, so it can't run here */
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv']);

/** The parts of an uploaded file used here (multer, kept in memory) */
interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Multer reads file names as latin1; names typed in Tamil, Hindi… arrive as UTF-8 bytes and are decoded back */
function fileNameOf(raw: string) {
  const utf8 = Buffer.from(raw, 'latin1').toString('utf8');
  const name = utf8.includes('\uFFFD') ? raw : utf8;
  return name.replace(/[\\/\0]/g, '_').trim().slice(0, 200) || 'file';
}

/** Safe piece of the storage key: letters, digits, dot, dash, underscore */
const keyPart = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(-80) || 'file';

const UPLOADED_BY = { uploadedBy: { select: { id: true, name: true } } } as const;

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  private typeOf(raw: string): EntityType {
    const t = raw.toUpperCase();
    if (!(t in TYPES)) throw new NotFoundException('Unknown record type');
    return t as EntityType;
  }

  private allow(user: AuthUser, type: EntityType, need: 'view' | 'manage') {
    if (!hasPerm(user, ...TYPES[type][need]))
      throw new ForbiddenException(`You do not have permission to ${need === 'view' ? 'see' : 'change'} files on a ${TYPES[type].label}`);
  }

  /** The PO / GRN / note must exist */
  private async checkEntity(type: EntityType, id: string) {
    const found =
      type === 'PO'
        ? await this.prisma.purchaseOrder.findFirst({ where: { id, deletedAt: null }, select: { id: true } })
        : type === 'GRN'
          ? await this.prisma.grn.findUnique({ where: { id }, select: { id: true } })
          : await this.prisma.debitNote.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw new NotFoundException(`That ${TYPES[type].label} was not found`);
  }

  async list(rawType: string, entityId: string, user: AuthUser) {
    const type = this.typeOf(rawType);
    this.allow(user, type, 'view');
    return this.prisma.attachment.findMany({ where: { entityType: type, entityId }, include: UPLOADED_BY, orderBy: { createdAt: 'desc' } });
  }

  async upload(rawType: string, entityId: string, files: UploadedFileLike[] | undefined, user: AuthUser) {
    const type = this.typeOf(rawType);
    this.allow(user, type, 'manage');
    if (!files?.length) throw new BadRequestException('Choose at least one file');
    if (!this.storage.configured) throw new BadRequestException('File storage is not set up on the server');
    await this.checkEntity(type, entityId);
    const named = files.map((f) => ({ ...f, name: fileNameOf(f.originalname) }));
    // Check every file first, so nothing is half-uploaded when one is refused
    for (const f of named) {
      if (isVideo(f.name, f.mimetype)) throw new BadRequestException(`${f.name}: video files can't be attached`);
      if (!f.size) throw new BadRequestException(`${f.name} is empty`);
    }
    const existing = await this.prisma.attachment.count({ where: { entityType: type, entityId } });
    if (existing + named.length > MAX_FILES_PER_ENTRY)
      throw new BadRequestException(`A ${TYPES[type].label} can hold up to ${MAX_FILES_PER_ENTRY} files (${existing} attached already)`);

    const saved = [];
    for (const f of named) {
      const id = crypto.randomUUID();
      const storageKey = `attachments/${type}/${entityId}/${id}-${keyPart(f.name)}`;
      const mimeType = f.mimetype || 'application/octet-stream';
      await this.storage.put(storageKey, f.buffer, mimeType);
      try {
        saved.push(
          await this.prisma.attachment.create({
            data: { entityType: type, entityId, fileName: f.name, mimeType, size: f.size, storageKey, uploadedById: user.id },
            include: UPLOADED_BY,
          }),
        );
      } catch (e) {
        // The row didn't save: don't leave the file behind in storage
        await this.storage.remove(storageKey).catch(() => undefined);
        throw e;
      }
    }
    await this.audit.log(user.id, 'CREATE', 'Attachment', entityId, {
      entityType: type,
      files: saved.map((a) => ({ id: a.id, fileName: a.fileName, size: a.size })),
    });
    return saved;
  }

  private async find(id: string, user: AuthUser, need: 'view' | 'manage') {
    const a = await this.prisma.attachment.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('File not found');
    this.allow(user, a.entityType as EntityType, need);
    return a;
  }

  /** Streams the file: PDFs, images and plain text open in the browser unless `download` is asked; everything else downloads */
  async send(id: string, user: AuthUser, download: boolean, res: Response) {
    const a = await this.find(id, user, 'view');
    const file = await this.storage.get(a.storageKey);
    if (!file) throw new NotFoundException('The stored file is missing');
    const inline = !download && INLINE_TYPES.has(a.mimeType);
    const ascii = a.fileName.replace(/[^\x20-\x7E]+/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', inline ? a.mimeType : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.fileName)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    if (file.length !== undefined) res.setHeader('Content-Length', String(file.length));
    file.body.pipe(res);
  }

  async remove(id: string, user: AuthUser) {
    const a = await this.find(id, user, 'manage');
    await this.prisma.attachment.delete({ where: { id } });
    await this.storage.remove(a.storageKey).catch(() => undefined);
    await this.audit.log(user.id, 'DELETE', 'Attachment', a.entityId, { entityType: a.entityType, id, fileName: a.fileName });
    return { deleted: true };
  }
}

/** Permissions are checked per record type in the service (a PO, GRN and note each have their own) */
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  /** Declared before :type/:id */
  @Get('file/:id')
  file(@Param('id') id: string, @Query('download') download: string | undefined, @CurrentUser() user: AuthUser, @Res() res: Response) {
    return this.attachments.send(id, user, download === '1' || download === 'true', res);
  }

  @Delete('file/:id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.attachments.remove(id, user);
  }

  @Get(':type/:id')
  list(@Param('type') type: string, @Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.attachments.list(type, id, user);
  }

  /** Multipart form, field "files": one or more files */
  @Post(':type/:id')
  @UseInterceptors(FilesInterceptor('files', MAX_FILES_PER_UPLOAD, { limits: { fileSize: MAX_FILE_MB * 1024 * 1024 } }))
  upload(@Param('type') type: string, @Param('id') id: string, @UploadedFiles() files: UploadedFileLike[], @CurrentUser() user: AuthUser) {
    return this.attachments.upload(type, id, files, user);
  }
}

@Module({
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
})
export class AttachmentsModule {}
