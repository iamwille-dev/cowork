package cowork

import (
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
	first, second := strings.Repeat("a", 48), strings.Repeat("b", 48)
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	d.Workspaces[first] = &Workspace{ID: first, Owner: "owner", Role: "Developer",
		Channels: map[string]string{"Telegram": "-1001"}}
	d.Workspaces[second] = &Workspace{ID: second, Role: "Developer",
		Channels: map[string]string{"Telegram": "-1002"}}
	d.TelegramBots = map[string]telegramBot{first: {Version: "first-bot"}, second: {Version: "second-bot"}}
	d.Accounts["owner@example.net"] = Account{ID: "owner", Workspace: first}
	d.Accounts["member@example.net"] = Account{ID: "member", Workspace: first}
	d.Sessions["owner-session"] = "owner@example.net"
	d.Sessions["member-session"] = "member@example.net"
	if err := save(d); err != nil {
		t.Fatal(err)
	}
	configure := func(session string, want int) {
		t.Helper()
		request := httptest.NewRequest("POST", "/api/channel-tools", strings.NewReader(`{"Tasks":true,"Repositories":true}`))
		request.Header.Set("Content-Type", "application/json")
		request.AddCookie(&http.Cookie{Name: "cowork_session", Value: session})
		recorder := httptest.NewRecorder()
		API(recorder, request)
		if recorder.Code != want {
			t.Fatalf("settings: got %d, want %d: %s", recorder.Code, want, recorder.Body)
		}
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
		if payload.WorkspaceID != first || payload.Task.ThreadID != "" {
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

	call(telegram, "task", channelBridgeSecret("telegram"), 403)
	configure("member-session", 403)
	configure("owner-session", 200)
	call(slack, "task", channelBridgeSecret("telegram"), 403)
	stale := telegram
	stale.WorkspaceID = second
	call(stale, "context", channelBridgeSecret("telegram"), 403)
	call(telegram, "context", channelBridgeSecret("telegram"), 200)
	call(telegram, "task", channelBridgeSecret("telegram"), 200)
	call(slack, "task", channelBridgeSecret("slack"), 200)
	slack.WorkspaceID = second
	call(slack, "task", channelBridgeSecret("slack"), 403)

	latest, err := load()
	if err != nil {
		t.Fatal(err)
	}
	tasks := latest.Workspaces[first].Tasks
	if calls != 2 || len(tasks) != 2 || len(latest.Workspaces[second].Tasks) != 0 ||
		tasks[0].Author != "Alice (telegram)" || tasks[1].Author != "Bob (slack)" ||
		tasks[0].Status != "Ready for review" || tasks[1].Status != "Ready for review" {
		t.Fatalf("unexpected channel task records: %+v", tasks)
	}
}
