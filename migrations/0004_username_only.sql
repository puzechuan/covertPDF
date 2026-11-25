CREATE TABLE users_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO users_new (id, username, password_hash, role, created_at)
SELECT id, username, password_hash, role, created_at
FROM users
WHERE password_hash IS NOT NULL AND password_hash <> '' AND username IS NOT NULL AND username <> '';

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;

UPDATE settings SET value = '0' WHERE key = 'initialized';
