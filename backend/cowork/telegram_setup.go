package cowork

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

var telegramUsername = regexp.MustCompile(`^[A-Za-z0-9_]{5,32}$`)

func telegramWebhookURL(role, version string) string {
	publicURL := strings.TrimSpace(os.Getenv("MASTRA_SERVER_URL"))
	if publicURL == "" {
		publicURL = strings.TrimSpace(os.Getenv("COWORK_PUBLIC_URL"))
	}
	base, err := url.Parse(publicURL)
	if err != nil || base.Scheme != "https" || base.Hostname() == "" || base.User != nil {
		return ""
	}
	agent := strings.ReplaceAll(strings.ToLower(role), " ", "-")
	return "https://" + base.Host + "/api/agents/" + agent + "/channels/telegram/webhook?installation=" + version
}

func telegramWebhookSecret(version, bridgeSecret string) string {
	digest := hmac.New(sha256.New, []byte(bridgeSecret))
	digest.Write([]byte("cowork-telegram-webhook\x00" + version))
	return hex.EncodeToString(digest.Sum(nil))
}

func telegramBotAPI(ctx context.Context, token, method string, payload any, result any) error {
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.telegram.org/bot"+token+"/"+method, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	var envelope struct {
		OK     bool
		Result json.RawMessage
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(&envelope) != nil || !envelope.OK {
		return errors.New("Telegram rejected the request")
	}
	return json.Unmarshal(envelope.Result, result)
}

func telegramCurrentWebhook(ctx context.Context, token string) (string, error) {
	var info struct{ URL string }
	err := telegramBotAPI(ctx, token, "getWebhookInfo", struct{}{}, &info)
	return info.URL, err
}

func removeTelegramWebhook(ctx context.Context, token, expected string) {
	if expected == "" {
		return
	}
	if current, err := telegramCurrentWebhook(ctx, token); err == nil && current == expected {
		var deleted bool
		_ = telegramBotAPI(ctx, token, "deleteWebhook", struct{}{}, &deleted)
	}
}

func removeStoredTelegramWebhook(ctx context.Context, id string, bot telegramBot) {
	if bot.WebhookURL == "" {
		return
	}
	if token, err := openTelegramToken(id, bot); err == nil {
		removeTelegramWebhook(ctx, token, bot.WebhookURL)
	}
}

func saveTelegramSettings(w http.ResponseWriter, d *database, message string) bool {
	if err := save(d); err != nil {
		if errors.Is(err, errStaleWorkspace) {
			fail(w, http.StatusConflict, "The workspace changed. Try again.")
		} else {
			fail(w, http.StatusInternalServerError, message)
		}
		return false
	}
	return true
}

func viewTelegramConnection(w http.ResponseWriter, d *database, account Account, space *Workspace, binding string) {
	if _, active := telegramAgent(space, binding); !active {
		fail(w, 404, "This Cowork agent is unavailable.")
		return
	}
	bot := d.TelegramBots[telegramBotKey(space.ID, binding)]
	connected := bot.Username != "" && telegramGroup(space, binding, bot) != ""
	link := ""
	if account.ID == space.Owner && !connected && bot.LinkCode != "" && bot.LinkUntil.After(time.Now()) {
		link = "https://t.me/" + bot.Username + "?startgroup=" + bot.LinkCode
	}
	w.Header().Set("Cache-Control", "no-store")
	jsonReply(w, 200, map[string]any{
		"configured": channelBridgeSecret("telegram") != "", "connected": connected,
		"username": bot.Username, "groupTitle": bot.GroupTitle, "groupLink": link,
	})
}

func manageTelegramConnection(w http.ResponseWriter, r *http.Request, d *database, account Account, space *Workspace, binding, action, token string) {
	agent, active := telegramAgent(space, binding)
	if !active {
		fail(w, 404, "This Cowork agent is unavailable.")
		return
	}
	id := telegramBotKey(space.ID, binding)
	bot := d.TelegramBots[id]
	if action == "disconnect" {
		delete(d.TelegramBots, id)
		if binding == "" {
			delete(space.Channels, "Telegram")
		}
		if !saveTelegramSettings(w, d, "Could not disconnect this Telegram bot.") {
			return
		}
		removeStoredTelegramWebhook(r.Context(), id, bot)
		viewTelegramConnection(w, d, account, space, binding)
		return
	}
	if !strings.HasPrefix(binding, "agent:") {
		fail(w, 400, "Choose an agent in your Cowork workspace.")
		return
	}
	secret := channelBridgeSecret("telegram")
	if secret == "" {
		fail(w, 503, "Telegram setup is unavailable on this Cowork server.")
		return
	}
	switch action {
	case "connect":
		if bot.Username != "" {
			viewTelegramConnection(w, d, account, space, binding)
			return
		}
		var ok bool
		bot, ok = provisionTelegramBot(w, r.Context(), d, id, agent.Role, secret, token)
		if !ok {
			return
		}
	case "link":
		if bot.Username == "" || bot.Destination != "" {
			fail(w, 409, "Connect a bot before getting a Telegram group link.")
			return
		}
	default:
		fail(w, 400, "Unknown Telegram setup action.")
		return
	}
	bot.LinkCode, bot.LinkUntil = key(), time.Now().Add(15*time.Minute)
	if d.TelegramBots == nil {
		d.TelegramBots = make(map[string]telegramBot)
	}
	d.TelegramBots[id] = bot
	if !saveTelegramSettings(w, d, "Could not save the Telegram connection.") {
		if action == "connect" {
			removeTelegramWebhook(r.Context(), token, bot.WebhookURL)
		}
		return
	}
	viewTelegramConnection(w, d, account, space, binding)
}

