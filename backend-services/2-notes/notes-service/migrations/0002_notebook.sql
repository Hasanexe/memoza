ALTER TABLE note ADD COLUMN page_no INTEGER;
ALTER TABLE note ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_note_owner_page ON note(owner_id, page_no);

CREATE TABLE owner_page_seq (
  owner_id  TEXT PRIMARY KEY,
  next_page INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE public_page (
  owner_id   TEXT NOT NULL,
  page_no    INTEGER NOT NULL,
  note_id    TEXT NOT NULL REFERENCES note(id),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  format     TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, page_no)
);
