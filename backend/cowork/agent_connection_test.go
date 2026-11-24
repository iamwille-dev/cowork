package cowork

import (
	"bytes"
	"encoding/base64"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAgentConnectionSettings(t *testing.T) {
	t.Setenv("AGENT_CONNECTION_ENCRYPTION_KEY", "")
	useTestPostgres(t)

	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	space := &Workspace{ID: "workspace", Owner: "owner"}
	d.Workspaces[space.ID] = space
	owner := Account{ID: "owner", Workspace: space.ID}
	member := Account{ID: "member", Workspace: space.ID}
	credential := "ellie_agent_" + strings.Repeat("A", 43)
	update := func(account Account, body string, wantStatus int) {
		t.Helper()
		reply := httptest.NewRecorder()
		updateAgentConnection(reply, httptest.NewRequest("POST", "/api/agent-connection", strings.NewReader(body)), d, account, space)
		if reply.Code != wantStatus {
			t.Fatalf("update status = %d, want %d", reply.Code, wantStatus)
		}
		if strings.Contains(reply.Body.String(), credential) {
			t.Fatal("settings response exposed the credential")
		}
	}

	update(member, `{"Enabled":true}`, 403)
	update(owner, `{"Enabled":true,"Key":"invalid"}`, 400)
	update(owner, `{"Enabled":true,"Key":"`+credential+`"}`, 200)
	current, err := load()
	if err != nil {
		t.Fatal(err)
	}
	stored := current.AgentConnectionKeys[space.ID]
	aead, err := agentConnectionCipher(false)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := openAgentConnectionKey(aead, space.ID, stored)
	if err != nil || decoded != credential || !current.Workspaces[space.ID].AgentConnectionEnabled {
		t.Fatal("saved setting or encrypted credential did not round trip")
	}
	assertStoredCredentialEncrypted(t, space.ID, credential)
	info, err := os.Stat(filepath.Join(filepath.Dir(stateFile), "agent-connection.key"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("local encryption key should have mode 0600")
	}
	update(owner, `{"Enabled":false}`, 200)
	if space.AgentConnectionEnabled || d.AgentConnectionKeys[space.ID] != stored {
		t.Fatal("disabling should retain the saved ciphertext")
	}
	update(owner, `{"Enabled":true,"RemoveKey":true}`, 200)
	if space.AgentConnectionEnabled || d.AgentConnectionKeys[space.ID] != "" {
		t.Fatal("removing the key must disable access and clear the credential")
	}
}

func TestAgentConnectionGuestIsolation(t *testing.T) {
	space := &Workspace{ID: "workspace"}
	d := &database{GuestGrants: map[string]guestGrant{
		"guest": {WorkspaceID: space.ID, Expires: time.Now().Add(time.Hour)},
	}}
	if protectAgentConnectionThread(d, space.ID, "") {
		t.Fatal("a conversation with an active guest grant must not get email access")
	}
	delete(d.GuestGrants, "guest")
	if !protectAgentConnectionThread(d, space.ID, "") {
		t.Fatal("an internal conversation should get email access")
	}
	reply := httptest.NewRecorder()
	makeGuestInvite(reply, d, space, "owner", "", "guest@example.com")
	if reply.Code != 409 {
		t.Fatalf("guest invitation status = %d, want 409", reply.Code)
	}
}

func TestMigrateAgentConnectionKeys(t *testing.T) {
	useTestPostgres(t)

	const workspace = "workspace"
	credential := "ellie_agent_" + strings.Repeat("B", 43)
	legacy := []byte(`{"Workspaces":{"workspace":{"Role":"Sales Lead"}},"AgentConnectionKeys":{"workspace":"` + credential + `"}}`)
	if err := os.WriteFile(stateFile, legacy, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENT_CONNECTION_ENCRYPTION_KEY", "invalid")
	if _, err := load(); err == nil {
		t.Fatal("migration must fail with an invalid encryption key")
	}
	raw, err := os.ReadFile(stateFile)
	if err != nil || !bytes.Equal(raw, legacy) {
		t.Fatal("a failed migration must leave the original state intact")
	}

	t.Setenv("AGENT_CONNECTION_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32)))
	migrated, err := load()
	if err != nil {
		t.Fatal(err)
	}
	raw, err = os.ReadFile(stateFile)
	if err != nil || !bytes.Equal(raw, legacy) || migrated.Workspaces[workspace].Role != "Sales Lead" {
		t.Fatal("migration should preserve workspace data and the source file")
	}
	assertStoredCredentialEncrypted(t, workspace, credential)
	stored := migrated.AgentConnectionKeys[workspace]
	aead, err := agentConnectionCipher(false)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := openAgentConnectionKey(aead, workspace, stored)
	if err != nil || recovered != credential {
		t.Fatal("migration should preserve the original credential")
	}
	if _, err := openAgentConnectionKey(aead, "other-workspace", stored); err == nil {
		t.Fatal("ciphertext must be bound to its workspace")
	}
	reopened, err := load()
	if err != nil || reopened.AgentConnectionKeys[workspace] != stored {
		t.Fatal("reopening migrated state should preserve ciphertext")
	}
}
