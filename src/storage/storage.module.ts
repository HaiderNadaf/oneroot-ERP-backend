import { Controller, Get, Global, Injectable, Module, NotFoundException, Param, Res } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Response } from 'express';
import type { Readable } from 'node:stream';
import { Public } from '../common/decorators.js';

/** Folders anyone may read through GET /api/files/… (no login): only files that are safe to share, like barcode images */
const PUBLIC_PREFIXES = ['barcodes/'];

/** Route that serves stored files; the links saved in the database point here */
const FILES_ROUTE = '/api/files/';

/**
 * Neon object storage (S3-compatible). The client reads AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 * and AWS_REGION from the environment; S3_BUCKET names the bucket. The bucket stays private: files are handed out
 * through this API at short, permanent links (PUBLIC_API_URL + /api/files/<key>).
 */
@Injectable()
export class StorageService {
  private readonly bucket = process.env.S3_BUCKET ?? '';
  private readonly endpoint = process.env.AWS_ENDPOINT_URL_S3 ?? '';
  private readonly baseUrl = (process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`).replace(/\/+$/, '');
  private readonly s3 = new S3Client({ forcePathStyle: true });

  get configured() {
    return !!(this.bucket && this.endpoint);
  }

  /** Short permanent link to a stored file, e.g. https://api.example.com/api/files/barcodes/2000000000060.png */
  urlFor(key: string) {
    return `${this.baseUrl}${FILES_ROUTE}${key}`;
  }

  /** Uploads a file and returns its short link, the value to store in the database */
  async put(key: string, body: Buffer, contentType: string) {
    if (!this.configured) throw new Error('Object storage is not set up (S3_BUCKET / AWS_ENDPOINT_URL_S3)');
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
    return this.urlFor(key);
  }

  /** Removes a stored file (no error when it is already gone) */
  async remove(key: string) {
    if (!this.configured) return;
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Reads a stored file; null when it does not exist */
  async get(key: string) {
    try {
      const obj = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return { body: obj.Body as Readable, contentType: obj.ContentType ?? 'application/octet-stream', length: obj.ContentLength };
    } catch (e) {
      if (e instanceof NoSuchKey) return null;
      throw e;
    }
  }
}

@Controller('files')
export class FilesController {
  constructor(private readonly storage: StorageService) {}

  /** Public files (barcode images) by key — works in <img> tags, labels and other apps without a login */
  @Public()
  @Get('*path')
  async get(@Param('path') path: string | string[], @Res() res: Response) {
    const key = Array.isArray(path) ? path.join('/') : path;
    if (key.split('/').includes('..') || !PUBLIC_PREFIXES.some((p) => key.startsWith(p))) throw new NotFoundException('File not found');
    const file = await this.storage.get(key);
    if (!file) throw new NotFoundException('File not found');
    res.setHeader('Content-Type', file.contentType);
    if (file.length !== undefined) res.setHeader('Content-Length', String(file.length));
    // Keys never change content (a new barcode gets a new key), so browsers and proxies may keep them for a year
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    file.body.pipe(res);
  }
}

@Global()
@Module({
  controllers: [FilesController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
