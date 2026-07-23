import { request } from './client';

export interface NoteRow {
  id: string;
  owner_id: string;
  title_ct: string;
  tags_ct: string | null;
  wrapped_cek: string;
  wrap_method: 'dek' | 'pubkey';
  has_unread_comment: boolean;
  page_no: number | null;
  is_public: boolean;
  rev: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface NoteShare {
  user_id: string;
  username: string | null;
}

export interface FullNote extends NoteRow {
  body_ct: string;
  owner_username?: string | null;
  shares?: NoteShare[];
}

export interface ListResponse {
  notes: NoteRow[];
  tombstones: string[];
  revoked: string[];
  next: string | null;
}

export function listNotes(since?: string, limit?: number): Promise<ListResponse> {
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return request(`/notes${qs ? `?${qs}` : ''}`, { method: 'GET' });
}

export function getNote(id: string): Promise<FullNote> {
  return request(`/notes/${id}`, { method: 'GET' });
}

export interface CreateNoteRequest {
  title_ct: string;
  body_ct: string;
  tags_ct: string | null;
  wrapped_cek: string;
}

export interface CreateNoteResponse {
  id: string;
  rev: number;
  created_at: number;
  updated_at: number;
  page_no: number;
}

export function createNote(id: string, body: CreateNoteRequest): Promise<CreateNoteResponse> {
  return request(`/notes/${id}`, { method: 'PUT', body: JSON.stringify(body) });
}

export interface UpdateNoteRequest {
  title_ct: string;
  body_ct: string;
  tags_ct: string | null;
  base_rev: number;
  title?: string;
  body?: string;
  format?: string;
}

export interface UpdateNoteResponse {
  rev: number;
  updated_at: number;
}

export function updateNote(id: string, body: UpdateNoteRequest): Promise<UpdateNoteResponse> {
  return request(`/notes/${id}`, { method: 'PUT', body: JSON.stringify(body) });
}

export function trashNote(id: string): Promise<{ ok: true }> {
  return request(`/notes/${id}`, { method: 'DELETE' });
}

export function restoreNote(id: string): Promise<{ ok: true }> {
  return request(`/notes/${id}/restore`, { method: 'POST' });
}

export function purgeNote(id: string): Promise<{ ok: true }> {
  return request(`/notes/${id}/purge`, { method: 'DELETE' });
}

export function shareNote(id: string, recipientId: string, wrappedCek: string, username: string): Promise<{ ok: true }> {
  return request(`/notes/${id}/share`, {
    method: 'POST',
    body: JSON.stringify({ recipient_id: recipientId, wrapped_cek: wrappedCek, username }),
  });
}

export function unshareNote(id: string, userId: string): Promise<{ ok: true }> {
  return request(`/notes/${id}/share/${userId}`, { method: 'DELETE' });
}

export interface PublishNoteRequest {
  title: string;
  body: string;
  format: string;
}

export function publishNote(id: string, body: PublishNoteRequest): Promise<{ page_no: number }> {
  return request(`/notes/${id}/publish`, { method: 'POST', body: JSON.stringify(body) });
}

export interface CommentRow {
  id: string;
  author_username: string | null;
  body_ct: string;
  created_at: number;
}

export function listComments(noteId: string): Promise<{ comments: CommentRow[] }> {
  return request(`/notes/${noteId}/comments`, { method: 'GET' });
}

export function postComment(noteId: string, id: string, bodyCt: string): Promise<CommentRow> {
  return request(`/notes/${noteId}/comments`, { method: 'POST', body: JSON.stringify({ id, body_ct: bodyCt }) });
}

export function deleteComment(noteId: string, commentId: string): Promise<{ ok: true }> {
  return request(`/notes/${noteId}/comments/${commentId}`, { method: 'DELETE' });
}
