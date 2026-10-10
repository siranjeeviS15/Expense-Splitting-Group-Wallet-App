const { promisify } = require('util');
const { randomBytes, scrypt: scryptCallback, timingSafeEqual } = require('crypto');

const scrypt = promisify(scryptCallback);
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 1024;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validateEmail(value) {
  const email = normalizeEmail(value);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid email address.');
  }
  return email;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    throw new Error('Password is too long.');
  }
}

async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  const [algorithm, saltText, keyText] = encoded.split('$');
  if (algorithm !== 'scrypt' || !saltText || !keyText) return false;
  try {
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(keyText, 'base64url');
    if (!salt.length || !expected.length) return false;
    const actual = await scrypt(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

module.exports = {
  hashPassword,
  normalizeEmail,
  validateEmail,
  validatePassword,
  verifyPassword
};
