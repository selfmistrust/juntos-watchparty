import crypto from 'node:crypto';

/**
 * Criptografia AES-256-GCM para tokens OAuth no Redis.
 * A chave nunca vai ao cliente; o texto cifrado também não inclui metadados
 * que identifiquem o conteúdo além de um prefixo de versão.
 */
const VERSION = 'v1';

function keyMaterial(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY || process.env.SESSION_SECRET || '';
  if (!raw) {
    throw new Error('missing_encryption_key');
  }
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyMaterial(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('invalid_secret_payload');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyMaterial(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}
