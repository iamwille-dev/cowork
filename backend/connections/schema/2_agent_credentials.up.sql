CREATE TABLE agent_credentials (
    owner_id text NOT NULL,
    connection_id text NOT NULL,
    client_id text NOT NULL,
    name text NOT NULL,
    credential_hash bytea NOT NULL UNIQUE,
    PRIMARY KEY (owner_id, connection_id, client_id),
    FOREIGN KEY (owner_id, connection_id, client_id)
        REFERENCES agent_grants (owner_id, connection_id, client_id) ON DELETE CASCADE
);
