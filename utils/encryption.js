const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

const getKeyBuffer = () => {
  const keyHex = process.env.ENCRYPTION_KEY;

  if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32-byte key)');
  }

  return Buffer.from(keyHex, 'hex');
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
};
