package cowork

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func useTestPostgres(t *testing.T) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is required for PostgreSQL integration tests")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	schema := "test_" + key()
	if _, err := db.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := db.Exec("DROP SCHEMA " + schema + " CASCADE"); err != nil {
			t.Error(err)
		}
	})
	testURL, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := testURL.Query()
	query.Set("search_path", schema)
	testURL.RawQuery = query.Encode()
	t.Setenv("DATABASE_URL", testURL.String())

	previousStorage, previousState := storage, stateFile
	storage = &postgresStorage{}
	stateFile = filepath.Join(t.TempDir(), "state.json")
	t.Cleanup(func() {
		if storage.db != nil {
			storage.db.Close()
		}
		storage, stateFile = previousStorage, previousState
	})
}

func assertStoredCredentialEncrypted(t *testing.T, workspace, credential string) {
	t.Helper()
	var saved string
	err := storage.db.QueryRow(`
		SELECT payload #>> '{}' FROM cowork_records
		WHERE kind = 'AgentConnectionKeys' AND record_key = $1
	`, workspace).Scan(&saved)
	if err != nil || !strings.HasPrefix(saved, agentConnectionCiphertextPrefix) || strings.Contains(saved, credential) {
		t.Fatalf("expected encrypted credential in PostgreSQL, query error: %v", err)
	}
}

func TestPostgresImportsOnceAndRejectsStaleWrites(t *testing.T) {
	useTestPostgres(t)
	t.Setenv("COWORK_REQUIRE_LEGACY_STATE", "1")
	if _, err := load(); err == nil {
		t.Fatal("required legacy state should prevent initializing an empty database")
	}
	legacy := `{
		"Accounts": {"owner@example.com":{"ID":"owner","Email":"owner@example.com","Workspace":"space"}},
		"Sessions": {"session":"owner@example.com"},
		"Workspaces": {"space":{"ID":"space","Owner":"owner","Threads":[{"ID":"thread","Messages":[{"Text":"hello"}]}],"Tasks":[{"ID":"task"}],"Reminders":[{"ID":"reminder"}]}},
		"GuestGrants": {"guest":{"WorkspaceID":"space"}},
		"AgentConnectionThreads": {"space":{"thread":true}}
	}`
	if err := os.WriteFile(stateFile, []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}
	reply := httptest.NewRecorder()
	API(reply, httptest.NewRequest("GET", "/api/health", nil))
	if reply.Code != 200 {
		t.Fatalf("health status = %d", reply.Code)
	}
	request := httptest.NewRequest("GET", "/api/workspace", nil)
	request.AddCookie(&http.Cookie{Name: "cowork_session", Value: "session"})
	reply = httptest.NewRecorder()
	API(reply, request)
	if reply.Code != 200 || !strings.Contains(reply.Body.String(), "hello") {
		t.Fatalf("imported session could not load conversation history, status = %d", reply.Code)
	}
	current, err := load()
	if err != nil {
		t.Fatal(err)
	}
	space := current.Workspaces["space"]
	if current.Accounts[current.Sessions["session"]].ID != "owner" ||
		space == nil || space.Threads[0].Messages[0].Text != "hello" ||
		space.Tasks[0].ID != "task" || space.Reminders[0].ID != "reminder" ||
		current.GuestGrants["guest"].WorkspaceID != "space" || !current.AgentConnectionThreads["space"]["thread"] {
		t.Fatal("legacy workspace state did not round trip")
	}

	stale, err := load()
	if err != nil {
		t.Fatal(err)
	}
	delete(current.Sessions, "session")
	space.Role = "Developer"
	if err := save(current); err != nil {
		t.Fatal(err)
	}
	if err := save(stale); !errors.Is(err, errStaleWorkspace) {
		t.Fatalf("stale write error = %v", err)
	}

	restarted := &postgresStorage{}
	db, err := restarted.connect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	if err := db.QueryRow("SELECT count(*) FROM cowork_records WHERE kind = 'Sessions'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("restart restored a deleted session, count = %d, query error = %v", count, err)
	}
	persisted, err := load()
	if err != nil || persisted.Workspaces["space"].Role != "Developer" {
		t.Fatalf("workspace update was lost, load error = %v", err)
	}
}
