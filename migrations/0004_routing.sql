CREATE TABLE inboxes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  local_part TEXT NOT NULL,
  domain TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  cf_zone_id TEXT,
  cf_rule_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_inboxes_domain ON inboxes(domain);

CREATE TABLE aliases (
  id TEXT PRIMARY KEY,
  source_email TEXT NOT NULL UNIQUE,
  local_part TEXT NOT NULL,
  domain TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  cf_zone_id TEXT,
  cf_rule_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_aliases_domain ON aliases(domain);

CREATE TABLE alias_destinations (
  id TEXT PRIMARY KEY,
  alias_id TEXT NOT NULL REFERENCES aliases(id) ON DELETE CASCADE,
  destination_email TEXT NOT NULL,
  cf_destination_id TEXT,
  status TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(alias_id, destination_email)
);

CREATE INDEX idx_alias_destinations_alias ON alias_destinations(alias_id);
