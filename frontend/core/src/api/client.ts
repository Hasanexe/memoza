import { getAccessToken, setAccessToken } from '../crypto/session';

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'https://api.memoza.io';

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

let refreshPromise: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'include' })
      .then(async res => {
        if (!res.ok) return false;
        const data = (await res.json()) as { access_token: string };
        setAccessToken(data.access_token);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

async function rawFetch(path: string, init: RequestInit, auth: boolean): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (auth) {
    const token = getAccessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'include' });
}

export async function request<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  let res = await rawFetch(path, init, auth);
  if (res.status === 401 && auth) {
    const refreshed = await refreshAccessToken();
    if (refreshed) res = await rawFetch(path, init, auth);
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : 'Request failed';
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}
