import { json, readUserId } from './types';
import type { NotesEnv } from './types';
import { handleList } from './handlers/list';
import { handleGetNote } from './handlers/get-note';
import { handlePutNote } from './handlers/put-note';
import { handleTrashNote, handleRestoreNote, handlePurgeNote } from './handlers/trash';
import { handleUpdateGrant } from './handlers/grant';
import { handleShareNote, handleUnshareNote } from './handlers/share';
import { handleListComments, handlePostComment, handleDeleteComment } from './handlers/comments';
import { handlePurgeUser } from './handlers/internal-purge';

export default {
  async fetch(request: Request, env: NotesEnv): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);
    const method = request.method;

    if (method === 'POST' && pathname === '/notes/internal/purge-user') {
      return handlePurgeUser(request, env);
    }

    const userId = readUserId(request);
    if (!userId) return json({ error: 'Unauthorized' }, 401);

    if (method === 'GET' && pathname === '/notes') {
      return handleList(env, userId, searchParams);
    }

    const restoreMatch = pathname.match(/^\/notes\/([^/]+)\/restore$/);
    if (method === 'POST' && restoreMatch) {
      return handleRestoreNote(env, userId, restoreMatch[1]);
    }

    const purgeMatch = pathname.match(/^\/notes\/([^/]+)\/purge$/);
    if (method === 'DELETE' && purgeMatch) {
      return handlePurgeNote(env, userId, purgeMatch[1]);
    }

    const grantMatch = pathname.match(/^\/notes\/([^/]+)\/grant$/);
    if (method === 'PATCH' && grantMatch) {
      return handleUpdateGrant(request, env, userId, grantMatch[1]);
    }

    const unshareMatch = pathname.match(/^\/notes\/([^/]+)\/share\/([^/]+)$/);
    if (method === 'DELETE' && unshareMatch) {
      return handleUnshareNote(env, userId, unshareMatch[1], unshareMatch[2]);
    }

    const shareMatch = pathname.match(/^\/notes\/([^/]+)\/share$/);
    if (method === 'POST' && shareMatch) {
      return handleShareNote(request, env, userId, shareMatch[1]);
    }

    const commentMatch = pathname.match(/^\/notes\/([^/]+)\/comments\/([^/]+)$/);
    if (method === 'DELETE' && commentMatch) {
      return handleDeleteComment(env, userId, commentMatch[1], commentMatch[2]);
    }

    const commentsMatch = pathname.match(/^\/notes\/([^/]+)\/comments$/);
    if (method === 'GET' && commentsMatch) {
      return handleListComments(env, userId, commentsMatch[1]);
    }
    if (method === 'POST' && commentsMatch) {
      return handlePostComment(request, env, userId, commentsMatch[1]);
    }

    const notesMatch = pathname.match(/^\/notes\/([^/]+)$/);
    if (method === 'GET' && notesMatch) {
      return handleGetNote(env, userId, notesMatch[1]);
    }
    if (method === 'PUT' && notesMatch) {
      return handlePutNote(request, env, userId, notesMatch[1]);
    }
    if (method === 'DELETE' && notesMatch) {
      return handleTrashNote(env, userId, notesMatch[1]);
    }

    return json({ error: 'Not found' }, 404);
  },
};
