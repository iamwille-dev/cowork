CREATE TABLE activity_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id text NOT NULL,
    client_id text NOT NULL,
    agent_name text NOT NULL,
    connection_id text,
    connection_label text,
    operation text NOT NULL,
    succeeded boolean NOT NULL,
    duration_ms bigint NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX activity_logs_owner_idx ON activity_logs (owner_id, id DESC);
CREATE INDEX activity_logs_connection_idx ON activity_logs (owner_id, connection_id, id DESC);
CREATE INDEX activity_logs_client_idx ON activity_logs (owner_id, client_id, id DESC);
