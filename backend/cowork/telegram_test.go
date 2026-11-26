package cowork

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTelegramMessagesAppearInWorkspace(t *testing.T) {
	useTestPostgres(t)
	t.Setenv("COWORK_TELEGRAM_BRIDGE_SECRET", "test-bridge-secret")
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	d.Accounts["owner@example.com"] = Account{ID: "owner", Workspace: "space"}
	d.Sessions["session"] = "owner@example.com"
	d.Workspaces["space"] = &Workspace{ID: "space", Owner: "owner", Channels: map[string]string{"Telegram": "-100123"}}
	d.Workspaces["other"] = &Workspace{ID: "other", Channels: map[string]string{"Telegram": "-100123"}}
	d.TelegramBots = map[string]telegramBot{"space": {Version: "current"}, "other": {Version: "other"}}
	if err := save(d); err != nil {
		t.Fatal(err)
	}

	send := func(input telegramMessage, secret string, want int) {
		t.Helper()
		body, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest("POST", "/internal/telegram/message", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+secret)
		recorder := httptest.NewRecorder()
		TelegramBridge(recorder, request)
		if recorder.Code != want {
			t.Fatalf("Telegram status = %d, want %d: %s", recorder.Code, want, recorder.Body)
		}
	}

	first := telegramMessage{WorkspaceID: "space", Version: "current", ChatID: "-100123", Topic: "telegram:-100123", Title: "Test group", MessageID: "1",
		SenderID: "123", Author: "Alice", Text: "The deadline is Friday.", At: time.Now().UTC()}
	second := first
	second.MessageID, second.SenderID, second.Author, second.Text = "2", "456", "Bob", "I can review."
	unlinked := first
	unlinked.ChatID, unlinked.Topic = "-100456", "telegram:-100456"
	forum := second
	forum.Topic = "telegram:-100123:5"
	stale := first
	stale.Version = "old"
	wrongWorkspace := first
	wrongWorkspace.WorkspaceID = "other"
	send(first, "wrong-secret", 403)
	send(stale, "test-bridge-secret", 200)
	send(wrongWorkspace, "test-bridge-secret", 200)
	send(unlinked, "test-bridge-secret", 200)
	send(first, "test-bridge-secret", 200)
	send(second, "test-bridge-secret", 200)
	send(second, "test-bridge-secret", 200)
	send(forum, "test-bridge-secret", 200)

	request := httptest.NewRequest("GET", "/api/workspace", nil)
	request.AddCookie(&http.Cookie{Name: "cowork_session", Value: "session"})
	recorder := httptest.NewRecorder()
	API(recorder, request)
	var view struct{ Workspace Workspace }
	if err := json.Unmarshal(recorder.Body.Bytes(), &view); recorder.Code != 200 || err != nil {
		t.Fatalf("could not read workspace: status %d, error %v", recorder.Code, err)
	}
	threads := view.Workspace.Threads
	if len(threads) != 2 || len(threads[0].Messages) != 2 || len(threads[1].Messages) != 1 {
		t.Fatalf("expected two participants in the group and one in the forum topic, got %+v", threads)
	}
	if threads[0].Messages[0].SenderID != "telegram:123" || threads[0].Messages[1].SenderID != "telegram:456" {
		t.Fatalf("participant attribution was lost: %+v", threads[0].Messages)
	}
	d, err = load()
	if err != nil || len(d.Workspaces["other"].Threads) != 0 {
		t.Fatalf("configured Telegram group must be scoped to one workspace: %v", err)
	}
}

