import { Controller, ForbiddenException, Get, NotFoundException, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators';
import type { AppConfig } from '../../config/configuration';
import { verifyStorageSignature } from './signed-url';
import { StorageService } from './storage.service';

/**
 * Serves signed download links. Public on purpose: the signature *is* the authorisation, exactly
 * like an S3 presigned URL, which is what lets an `<img src>` load without an Authorization header.
 */
@ApiExcludeController()
@Controller('files')
export class StorageController {
  private readonly signingSecret: string;

  constructor(
    private readonly storage: StorageService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.signingSecret = config.get('storage', { infer: true }).signingSecret;
  }

  @Public()
  @Get()
  async download(
    @Query('key') key: string,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
    @Res() res: Response,
  ): Promise<void> {
    const expiresAt = Number.parseInt(expires ?? '', 10);
    if (!key || !signature || !verifyStorageSignature(this.signingSecret, key, expiresAt, signature)) {
      throw new ForbiddenException('Link is invalid or has expired');
    }

    let file;
    try {
      file = await this.storage.read(key);
    } catch {
      throw new NotFoundException('File not found');
    }

    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', 'private, max-age=900');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Helmet defaults to same-origin, which would stop the desktop webview (a different origin)
    // from rendering the image. The signature already limits who can load it.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(file.body);
  }
}
