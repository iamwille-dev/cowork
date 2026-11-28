package cowork

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestTelegramConnectRegistersAgentWebhookAndLinksOneGroup(t *testing.T) {
	useTestPostgres(t)
	t.Setenv("COWORK_TELEGRAM_BRIDGE_SECRET", "telegram-bridge")
	t.Setenv("MASTRA_SERVER_URL", "")
	t.Setenv("COWORK_PUBLIC_URL", "https://cowork.example")
	const botToken = "123:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	var registeredWebhook, registeredSecret string
	previous := http.DefaultClient
	t.Cleanup(func() { http.DefaultClient = previous })
	http.DefaultClient = &http.Client{Transport: scheduledWorkerTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "api.telegram.org" || !strings.HasPrefix(r.URL.Path, "/bot"+botToken+"/") {
			t.Fatal("unexpected Telegram Bot API request")
		}
		var result any
		switch strings.TrimPrefix(r.URL.Path, "/bot"+botToken+"/") {
		case "getMe":
			result = map[string]any{"id": 123, "username": "project_cowork_bot", "is_bot": true, "can_join_groups": true}
		case "getWebhookInfo":
			result = map[string]string{"url": registeredWebhook}
		case "setWebhook":
			var input struct {
				URL    string
				Secret string `json:"secret_token"`
			}
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Fatal(err)
			}
			registeredWebhook, registeredSecret = input.URL, input.Secret
			result = true
		case "deleteWebhook":
			registeredWebhook = ""
			result = true
		default:
			t.Fatal("unexpected Telegram Bot API method")
		}
		body, err := json.Marshal(map[string]any{"ok": true, "result": result})
		if err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
	})}

	const binding = "agent:product-manager"
	workspaceID := strings.Repeat("a", 48)
	space := &Workspace{ID: workspaceID, Role: "Developer", Owner: "owner",
		Agents: []workspaceAgent{{ID: "developer", Role: "Developer", Name: "Dev"},
			{ID: "product-manager", Role: "Product Manager", Name: "Anna", ConnectionIDs: []string{"mail"}}}}
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	d.Workspaces[workspaceID] = space
	write := func(data map[string]string, accountID string, want int) string {
		t.Helper()
		body, _ := json.Marshal(data)
		w := httptest.NewRecorder()
		updateTelegramBot(w, httptest.NewRequest(http.MethodPost, "/api/telegram", strings.NewReader(string(body))),
			d, Account{ID: accountID, Workspace: workspaceID}, space)
		if w.Code != want {
			t.Fatalf("Telegram setup returned %d, want %d: %s", w.Code, want, w.Body)
		}
		return w.Body.String()
	}
	connect := map[string]string{"Agent": binding, "Action": "connect", "Token": botToken}
	write(connect, "member", http.StatusForbidden)
	registeredWebhook = "https://another-service.example/bot"
	write(connect, "owner", http.StatusConflict)
	if registeredWebhook != "https://another-service.example/bot" {
		t.Fatal("Cowork replaced a webhook owned by another service")
	}
	registeredWebhook = ""
	body := write(connect, "owner", http.StatusOK)
	key := telegramBotKey(workspaceID, binding)
	bot := d.TelegramBots[key]
	if bot.Version == "" || bot.LinkCode == "" || !bot.LinkUntil.After(time.Now()) ||
		registeredWebhook != "https://cowork.example/api/agents/product-manager/channels/telegram/webhook?installation="+bot.Version ||
		registeredSecret != telegramWebhookSecret(bot.Version, "telegram-bridge") {
		t.Fatal("registered webhook or group link did not match the existing agent")
	}
	if strings.Contains(body, botToken) || strings.Contains(body, registeredSecret) || !strings.Contains(body, "startgroup="+bot.LinkCode) ||
		strings.Contains(bot.EncryptedToken, botToken) {
		t.Fatal("only the owner’s group link should be exposed in setup")
	}
	member := httptest.NewRecorder()
	viewTelegramConnection(member, d, Account{ID: "member"}, space, binding)
	if strings.Contains(member.Body.String(), bot.LinkCode) {
		t.Fatal("member was shown the group link")
	}
	if telegramInstallationMatches(d, space, binding, bot.Version, "-100123") {
		t.Fatal("the bot accepted a group before setup completed")
	}

	request := httptest.NewRequest(http.MethodGet, "/internal/telegram/installation?"+url.Values{"version": {bot.Version}}.Encode(), nil)
	request.Header.Set("Authorization", "Bearer telegram-bridge")
	response := httptest.NewRecorder()
	TelegramBridge(response, request)
	var installation telegramInstallation
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &installation) != nil ||
		installation.Agent != binding || installation.Role != "Product Manager" || installation.Token != botToken {
		t.Fatal("registered channel did not resolve the selected agent")
	}

	link := func(code, group string, expected bool) {
		t.Helper()
		data, _ := json.Marshal(map[string]string{"WorkspaceID": workspaceID, "Agent": binding, "Version": bot.Version,
			"Code": code, "ChatID": group, "Title": "Planning group"})
		request := httptest.NewRequest(http.MethodPost, "/internal/telegram/link", strings.NewReader(string(data)))
		request.Header.Set("Authorization", "Bearer telegram-bridge")
		response := httptest.NewRecorder()
		TelegramBridge(response, request)
		var result struct{ Linked bool }
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Linked != expected {
			t.Fatalf("unexpected group link response: %d %s", response.Code, response.Body)
		}
	}
	link(strings.Repeat("b", 48), "-100123", false)
	link(bot.LinkCode, "-100123", true)
	link(bot.LinkCode, "-100456", false)
	d, err = load()
	if err != nil {
		t.Fatal(err)
	}
	space = d.Workspaces[workspaceID]
	bound := d.TelegramBots[key]
	if bound.GroupTitle != "Planning group" || bound.LinkCode != "" ||
		!telegramInstallationMatches(d, space, binding, bot.Version, "-100123") ||
		telegramInstallationMatches(d, space, binding, bot.Version, "-100456") {
		t.Fatal("the verified group binding did not stay scoped to the chosen chat")
	}
	agentID := "product-manager"
	actor := channelActor{WorkspaceID: workspaceID, Channel: "telegram", Agent: binding, AgentInstance: &agentID,
		Installation: bot.Version, Conversation: "-100123", SenderID: "telegram-member"}
	actorJSON, _ := json.Marshal(actor)
	toolRequest := httptest.NewRequest(http.MethodPost, "/internal/channel-tools/context", strings.NewReader(string(actorJSON)))
	toolRequest.Header.Set("Authorization", "Bearer telegram-bridge")
	toolResponse := httptest.NewRecorder()
	ChannelToolBridge(toolResponse, toolRequest)
	var toolContext workerRequest
	if toolResponse.Code != 200 || json.Unmarshal(toolResponse.Body.Bytes(), &toolContext) != nil ||
		toolContext.AgentName != "Anna" || toolContext.AgentConnectionIDs == nil ||
		len(*toolContext.AgentConnectionIDs) != 1 || (*toolContext.AgentConnectionIDs)[0] != "mail" {
		t.Fatal("Telegram did not inherit the connected Cowork agent’s tools")
	}
	write(map[string]string{"Agent": binding, "Action": "disconnect"}, "owner", http.StatusOK)
	if registeredWebhook != "" || d.TelegramBots[key].Version != "" {
		t.Fatal("disconnect did not remove the Cowork webhook and installation")
	}
}
