CREATE TABLE users (
  id                            TEXT PRIMARY KEY,
  email                         TEXT UNIQUE NOT NULL,
  name                          TEXT NOT NULL,
  password_hash                 TEXT NOT NULL,
  role                          TEXT NOT NULL DEFAULT 'Editor',
  created_at                    INTEGER NOT NULL,
  active                        INTEGER NOT NULL DEFAULT 1,
  kdf_iterations                INTEGER NOT NULL DEFAULT 600000,
  public_key                    TEXT NOT NULL DEFAULT '',
  wrapped_dek                   TEXT NOT NULL DEFAULT '',
  wrapped_private_key           TEXT NOT NULL DEFAULT '',
  wrapped_dek_recovery          TEXT,
  wrapped_private_key_recovery  TEXT,
  recovery_mode                 TEXT NOT NULL DEFAULT 'private',
  escrowed_recovery             TEXT
);

CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

CREATE TABLE reset_token (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_reset_token_user ON reset_token(user_id);
