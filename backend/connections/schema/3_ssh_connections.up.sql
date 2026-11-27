ALTER TABLE connections
 ADD COLUMN kind text NOT NULL DEFAULT 'gmail',
 ALTER COLUMN google_subject DROP NOT NULL,
 ALTER COLUMN email DROP NOT NULL,
 ADD COLUMN ssh_host text,
 ADD COLUMN ssh_port integer,
 ADD COLUMN ssh_user text,
 ADD COLUMN ssh_fingerprint text,
 ADD CONSTRAINT connection_kind CHECK (
  (kind = 'gmail' AND google_subject IS NOT NULL AND email IS NOT NULL
   AND ssh_host IS NULL AND ssh_port IS NULL AND ssh_user IS NULL AND ssh_fingerprint IS NULL)
  OR
  (kind = 'ssh' AND google_subject IS NULL AND email IS NULL
   AND ssh_host IS NOT NULL AND ssh_port IS NOT NULL AND ssh_port BETWEEN 1 AND 65535
   AND ssh_user IS NOT NULL AND ssh_fingerprint IS NOT NULL)
 );
