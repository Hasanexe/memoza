CREATE TABLE note (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  title_ct   TEXT NOT NULL,
  body_ct    TEXT NOT NULL,
  tags_ct    TEXT,
  rev        INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purged_at  INTEGER
);

CREATE INDEX idx_note_owner ON note(owner_id);
CREATE INDEX idx_note_updated ON note(updated_at);

CREATE TABLE note_grant (
  note_id     TEXT NOT NULL REFERENCES note(id),
  user_id     TEXT NOT NULL,
  wrapped_cek TEXT NOT NULL,
  wrap_method TEXT NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  PRIMARY KEY (note_id, user_id)
);

CREATE INDEX idx_grant_user_updated ON note_grant(user_id, updated_at, note_id);
CREATE INDEX idx_grant_note ON note_grant(note_id);

CREATE TABLE note_comment (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES note(id),
  author_id  TEXT NOT NULL,
  body_ct    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_comment_note ON note_comment(note_id, created_at);

CREATE TABLE sweep (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  last_run INTEGER NOT NULL
);

INSERT INTO sweep (id, last_run) VALUES (1, 0);
