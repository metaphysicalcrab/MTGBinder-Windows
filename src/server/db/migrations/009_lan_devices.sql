-- Phones paired with Binder (spec §5.10, M13). A phone's token is never stored: token_hash is its HMAC-SHA256 under the
-- secret in the library folder's lan/secret, outside this file, so a copy of the database can't let a phone in.
-- `origin` is the address the phone paired at (its cookie belongs to it); last_seen_at and last_ip are written at most
-- once a minute. Ids are never reused, so a forgotten phone's cookie can't name a phone paired after it.
CREATE TABLE lan_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash BLOB NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  last_ip TEXT,
  origin TEXT NOT NULL,
  user_agent TEXT
);
