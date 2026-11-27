package connections

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

func TestGatewayPreservesExistingKeyAndProviderCredential(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is required for PostgreSQL integration tests")
	}
	ctx := context.Background()
	base, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer base.Close()
	schema := "connections_test_" + hex.EncodeToString(randBytes(8))
	if _, err := base.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer base.ExecContext(ctx, "DROP SCHEMA "+schema+" CASCADE")
	testURL, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := testURL.Query()
	query.Set("search_path", schema)
	testURL.RawQuery = query.Encode()
	db, err := sql.Open("pgx", testURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	key, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	const owner, connectionID, agentID = "user_legacy", "original-connection", "original-agent"
	const bearer, token = "ellie_agent_fixture", "fixture-google-token"
	source := &app{db: db, key: key}
	ciphertext := source.sealCredential(owner, connectionID, token)
	hash := sha256.Sum256([]byte(bearer))
	if _, err := db.ExecContext(ctx, "INSERT INTO connections (id,owner_id,google_subject,email,credential) VALUES ($1,$2,$3,$4,$5)", connectionID, owner, "google-fixture", "fixture@example.test", ciphertext); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO workspace_credentials (owner_id,client_id,name,credential_hash) VALUES ($1,$2,$3,$4)", owner, agentID, "Workspace key", hash[:]); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	destination := &app{db: db, key: key, testers: map[string]bool{owner: true}, resource: "https://cowork.example.test/mcp"}
	principal, err := destination.authenticateAgent(ctx, bearer)
	if err != nil || principal.owner != owner || principal.client != agentID {
		t.Fatalf("existing key was not accepted: %v", err)
	}
	accounts, err := destination.connections(ctx, principal.owner, principal.client)
	if err != nil || len(accounts) != 1 || accounts[0].ID != connectionID {
		t.Fatalf("existing connection was not accessible: %v", err)
	}
	var sealed []byte
	if err := db.QueryRowContext(ctx, "SELECT credential FROM connections WHERE id=$1", connectionID).Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	if string(sealed) != string(ciphertext) {
		t.Fatal("migration rewrote the encrypted provider credential")
	}
	value, err := destination.openCredential(owner, connectionID, sealed)
	if err != nil || value != token {
		t.Fatal("could not decrypt the existing credential")
	}
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_connections","arguments":{}}}`))
	request.Header.Set("Authorization", "Bearer "+bearer)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	recorder := httptest.NewRecorder()
	destination.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), connectionID) || strings.Contains(recorder.Body.String(), token) {
		t.Fatalf("existing key could not list its connection at /mcp: %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	destination.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/.well-known/oauth-protected-resource/mcp", nil))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), destination.resource) {
		t.Fatal("MCP discovery did not advertise the new endpoint")
	}
}
