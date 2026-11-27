CREATE TABLE google_intents (
 state text PRIMARY KEY,
 owner_id text NOT NULL,
 session_id text NOT NULL,
 browser_binding text NOT NULL,
 verifier text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE TABLE connections (
 id text PRIMARY KEY,
 owner_id text NOT NULL,
 google_subject text NOT NULL,
 email text NOT NULL,
 credential bytea NOT NULL,
 UNIQUE (owner_id,google_subject),
 UNIQUE (owner_id,id)
);
CREATE TABLE agent_grants (
 owner_id text NOT NULL,
 connection_id text NOT NULL,
 client_id text NOT NULL,
 PRIMARY KEY (owner_id,connection_id,client_id),
 FOREIGN KEY (owner_id,connection_id) REFERENCES connections (owner_id,id) ON DELETE CASCADE
);
