package cowork

import (
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAgentConnectionSettings(t *testing.T) {
	previousState := stateFile
	stateFile = filepath.Join(t.TempDir(), "state.json")
	t.Cleanup(func() { stateFile = previousState })

	space := &Workspace{ID: "workspace", Owner: "owner"}
	owner := Account{ID: "owner", Workspace: space.ID}
	member := Account{ID: "member", Workspace: space.ID}
	d := &database{Workspaces: map[string]*Workspace{space.ID: space}}
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
	if err != nil || !current.Workspaces[space.ID].AgentConnectionEnabled || current.AgentConnectionKeys[space.ID] != credential {
		t.Fatal("enabled setting and credential were not persisted")
	}
	update(owner, `{"Enabled":false}`, 200)
	if space.AgentConnectionEnabled || d.AgentConnectionKeys[space.ID] != credential {
		t.Fatal("disabling should retain the saved credential")
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
