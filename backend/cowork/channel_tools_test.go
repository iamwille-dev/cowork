package cowork

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChannelToolsAreWorkspaceScoped(t *testing.T) {
	useTestPostgres(t)
	t.Setenv("COWORK_TELEGRAM_BRIDGE_SECRET", "telegram-test-secret")
	t.Setenv("MASTRA_ENCRYPTION_KEY", strings.Repeat("a", 48))
	t.Setenv("AGENT_CONNECTION_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	first, second := strings.Repeat("a", 48), strings.Repeat("b", 48)
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	d.Workspaces[first] = &Workspace{ID: first, Role: "Developer", AgentConnectionEnabled: true,
		Channels: map[string]string{"Telegram": "-1001"}}
	d.Workspaces[second] = &Workspace{ID: second, Role: "Developer",
		Channels: map[string]string{"Telegram": "-1002"}}
	d.TelegramBots = map[string]telegramBot{first: {Version: "first-bot"}, second: {Version: "second-bot"},
		first + ":ada": {Version: "ada-bot", Destination: "-1001"},
		first + ":sam": {Version: "sam-bot", Destination: "-1001"}}
	aead, err := agentConnectionCipher(false)
	if err != nil {
		t.Fatal(err)
	}
	d.AgentConnectionKeys = map[string]string{
		first:  sealAgentConnectionKey(aead, first, "first-connection"),
		second: sealAgentConnectionKey(aead, second, "disabled-connection"),
	}
	d.GitTokens = map[string]map[string]string{
		first:  {"github": sealAgentConnectionKey(aead, gitTokenScope(first, "github"), "first-token")},
		second: {"github": sealAgentConnectionKey(aead, gitTokenScope(second, "github"), "second-token")},
	}
	if err := save(d); err != nil {
		t.Fatal(err)
	}

	calls := 0
	previous := workerClient
	t.Cleanup(func() { workerClient = previous })
	workerClient = &http.Client{Transport: scheduledWorkerTransport(func(request *http.Request) (*http.Response, error) {
		calls++
		var payload workerRequest
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if payload.WorkspaceID != first || payload.Task.ThreadID != "" || payload.Role != "Developer" {
			t.Fatalf("task escaped linked workspace: %+v", payload)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"Steps":["Done"]}`))}, nil
	})}
	telegram := channelActor{WorkspaceID: first, Channel: "telegram", Installation: "first-bot", Conversation: "-1001", SenderID: "123", Author: "Alice"}
	slack := channelActor{WorkspaceID: first, Channel: "slack", Installation: "slack-install", SenderID: "U123", Author: "Bob"}
	call := func(actor channelActor, action, secret string, want int) *httptest.ResponseRecorder {
		t.Helper()
		data, err := json.Marshal(struct {
			channelActor
			Data json.RawMessage
		}{actor, json.RawMessage(`{"Title":"Test task","Brief":"Run integration checks","WorkspaceID":"other","ThreadID":"other"}`)})
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest("POST", "/internal/channel-tools/"+action, strings.NewReader(string(data)))
		request.Header.Set("Authorization", "Bearer "+secret)
		recorder := httptest.NewRecorder()
		ChannelToolBridge(recorder, request)
		if recorder.Code != want {
			t.Fatalf("%s %s: got %d, want %d: %s", actor.Channel, action, recorder.Code, want, recorder.Body)
		}
		return recorder
	}

	call(slack, "task", channelBridgeSecret("telegram"), 403)
	stale := telegram
	stale.WorkspaceID = second
	call(stale, "context", channelBridgeSecret("telegram"), 403)
	call(stale, "task", channelBridgeSecret("telegram"), 403)
	checkContext := func(actor channelActor, token, connection string) {
		t.Helper()
		recorder := call(actor, "context", channelBridgeSecret(actor.Channel), 200)
		var context workerRequest
		if err := json.Unmarshal(recorder.Body.Bytes(), &context); err != nil {
			t.Fatal(err)
		}
		if context.GitTokens["github"] != token || context.AgentConnectionKey != connection ||
			context.WorkspaceID != actor.WorkspaceID ||
			(connection != "" && context.AgentConnectionWorkspace != actor.WorkspaceID) ||
			(connection == "" && context.AgentConnectionWorkspace != "") {
			t.Fatal("channel context did not follow the linked workspace's settings")
		}
	}
	checkContext(telegram, "first-token", "first-connection")
	checkContext(slack, "first-token", "first-connection")
	other := slack
	other.WorkspaceID = second
	checkContext(other, "second-token", "")
	// Both agents can share the group, but an installation identifies exactly one role.
	telegram.Agent, telegram.Installation = "ada", "ada-bot"
	call(telegram, "task", channelBridgeSecret("telegram"), 200)
	telegram.Agent = "sam"
	call(telegram, "task", channelBridgeSecret("telegram"), 403)
	telegram.Installation = "sam-bot"
	call(telegram, "task", channelBridgeSecret("telegram"), 200)
	slack.Agent = "ada"
	call(slack, "task", channelBridgeSecret("slack"), 200)
	slack.Agent = "sam"
	call(slack, "task", channelBridgeSecret("slack"), 200)

	latest, err := load()
	if err != nil {
		t.Fatal(err)
	}
	tasks := latest.Workspaces[first].Tasks
	if calls != 2 || len(tasks) != 4 || len(latest.Workspaces[second].Tasks) != 0 ||
		tasks[0].Author != "Alice (telegram)" || tasks[2].Author != "Bob (slack)" ||
		tasks[0].Status != "Ready for review" || tasks[1].Status != "Assigned" ||
		tasks[2].Status != "Ready for review" || tasks[3].Status != "Assigned" {
		t.Fatalf("unexpected channel task records: %+v", tasks)
	}
}
