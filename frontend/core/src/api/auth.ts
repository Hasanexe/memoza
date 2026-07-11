import { request } from './client';

export interface RegisterRequest {
  email: string;
  name: string;
  password: string;
  kdf_iterations: number;
  public_key: string;
  wrapped_dek: string;
  wrapped_private_key: string;
  wrapped_dek_recovery: string;
  wrapped_private_key_recovery: string;
  recovery_mode: 'private' | 'convenient';
  escrowed_recovery?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
}

export interface LoginResponse extends TokenResponse {
  kdf_iterations: number;
  wrapped_dek: string;
  wrapped_private_key: string;
}

export function register(body: RegisterRequest): Promise<TokenResponse> {
  return request('/auth/register', { method: 'POST', body: JSON.stringify(body) }, false);
}

export function login(email: string, password: string): Promise<LoginResponse> {
  return request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }, false);
}

export function refresh(): Promise<TokenResponse> {
  return request('/auth/refresh', { method: 'POST' }, false);
}

export function logout(): Promise<{ ok: true }> {
  return request('/auth/logout', { method: 'POST' }, false);
}

export interface ChangePasswordRequest {
  email: string;
  old_password: string;
  new_password: string;
  wrapped_dek: string;
  wrapped_private_key: string;
  wrapped_dek_recovery?: string;
  wrapped_private_key_recovery?: string;
}

export function changePassword(body: ChangePasswordRequest): Promise<TokenResponse> {
  return request('/auth/password', { method: 'PUT', body: JSON.stringify(body) });
}

export function requestReset(email: string): Promise<{ ok: true }> {
  return request('/auth/reset/request', { method: 'POST', body: JSON.stringify({ email }) }, false);
}

export interface ResetProbeResponse {
  recovery_mode: 'private' | 'convenient';
  recovery_key?: string;
  wrapped_dek_recovery: string;
  wrapped_private_key_recovery: string;
}

export function probeReset(token: string, email: string): Promise<ResetProbeResponse> {
  return request('/auth/reset/confirm', { method: 'POST', body: JSON.stringify({ token, email }) }, false);
}

export interface ConfirmResetRequest {
  token: string;
  email: string;
  new_password: string;
  wrapped_dek: string;
  wrapped_private_key: string;
  wrapped_dek_recovery: string;
  wrapped_private_key_recovery: string;
  escrowed_recovery?: string;
}

export function confirmReset(body: ConfirmResetRequest): Promise<{ ok: true }> {
  return request('/auth/reset/confirm', { method: 'POST', body: JSON.stringify(body) }, false);
}

export function deleteAccount(email: string, password: string): Promise<{ ok: true }> {
  return request('/auth/account', { method: 'DELETE', body: JSON.stringify({ email, password }) });
}

export interface PublicKeyResponse {
  user_id: string;
  public_key: string;
}

export function lookupPublicKey(email: string): Promise<PublicKeyResponse> {
  return request(`/users/public-key?email=${encodeURIComponent(email)}`, { method: 'GET' });
}
