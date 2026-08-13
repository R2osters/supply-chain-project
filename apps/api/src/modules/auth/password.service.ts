import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../../config/configuration';

/**
 * Argon2id password hashing.
 *
 * Argon2id rather than bcrypt: it is memory-hard, so a GPU or ASIC attacker cannot trade silicon
 * for speed the way they can against bcrypt's small working set. Parameters follow the OWASP
 * Password Storage Cheat Sheet baseline (19 MiB, t=2, p=1), with memory configurable so a
 * memory-constrained deployment can tune it without editing code.
 *
 * @node-rs/argon2 is used instead of the `argon2` package because it ships prebuilt N-API
 * binaries — no node-gyp, no Visual Studio Build Tools on a Windows dev machine.
 */
@Injectable()
export class PasswordService {
  private readonly memoryCost: number;
  private decoyHash: string | null = null;

  constructor(private readonly config: ConfigService<{ auth: AppConfig['auth'] }, true>) {
    this.memoryCost = this.config.get('auth', { infer: true }).argon2MemoryCost;
  }

  async hash(plain: string): Promise<string> {
    return hash(plain, {
      algorithm: Algorithm.Argon2id,
      memoryCost: this.memoryCost,
      timeCost: 2,
      parallelism: 1,
    });
  }

  /**
   * Returns false rather than throwing on a malformed hash, so a corrupted row cannot be
   * distinguished from a wrong password by an attacker watching status codes.
   */
  async verify(hashString: string, plain: string): Promise<boolean> {
    try {
      return await verify(hashString, plain);
    } catch {
      return false;
    }
  }

  /**
   * Burns the same amount of CPU as a real `verify()` and always fails. Login calls this when
   * the email is unknown, so "no such account" and "wrong password" take the same wall time and
   * cannot be told apart by an attacker enumerating addresses.
   *
   * The decoy hash is computed once from a random secret — a hard-coded literal risks being
   * unparseable, in which case `verify` would throw immediately and give the timing away.
   */
  async verifyDecoy(plain: string): Promise<false> {
    this.decoyHash ??= await this.hash(randomBytes(32).toString('base64url'));
    await this.verify(this.decoyHash, plain);
    return false;
  }
}
