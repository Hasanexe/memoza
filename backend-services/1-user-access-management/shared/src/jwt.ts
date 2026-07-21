import { SignJWT, jwtVerify, importPKCS8, importSPKI, errors } from 'jose';
import type { KeyLike } from 'jose';
import type { AccessClaims } from './types';

const ISS = 'https://api.memoza.io';
const AUD = 'https://api.memoza.io';

const privateKeyCache = new Map<string, KeyLike>();
const publicKeyCache = new Map<string, KeyLike>();

export async function importPrivateKey(pem: string): Promise<KeyLike> {
  let key = privateKeyCache.get(pem);
  if (!key) {
    key = await importPKCS8(pem, 'EdDSA');
    privateKeyCache.set(pem, key);
  }
  return key;
}

export async function importPublicKey(pem: string): Promise<KeyLike> {
  let key = publicKeyCache.get(pem);
  if (!key) {
    key = await importSPKI(pem, 'EdDSA');
    publicKeyCache.set(pem, key);
  }
  return key;
}

export async function signAccessToken(
  privateKeyPem: string,
  claims: { user_id: string }
): Promise<string> {
  const key = await importPrivateKey(privateKeyPem);
  return new SignJWT({ user_id: claims.user_id })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuedAt()
    .setIssuer(ISS)
    .setAudience(AUD)
    .setExpirationTime('15m')
    .sign(key);
}

export async function verifyToken(
  publicKeyPems: string | string[],
  token: string
): Promise<AccessClaims> {
  const pems = (Array.isArray(publicKeyPems) ? publicKeyPems : [publicKeyPems]).filter(Boolean);
  if (pems.length === 0) throw new Error('No verification key configured');

  let lastError: unknown;
  for (const pem of pems) {
    try {
      const key = await importPublicKey(pem);
      const { payload } = await jwtVerify(token, key, { issuer: ISS, audience: AUD });
      return {
        user_id: payload['user_id'] as string,
        exp: payload.exp as number,
      };
    } catch (err) {
      if (err instanceof errors.JWTExpired) throw err;
      lastError = err;
    }
  }
  throw lastError;
}
