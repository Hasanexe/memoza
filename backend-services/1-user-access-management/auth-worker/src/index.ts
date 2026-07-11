import { handlePreflight, addCors } from '@memoza/shared';
import { json } from './types';
import type { AuthEnv } from './types';
import { handleRegister } from './handlers/register';
import { handleLogin } from './handlers/login';
import { handleRefresh } from './handlers/refresh';
import { handleLogout } from './handlers/logout';
import { handleChangePassword } from './handlers/password';
import { handleResetRequest } from './handlers/reset-request';
import { handleResetConfirm } from './handlers/reset-confirm';
import { handleDeleteAccount } from './handlers/delete-account';
import { handlePublicKeyLookup } from './handlers/public-key';

export default {
  async fetch(request: Request, env: AuthEnv, ctx: ExecutionContext): Promise<Response> {
    const preflight = handlePreflight(request, env.FRONTEND_ORIGIN, 'GET, POST, PUT, DELETE, OPTIONS');
    if (preflight) return preflight;

    const { pathname } = new URL(request.url);
    const method = request.method;

    let response: Response;

    if (method === 'GET' && pathname === '/internal/auth/public-key') {
      response = await handlePublicKeyLookup(request, env);
    } else if (method === 'POST' && pathname === '/auth/register') {
      response = await handleRegister(request, env, ctx);
    } else if (method === 'POST' && pathname === '/auth/login') {
      response = await handleLogin(request, env);
    } else if (method === 'POST' && pathname === '/auth/refresh') {
      response = await handleRefresh(request, env, ctx);
    } else if (method === 'POST' && pathname === '/auth/logout') {
      response = await handleLogout(request, env);
    } else if (method === 'PUT' && pathname === '/auth/password') {
      response = await handleChangePassword(request, env);
    } else if (method === 'POST' && pathname === '/auth/reset/request') {
      response = await handleResetRequest(request, env, ctx);
    } else if (method === 'POST' && pathname === '/auth/reset/confirm') {
      response = await handleResetConfirm(request, env);
    } else if (method === 'DELETE' && pathname === '/auth/account') {
      response = await handleDeleteAccount(request, env, ctx);
    } else {
      response = json({ error: 'Not found' }, 404);
    }

    return addCors(response, request, env.FRONTEND_ORIGIN);
  },
};
