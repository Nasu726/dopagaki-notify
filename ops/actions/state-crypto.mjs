import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('DPNSTATE1');
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

export function parseKey(hex) {
  // gh secret set < key.txt may preserve a trailing line break. Accept only
  // surrounding whitespace; embedded whitespace remains invalid.
  if (typeof hex !== 'string' || !/^[a-fA-F0-9]{64}$/.test(hex.trim())) {
    throw new Error('NOTIFY_STATE_KEY must be 64 hexadecimal characters (32 random bytes)');
  }
  return Buffer.from(hex.trim(), 'hex');
}

export function encryptState(plain, key) {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted]);
}

export function decryptState(payload, key) {
  if (!Buffer.isBuffer(payload) || payload.length < MAGIC.length + NONCE_LENGTH + TAG_LENGTH ||
      !payload.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Encrypted state artifact is missing or has an unexpected format');
  }
  const nonceEnd = MAGIC.length + NONCE_LENGTH;
  const tagEnd = nonceEnd + TAG_LENGTH;
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(MAGIC.length, nonceEnd));
  decipher.setAuthTag(payload.subarray(nonceEnd, tagEnd));
  try {
    return Buffer.concat([decipher.update(payload.subarray(tagEnd)), decipher.final()]);
  } catch {
    throw new Error('Cannot decrypt or authenticate state; check NOTIFY_STATE_KEY and artifact integrity');
  }
}
