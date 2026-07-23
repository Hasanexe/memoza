ALTER TABLE note_comment ADD COLUMN author_username TEXT;
ALTER TABLE note_comment DROP COLUMN author_id;

ALTER TABLE note_grant ADD COLUMN username TEXT;
