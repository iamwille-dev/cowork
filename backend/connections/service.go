package connections

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"cowork/internal/postgres"
)

const browserPrefix = "/integrations/agent-connections"
const sharedDatabaseSchema = "agent_connections"

//go:embed schema/*.up.sql
var migrations embed.FS

var serviceMutex sync.Mutex
var gatewayHandler http.Handler

func loadGateway(ctx context.Context) (http.Handler, error) {
	serviceMutex.Lock()
	defer serviceMutex.Unlock()
	if gatewayHandler != nil {
		return gatewayHandler, nil
	}
	dsn := strings.TrimSpace(os.Getenv("AGENT_CONNECTIONS_DATABASE_URL"))
	var schema string
	if dsn == "" {
		dsn = strings.TrimSpace(os.Getenv("DATABASE_URL"))
		schema = sharedDatabaseSchema
	}
	if dsn == "" {
		return nil, fmt.Errorf("Agent Connections database is unconfigured")
	}
	gateway, err := configure()
	if err != nil {
		return nil, err
	}
	db, err := postgres.Open(dsn, schema)
	if err != nil {
		return nil, err
	}
	if err := migrate(ctx, db, schema); err != nil {
		db.Close()
		return nil, err
	}
	gateway.db = db
	gatewayHandler = gateway.routes()
	return gatewayHandler, nil
}

func rowCount(result sql.Result) int64 {
	count, _ := result.RowsAffected()
	return count
}

func migrate(ctx context.Context, db *sql.DB, schema string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Keep the standalone gateway's migration ledger and the same advisory lock.
	if _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(701015)"); err != nil {
		return err
	}
	if err := postgres.EnsureSchema(ctx, tx, schema); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS ellie_migrations (filename text PRIMARY KEY)"); err != nil {
		return err
	}
	files, err := migrations.ReadDir("schema")
	if err != nil {
		return err
	}
	for _, file := range files {
		var applied bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM ellie_migrations WHERE filename=$1)", file.Name()).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}
		body, err := migrations.ReadFile("schema/" + file.Name())
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, string(body)); err != nil {
			return fmt.Errorf("apply migration %s: %w", file.Name(), err)
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO ellie_migrations VALUES ($1)", file.Name()); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if os.Getenv("AGENT_CONNECTIONS_ENABLED") != "1" {
		http.Error(w, "Agent Connections is unavailable on this deployment.", http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	handler, err := loadGateway(ctx)
	if err != nil {
		http.Error(w, "Agent Connections could not start.", http.StatusServiceUnavailable)
		return
	}
	handler.ServeHTTP(w, r)
}

//encore:api public raw method=GET,POST,PUT,DELETE path=/integrations/agent-connections/*path
func Browser(w http.ResponseWriter, r *http.Request) {
	serve(w, r)
}

//encore:api public raw path=/mcp
func MCP(w http.ResponseWriter, r *http.Request) {
	serve(w, r)
}

//encore:api public raw method=GET path=/.well-known/oauth-protected-resource/mcp
func ResourceMetadata(w http.ResponseWriter, r *http.Request) {
	serve(w, r)
}
