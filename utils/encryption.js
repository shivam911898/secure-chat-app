const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

const KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

// Returns a human-readable problem with ENCRYPTION_KEY, or null when it is usable.
const validateEncryptionKey = () => {
  const keyHex = process.env.ENCRYPTION_KEY;

  if (!keyHex) {
    return 'ENCRYPTION_KEY is missing from the environment.';
  }

  if (!KEY_PATTERN.test(keyHex)) {
    return 'ENCRYPTION_KEY must be exactly 64 hexadecimal characters (a 32-byte key).';
  }

  return null;
};

const getKeyBuffer = () => {
  const keyError = validateEncryptionKey();

  if (keyError) {
    throw new Error(keyError);
  }

  return Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
};

const encryptText = (plainText) => {
  const key = getKeyBuffer();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedMessage: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
};

const decryptText = ({ encryptedMessage, iv, authTag }) => {
  const key = getKeyBuffer();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));

  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedMessage, 'hex')),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
};

module.exports = {
  encryptText,
  decryptText,
  validateEncryptionKey,
};
