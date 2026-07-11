export interface Session {
  userId: string;
  email: string;
  dek: CryptoKey;
  privateKey: CryptoKey;
  wrappedDek: string;
  wrappedPrivateKey: string;
}

let session: Session | null = null;
let accessToken: string | null = null;

export function setSession(next: Session): void {
  session = next;
}

export function getSession(): Session | null {
  return session;
}

export function isUnlocked(): boolean {
  return session !== null;
}

export function requireSession(): Session {
  if (!session) throw new Error('Locked');
  return session;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function lock(): void {
  session = null;
}

export function logout(): void {
  session = null;
  accessToken = null;
}
