CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('user', 'organization')),
  name TEXT NOT NULL,
  organization_name TEXT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  public_key_pem TEXT,
  encrypted_private_key JSONB,
  verification_token TEXT,
  reset_token TEXT,
  reset_expires BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  date DATE NOT NULL,
  time TEXT NOT NULL,
  venue TEXT NOT NULL,
  organizer TEXT NOT NULL,
  price NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'MXN',
  price_mxn NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  organization_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  buyer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'valid',
  public_code TEXT UNIQUE NOT NULL,
  visible_code TEXT UNIQUE NOT NULL,
  public_claims JSONB NOT NULL,
  encrypted_holder JSONB NOT NULL,
  crypto JSONB NOT NULL,
  purchase_price NUMERIC(12,2),
  currency TEXT NOT NULL DEFAULT 'MXN',
  transfer JSONB,
  transfer_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  access_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  holder_signature JSONB,
  hidden_for JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS deleted_ticket_counters (
  event_id TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);