func provisionTelegramBot(w http.ResponseWriter, ctx context.Context, d *database, id, role, secret, token string) (telegramBot, bool) {
	var identity struct {
		ID       int64
		Username string
		IsBot    bool  `json:"is_bot"`
		CanJoin  *bool `json:"can_join_groups"`
	}
	if !telegramTokenPattern.MatchString(token) || telegramBotAPI(ctx, token, "getMe", struct{}{}, &identity) != nil ||
		!identity.IsBot || identity.ID == 0 || !telegramUsername.MatchString(identity.Username) {
		fail(w, 400, "Telegram could not verify this BotFather token.")
		return telegramBot{}, false
	}
	if identity.CanJoin != nil && !*identity.CanJoin {
		fail(w, 400, "Allow this bot to join groups in BotFather, then try again.")
		return telegramBot{}, false
	}
	for _, existing := range d.TelegramBots {
		if existing.ID == identity.ID {
			fail(w, 409, "This Telegram bot is already connected to an agent or workspace.")
			return telegramBot{}, false
		}
	}
	current, err := telegramCurrentWebhook(ctx, token)
	if err != nil {
		fail(w, 502, "Could not check the bot’s current Telegram webhook. Try again.")
		return telegramBot{}, false
	}
	if current != "" {
		fail(w, 409, "This bot already has a webhook. Use a dedicated bot for Cowork.")
		return telegramBot{}, false
	}
	aead, err := agentConnectionCipher(len(d.TelegramBots) == 0 && len(d.AgentConnectionKeys) == 0 && len(d.GitTokens) == 0)
	if err != nil {
		fail(w, 500, "Could not encrypt the Telegram token.")
		return telegramBot{}, false
	}
	bot := telegramBot{ID: identity.ID, Username: identity.Username, Version: key(), EncryptedToken: sealAgentConnectionKey(aead, "telegram:"+id, token)}
	bot.WebhookURL = telegramWebhookURL(role, bot.Version)
	if bot.WebhookURL != "" {
		var registered bool
		err := telegramBotAPI(ctx, token, "setWebhook", map[string]any{
			"url": bot.WebhookURL, "secret_token": telegramWebhookSecret(bot.Version, secret), "allowed_updates": []string{"message"},
		}, &registered)
		if err != nil || !registered {
			if current, err := telegramCurrentWebhook(ctx, token); err != nil || current != bot.WebhookURL {
				fail(w, 502, "Telegram could not register the Cowork webhook. Try again.")
				return telegramBot{}, false
			}
		}
	}
	return bot, true
}

type telegramInstallation struct{ WorkspaceID, Agent, Role, Version, Token, Username string }

func openTelegramToken(id string, bot telegramBot) (string, error) {
	aead, err := agentConnectionCipher(false)
	if err != nil {
		return "", err
	}
	return openAgentConnectionKey(aead, "telegram:"+id, bot.EncryptedToken)
}

func resolveTelegramInstallation(d *database, id string, bot telegramBot) (telegramInstallation, bool, error) {
	workspace, binding, _ := strings.Cut(id, ":")
	space := d.Workspaces[workspace]
	if space == nil || bot.EncryptedToken == "" {
		return telegramInstallation{}, false, nil
	}
	agent, active := telegramAgent(space, binding)
	if !active || !roles[agent.Role] {
		return telegramInstallation{}, false, nil
	}
	token, err := openTelegramToken(id, bot)
	return telegramInstallation{workspace, binding, agent.Role, bot.Version, token, bot.Username}, true, err
}

func telegramWebhookInstallation(w http.ResponseWriter, version string) {
	mutex.Lock()
	defer mutex.Unlock()
	d, err := load()
	if err != nil {
		fail(w, 500, "Could not load Telegram settings.")
		return
	}
	for id, bot := range d.TelegramBots {
		if bot.Version != version || bot.WebhookURL == "" {
			continue
		}
		installation, valid, err := resolveTelegramInstallation(d, id, bot)
		if err != nil {
			fail(w, 500, "Could not unlock the Telegram token.")
			return
		}
		if valid {
			jsonReply(w, 200, installation)
			return
		}
		break
	}
	fail(w, 404, "Telegram installation unavailable.")
}

func linkTelegramGroup(w http.ResponseWriter, r *http.Request) {
	var input struct{ WorkspaceID, Agent, Version, Code, ChatID, Title string }
	if !decode(w, r, &input) {
		return
	}
	if !telegramDestination(input.ChatID) || !channelWorkspaceID.MatchString(input.Code) {
		jsonReply(w, 200, map[string]bool{"linked": false})
		return
	}
	mutex.Lock()
	defer mutex.Unlock()
	d, err := load()
	if err != nil {
		fail(w, 500, "Could not load Telegram settings.")
		return
	}
	id := telegramBotKey(input.WorkspaceID, input.Agent)
	bot := d.TelegramBots[id]
	space := d.Workspaces[input.WorkspaceID]
	if space != nil && bot.Version == input.Version && bot.Destination == "" && bot.LinkUntil.After(time.Now()) &&
		hmac.Equal([]byte(bot.LinkCode), []byte(input.Code)) {
		if _, active := telegramAgent(space, input.Agent); active {
			groupTitle := []rune(strings.TrimSpace(input.Title))
			bot.Destination, bot.GroupTitle = input.ChatID, string(groupTitle[:min(len(groupTitle), 255)])
			bot.LinkCode, bot.LinkUntil = "", time.Time{}
			d.TelegramBots[id] = bot
			if saveTelegramSettings(w, d, "Could not link this Telegram group.") {
				jsonReply(w, 200, map[string]bool{"linked": true})
			}
			return
		}
	}
	jsonReply(w, 200, map[string]bool{"linked": false})
}