func TestTelegramBotSettingsAreOwnerManaged(t *testing.T) {
	useTestPostgres(t)
	previous := http.DefaultClient
	t.Cleanup(func() { http.DefaultClient = previous })
	http.DefaultClient = &http.Client{Transport: scheduledWorkerTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "api.telegram.org" || !strings.HasSuffix(r.URL.Path, "/getMe") {
			t.Fatalf("unexpected bot verification request")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(
			`{"ok":true,"result":{"id":123,"username":"workspace_test_bot","is_bot":true}}`,
		))}, nil
	})}
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	space := &Workspace{ID: "space", Owner: "owner"}
	other := &Workspace{ID: "other", Owner: "other-owner"}
	d.Workspaces[space.ID], d.Workspaces[other.ID] = space, other
	const token = "123:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	update := func(space *Workspace, account string, jsonBody string, want int) string {
		t.Helper()
		reply := httptest.NewRecorder()
		updateTelegramBot(reply, httptest.NewRequest("POST", "/api/telegram", strings.NewReader(jsonBody)),
			d, Account{ID: account, Workspace: space.ID}, space)
		if reply.Code != want {
			t.Fatalf("unexpected settings status %d, want %d: %s", reply.Code, want, reply.Body)
		}
		return reply.Body.String()
	}
	payload := `{"Token":"` + token + `","Destination":"-100123"}`
	update(space, "member", payload, 403)
	body := update(space, "owner", payload, 200)
	if strings.Contains(body, token) || !strings.Contains(body, "workspace_test_bot") {
		t.Fatal("settings should expose only the bot username")
	}
	bot := d.TelegramBots[space.ID]
	aead, err := agentConnectionCipher(false)
	if err != nil {
		t.Fatal(err)
	}
	credential, err := openAgentConnectionKey(aead, "telegram:"+space.ID, bot.EncryptedToken)
	if err != nil || credential != token || strings.Contains(bot.EncryptedToken, token) {
		t.Fatal("the saved bot token should be encrypted and scoped to its workspace")
	}
	update(other, "other-owner", payload, 409)
	update(space, "owner", `{"Destination":"-100456"}`, 200)
	if d.TelegramBots[space.ID].Version != bot.Version || space.Channels["Telegram"] != "-100456" {
		t.Fatal("changing the group should preserve the bot")
	}
	update(space, "owner", `{"Remove":true}`, 200)
	if d.TelegramBots[space.ID].Version != "" || space.Channels["Telegram"] != "" {
		t.Fatal("disconnect should remove the group and bot credential")
	}
}

func TestNamedTelegramAgentsCanShareAGroup(t *testing.T) {
	space := &Workspace{ID: "space", Role: "Product Manager"}
	d := &database{TelegramBots: map[string]telegramBot{
		telegramBotKey(space.ID, "ada"): {Version: "ada-version", Username: "AdaBot", Destination: "-1001"},
		telegramBotKey(space.ID, "sam"): {Version: "sam-version", Username: "SamBot", Destination: "-1001"},
	}}
	if !telegramInstallationMatches(d, space, "ada", "ada-version", "-1001") ||
		!telegramInstallationMatches(d, space, "sam", "sam-version", "-1001") ||
		telegramInstallationMatches(d, space, "sam", "ada-version", "-1001") {
		t.Fatal("Telegram routing must follow the installation for the tagged agent")
	}
	if channelAgentRole(space, "ada") != "Developer" || channelAgentRole(space, "sam") != "Sales Lead" {
		t.Fatal("Named roles must be independent of the workspace's original role")
	}
	settings := telegramAgentSettings(d, space.ID)
	if settings["ada"].Username != "AdaBot" || settings["sam"].Username != "SamBot" ||
		settings["ada"].Destination != "-1001" || settings["sam"].Destination != "-1001" {
		t.Fatal("Both Telegram handles should be shown in the same workspace")
	}
	input := telegramMessage{Agent: "ada", Topic: "telegram:-1001", Title: "Team", MessageID: "1", SenderID: "123", Text: "Hello Ada and Sam", At: time.Now()}
	first, ok := recordTelegramMessage(space, input)
	if !ok || first.Title != "Ada · Telegram · Team" {
		t.Fatal("Ada should have her own Telegram conversation")
	}
	input.Agent = "sam"
	second, ok := recordTelegramMessage(space, input)
	if !ok || second.Title != "Sam · Telegram · Team" || first.ID == second.ID {
		t.Fatal("Sam should have a separate Telegram conversation in the same group")
	}
	if _, duplicated := recordTelegramMessage(space, input); duplicated {
		t.Fatal("Retries must still be deduplicated per agent")
	}
}
