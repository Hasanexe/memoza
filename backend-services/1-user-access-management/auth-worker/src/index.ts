import { handlePreflight, addCors, withSecurityHeaders } from '@memoza/shared';
import { json } from './types';
import type { AuthEnv } from './types';
import { handleRegister } from './handlers/register';
import { handleActivate } from './handlers/activate';
import { handleUsernameAvailable } from './handlers/username-available';
import { handleLogin } from './handlers/login';
import { handleRefresh } from './handlers/refresh';
import { handleLogout } from './handlers/logout';
import { handleChangePassword } from './handlers/password';
import { handleResetRequest } from './handlers/reset-request';
import { handleResetConfirm } from './handlers/reset-confirm';
import { handleDeleteAccount } from './handlers/delete-account';
import { handlePublicKeyLookup } from './handlers/public-key';
import { handleResolveUsername } from './handlers/resolve-username';
import { handleUpdateLanguage } from './handlers/language';

export default {
  async fetch(request: Request, env: AuthEnv, ctx: ExecutionContext): Promise<Response> {
    const preflight = handlePreflight(request, env.CORS_ALLOWED_ORIGINS, 'GET, POST, PUT, DELETE, OPTIONS');
    if (preflight) return preflight;

    const { pathname } = new URL(request.url);
    const method = request.method;

    let response: Response;

    if (method === 'GET' && pathname === '/internal/auth/public-key') {
      response = await handlePublicKeyLookup(request, env);
    } else if (method === 'GET' && pathname === '/internal/auth/resolve-username') {
      response = await handleResolveUsername(request, env);
    } else if (method === 'POST' && pathname === '/auth/register') {
      response = await handleRegister(request, env, ctx);
    } else if (method === 'POST' && pathname === '/auth/activate') {
      response = await handleActivate(request, env);
    } else if (method === 'GET' && pathname === '/auth/username-available') {
      response = await handleUsernameAvailable(request, env);
    } else if (method === 'POST' && pathname === '/auth/login') {
      response = await handleLogin(request, env);
    } else if (method === 'POST' && pathname === '/auth/refresh') {
      response = await handleRefresh(request, env, ctx);
    } else if (method === 'POST' && pathname === '/auth/logout') {
      response = await handleLogout(request, env);
    } else if (method === 'PUT' && pathname === '/auth/password') {
      response = await handleChangePassword(request, env);
    } else if (method === 'PUT' && pathname === '/auth/language') {
      response = await handleUpdateLanguage(request, env);
    } else if (method === 'POST' && pathname === '/auth/reset/request') {
      response = await handleResetRequest(request, env, ctx);
    } else if (method === 'POST' && pathname === '/auth/reset/confirm') {
      response = await handleResetConfirm(request, env);
    } else if (method === 'DELETE' && pathname === '/auth/account') {
      response = await handleDeleteAccount(request, env, ctx);
    } else {
      response = json({ error: 'Not found' }, 404);
    }

    return addCors(withSecurityHeaders(response, 'no-store'), request, env.CORS_ALLOWED_ORIGINS);
  },
};
