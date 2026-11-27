CREATE TABLE workspace_credentials (
 owner_id text PRIMARY KEY,
 client_id text NOT NULL UNIQUE,
 name text NOT NULL,
 credential_hash bytea NOT NULL UNIQUE
);

CREATE VIEW connection_access AS
 SELECT owner_id, connection_id, client_id FROM agent_grants
 UNION ALL
 SELECT c.owner_id, c.id, w.client_id
 FROM connections c JOIN workspace_credentials w USING (owner_id);

CREATE TABLE github_intents (LIKE google_intents INCLUDING ALL);

ALTER TABLE connections
 DROP CONSTRAINT connection_kind,
 ADD COLUMN github_subject text,
 ADD COLUMN github_login text,
 ADD UNIQUE (owner_id, github_subject),
 ADD CONSTRAINT connection_kind CHECK (
  (kind = 'gmail' AND google_subject IS NOT NULL AND email IS NOT NULL
   AND github_subject IS NULL AND github_login IS NULL
   AND ssh_host IS NULL AND ssh_port IS NULL AND ssh_user IS NULL AND ssh_fingerprint IS NULL)
  OR
  (kind = 'ssh' AND google_subject IS NULL AND email IS NULL
   AND github_subject IS NULL AND github_login IS NULL
   AND ssh_host IS NOT NULL AND ssh_port IS NOT NULL AND ssh_port BETWEEN 1 AND 65535
   AND ssh_user IS NOT NULL AND ssh_fingerprint IS NOT NULL)
  OR
  (kind = 'github' AND github_subject IS NOT NULL AND github_login IS NOT NULL
   AND google_subject IS NULL AND email IS NULL
   AND ssh_host IS NULL AND ssh_port IS NULL AND ssh_user IS NULL AND ssh_fingerprint IS NULL)
 );
