package cowork

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

type database struct {
	Accounts               map[string]Account
	Sessions               map[string]string
	Workspaces             map[string]*Workspace
	GuestGrants            map[string]guestGrant      `json:",omitempty"`
	AgentConnectionKeys    map[string]string          `json:",omitempty"`
	AgentConnectionThreads map[string]map[string]bool `json:",omitempty"`
	revision               int64
}

type postgresStorage struct {
	mutex sync.Mutex
	db    *sql.DB
}

var storage = &postgresStorage{}
var stateFile = filepath.Join(".cowork", "state.json")

const storageSchema = `
CREATE TABLE IF NOT EXISTS cowork_storage_revision (
	singleton boolean PRIMARY KEY CHECK (singleton),
	revision bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS cowork_records (
	kind text NOT NULL CHECK (kind IN (
		'Accounts', 'Sessions', 'Workspaces', 'GuestGrants',
		'AgentConnectionKeys', 'AgentConnectionThreads'
	)),
	record_key text NOT NULL,
	payload jsonb NOT NULL,
	PRIMARY KEY (kind, record_key)
);
INSERT INTO cowork_storage_revision (singleton, revision)
VALUES (true, 0) ON CONFLICT DO NOTHING;
`

func emptyDatabase() *database {
	return &database{Accounts: map[string]Account{}, Sessions: map[string]string{}, Workspaces: map[string]*Workspace{}}
}

func (s *postgresStorage) connect(ctx context.Context) (*sql.DB, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if s.db != nil {
		return s.db, nil
	}
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		return nil, errors.New("DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", url)
	if err != nil {
		return nil, err
	}
	if err := initializeStorage(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	s.db = db
	return db, nil
}

func (s *postgresStorage) ready(ctx context.Context) error {
	db, err := s.connect(ctx)
	if err != nil {
		return err
	}
	return db.PingContext(ctx)
}

func initializeStorage(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Serialize schema creation and the one-time snapshot import across processes.
	if _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(3846974703086560441)"); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, storageSchema); err != nil {
		return err
	}
	var revision int64
	if err := tx.QueryRowContext(ctx, "SELECT revision FROM cowork_storage_revision WHERE singleton").Scan(&revision); err != nil {
		return err
	}
	if revision != 0 {
		return tx.Commit()
	}
	d := emptyDatabase()
	raw, err := os.ReadFile(stateFile)
	importing := err == nil
	switch {
	case importing:
		if err := json.Unmarshal(raw, d); err != nil {
			return err
		}
		if err := migrateAgentConnectionKeys(d); err != nil {
			return err
		}
	case !errors.Is(err, os.ErrNotExist):
		return err
	case os.Getenv("COWORK_REQUIRE_LEGACY_STATE") == "1":
		return errors.New("the required legacy state file is missing")
	}
	if err := writeRecords(ctx, tx, d); err != nil {
		return err
	}
	if importing {
		if err := verifyLegacyImport(ctx, tx, d); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if importing {
		log.Printf("Cowork legacy import committed and verified accounts=%d sessions=%d workspaces=%d guest_grants=%d agent_keys=%d agent_thread_maps=%d",
			len(d.Accounts), len(d.Sessions), len(d.Workspaces), len(d.GuestGrants),
			len(d.AgentConnectionKeys), len(d.AgentConnectionThreads))
	}
	return nil
}

func verifyLegacyImport(ctx context.Context, tx *sql.Tx, d *database) error {
	raw, err := json.Marshal(d)
	if err != nil {
		return err
	}
	var matches bool
	err = tx.QueryRowContext(ctx, `
		SELECT COALESCE((
			SELECT jsonb_object_agg(kind, records)
			FROM (
				SELECT kind, jsonb_object_agg(record_key, payload) AS records
				FROM cowork_records GROUP BY kind
			) AS collections
		), '{}'::jsonb) = COALESCE((
			SELECT jsonb_object_agg(key, value)
			FROM jsonb_each($1::jsonb)
			WHERE jsonb_typeof(value) = 'object' AND value <> '{}'::jsonb
		), '{}'::jsonb)
	`, string(raw)).Scan(&matches)
	if err != nil {
		return err
	}
	if !matches {
		return errors.New("PostgreSQL records do not match the legacy import")
	}
	return nil
}

func load() (*database, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db, err := storage.connect(ctx)
	if err != nil {
		return nil, err
	}
	d := emptyDatabase()
	var raw []byte
	err = db.QueryRowContext(ctx, `
		SELECT revision, COALESCE((
			SELECT jsonb_object_agg(kind, records)
			FROM (
				SELECT kind, jsonb_object_agg(record_key, payload) AS records
				FROM cowork_records GROUP BY kind
			) AS collections
		), '{}'::jsonb)
		FROM cowork_storage_revision WHERE singleton
	`).Scan(&d.revision, &raw)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, d); err != nil {
		return nil, err
	}
	return d, nil
}

func save(d *database) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db, err := storage.connect(ctx)
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := writeRecords(ctx, tx, d); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	d.revision++
	return nil
}

var errStaleWorkspace = errors.New("workspace data changed before it could be saved")

func writeRecords(ctx context.Context, tx *sql.Tx, d *database) error {
	result, err := tx.ExecContext(ctx, `
		UPDATE cowork_storage_revision SET revision = revision + 1
		WHERE singleton AND revision = $1
	`, d.revision)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return errStaleWorkspace
	}
	raw, err := json.Marshal(d)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		WITH incoming AS MATERIALIZED (
			SELECT collection.key AS kind, record.key AS record_key, record.value AS payload
			FROM jsonb_each($1::jsonb) AS collection
			CROSS JOIN LATERAL jsonb_each(NULLIF(collection.value, 'null'::jsonb)) AS record
		), removed AS (
			DELETE FROM cowork_records AS existing
			WHERE NOT EXISTS (
				SELECT 1 FROM incoming
				WHERE incoming.kind = existing.kind AND incoming.record_key = existing.record_key
			)
		)
		INSERT INTO cowork_records AS existing (kind, record_key, payload)
		SELECT kind, record_key, payload FROM incoming
		ON CONFLICT (kind, record_key) DO UPDATE SET payload = excluded.payload
		WHERE existing.payload IS DISTINCT FROM excluded.payload
	`, string(raw))
	return err
}
