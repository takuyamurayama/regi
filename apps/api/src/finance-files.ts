import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BusinessError, requireRule } from './errors';

export const evidenceLimit = 10 * 1024 * 1024;
export const fileSha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

@Injectable()
export class FinanceFiles {
  private readonly directory = join(process.cwd(), '.context', 'finance-files');
  private path(key: string) {
    requireRule(
      /^[0-9a-f-]{36}\/finance\/(evidence|exports)\/[0-9a-f-]{36}$/u.test(key),
      'EVIDENCE_UNAVAILABLE',
      '保存済み資料の所在を確認できません',
      503,
    );
    return join(this.directory, key);
  }
  async put(key: string, bytes: Buffer, mediaType: string) {
    const path = this.path(key);
    if (process.env.ARTIFACT_BUCKET) {
      await new S3Client({ region: process.env.AWS_REGION }).send(
        new PutObjectCommand({
          Bucket: process.env.ARTIFACT_BUCKET,
          Key: key,
          Body: bytes,
          ContentType: mediaType,
          ServerSideEncryption: 'AES256',
          IfNoneMatch: '*',
        }),
      );
    } else {
      requireRule(
        ['development', 'test'].includes(process.env.NODE_ENV ?? ''),
        'EVIDENCE_UNAVAILABLE',
        '本番の資料保存先が未設定です',
        503,
      );
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    }
  }
  async get(key: string, expectedBytes: number, expectedSha: string): Promise<Buffer> {
    const path = this.path(key);
    try {
      let bytes: Buffer;
      if (process.env.ARTIFACT_BUCKET) {
        const result = await new S3Client({ region: process.env.AWS_REGION }).send(
          new GetObjectCommand({ Bucket: process.env.ARTIFACT_BUCKET, Key: key }),
        );
        requireRule(
          result.Body && result.ContentLength === expectedBytes,
          'EVIDENCE_UNAVAILABLE',
          '保存済み資料の容量を確認できません',
          503,
        );
        bytes = Buffer.from(await result.Body.transformToByteArray());
      } else {
        requireRule(
          (await stat(path)).size === expectedBytes,
          'EVIDENCE_UNAVAILABLE',
          '保存済み資料の容量が記録と一致しません',
          503,
        );
        bytes = await readFile(path);
      }
      requireRule(
        bytes.length === expectedBytes && fileSha(bytes) === expectedSha,
        'EVIDENCE_UNAVAILABLE',
        '保存済み資料の内容が記録と一致しません。原資料を確認してください',
        503,
      );
      return bytes;
    } catch (error: unknown) {
      if (error instanceof BusinessError) throw error;
      throw new BusinessError('EVIDENCE_UNAVAILABLE', '保存済み原資料を取得できません', 503);
    }
  }
}
