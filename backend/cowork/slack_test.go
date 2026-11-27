package cowork

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSlackThreadKeepsOneCoworkConversation(t *testing.T) {
	useTestPostgres(t)
	t.Setenv("MASTRA_ENCRYPTION_KEY", strings.Repeat("t", 32))
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	space := &Workspace{ID: key(), Role: "Developer", Agents: []workspaceAgent{{ID: "developer", Role: "Developer", Name: "Sammy", Channel: "slack"}}}
	d.Workspaces[space.ID] = space
	if err := save(d); err != nil {
		t.Fatal(err)
	}
	actor := channelActor{WorkspaceID: space.ID, Channel: "slack", Agent: "ada", Installation: "install", Conversation: "slack:C123:17000000.1", SenderID: "U123", Author: "Nora"}
	record := func(actor channelActor, id string, reply bool, want int) map[string]any {
		t.Helper()
		body, _ := json.Marshal(struct {
			channelActor
			Data map[string]any
		}{actor, map[string]any{"ID": id, "Title": "#engineering", "Text": "fixture", "At": time.Now(), "Reply": reply}})
		request := httptest.NewRequest(http.MethodPost, "/internal/channel-tools/slack-message", bytes.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+channelBridgeSecret("slack"))
		recorder := httptest.NewRecorder()
		ChannelToolBridge(recorder, request)
		if recorder.Code != want {
			t.Fatalf("Slack bridge returned %d, want %d: %s", recorder.Code, want, recorder.Body.String())
		}
		var result map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	created := record(actor, "message-1", false, http.StatusOK)
	duplicate := record(actor, "message-1", false, http.StatusOK)
	reply := record(actor, "reply-1", true, http.StatusOK)
	if created["ThreadID"] == nil || created["ThreadID"] != duplicate["ThreadID"] || created["ThreadID"] != reply["ThreadID"] || duplicate["Duplicate"] != true {
		t.Fatalf("unexpected Slack thread mapping: %v, %v, %v", created, duplicate, reply)
	}
	privateActor := actor
	privateActor.Conversation = "slack:D123:17000000.1"
	record(privateActor, "private-1", false, http.StatusBadRequest)
	reloaded, err := load()
	if err != nil {
		t.Fatal(err)
	}
	threads := reloaded.Workspaces[space.ID].Threads
	if len(threads) != 1 || len(threads[0].Messages) != 2 || threads[0].Messages[1].Author != "Sammy" || !threads[0].Messages[1].Agent {
		t.Fatalf("unexpected Slack transcript: %+v", threads)
	}
}
