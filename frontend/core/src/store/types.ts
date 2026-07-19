export interface DecryptedNoteSummary {
  id: string;
  ownerId: string;
  isOwner: boolean;
  title: string;
  tags: string[];
  hasUnreadComment: boolean;
  pageNo: number | null;
  isPublic: boolean;
  rev: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface DecryptedNote extends DecryptedNoteSummary {
  body: string;
}

export interface DecryptedComment {
  id: string;
  authorId: string;
  body: string;
  createdAt: number;
}

export interface Store {
  sync(force?: boolean): Promise<void>;
  listNotes(): Promise<DecryptedNoteSummary[]>;
  getNote(id: string): Promise<DecryptedNote | null>;
  saveNote(id: string | null, title: string, body: string, tags: string[]): Promise<DecryptedNote>;
  trashNote(id: string): Promise<void>;
  restoreNote(id: string): Promise<void>;
  purgeNote(id: string): Promise<void>;
  shareNote(id: string, recipientEmail: string): Promise<void>;
  unshareNote(id: string, userId: string): Promise<void>;
  publish(id: string): Promise<number>;
  listComments(noteId: string): Promise<DecryptedComment[]>;
  postComment(noteId: string, body: string): Promise<DecryptedComment>;
  deleteComment(noteId: string, commentId: string): Promise<void>;
  search(query: string): Promise<DecryptedNoteSummary[]>;
}
