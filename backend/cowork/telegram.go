package cowork

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type telegramMessage struct {
	ChatID, Topic, Title, MessageID, SenderID, Author, Text string
	WorkspaceID, Agent, Version                             string
	At                                                      time.Time
	Reply                                                   bool
}

func telegramDestination(value string) bool {
	id, err := strconv.ParseInt(value, 10, 64)
	return err == nil && id < 0 && strconv.FormatInt(id, 10) == value
}

func recordTelegramMessage(space *Workspace, input telegramMessage) (*Thread, bool) {
	if input.Agent != "" {
		input.Topic = input.Agent + ":" + input.Topic
	}
	var thread *Thread
	for i := range space.Threads {
		if space.Threads[i].TelegramTopic == input.Topic {
			if _, active := space.agent(space.Threads[i].AgentID); active {
				thread = &space.Threads[i]
				break
			}
		}
	}
	if thread == nil {
		title := "Telegram · " + strings.TrimSpace(input.Title)
		if input.Title == "" {
			title = "Telegram group"
		}
		if agent := namedChannelAgents[input.Agent].Name; agent != "" {
			title = agent + " · " + title
		}
		space.Threads = append(space.Threads, Thread{
			ID: key(), Title: title, Author: input.Author, CreatedAt: input.At, TelegramTopic: input.Topic,
		})
		thread = &space.Threads[len(space.Threads)-1]
	}
	for _, message := range thread.Messages {
		if message.TelegramMessage == input.MessageID {
			return thread, false
		}
	}
	thread.Messages = append(thread.Messages, Message{
		Author: input.Author, Text: input.Text, At: input.At,
		SenderID: "telegram:" + input.SenderID, TelegramMessage: input.MessageID,
	})
	return thread, true
}

func receiveTelegramMessage(w http.ResponseWriter, r *http.Request) {
	var input telegramMessage
	if !decode(w, r, &input) {
		return
	}
	input.Text = strings.TrimSpace(input.Text)
	if !telegramDestination(input.ChatID) || input.Topic == "" || input.MessageID == "" || input.SenderID == "" || input.At.IsZero() || input.Text == "" {
		fail(w, 400, "Invalid Telegram message.")
		return
	}
	mutex.Lock()
	defer mutex.Unlock()
	d, err := load()
	if err != nil {
		fail(w, 500, "Could not load workspace.")
		return
	}
	space := d.Workspaces[input.WorkspaceID]
	if space == nil || !telegramInstallationMatches(d, space, input.Agent, input.Version, input.ChatID) {
		jsonReply(w, 200, map[string]string{})
		return
	}
	thread, added := recordTelegramMessage(space, input)
	if !added {
		jsonReply(w, 200, map[string]string{})
		return
	}
	role := channelAgentRole(space, input.Agent)
	agentName := role + " agent"
	if input.Agent != "" {
		agentName = namedChannelAgents[input.Agent].Name
	}
	for _, agent := range space.Agents {
		if agent.Role == role && agent.ID != "" {
			agentName = agent.Name
			thread.AgentID = agent.ID
			break
		}
	}
	if save(d) != nil {
		fail(w, 500, "Could not save Telegram message.")
		return
	}
	if !input.Reply {
		jsonReply(w, 200, map[string]string{})
		return
	}
	turn := workerRequest{
		Role: role, AgentName: agentName, WorkspaceID: space.ID, ThreadID: thread.ID, TimeZone: "UTC",
		ChannelActor: &channelActor{
			WorkspaceID: space.ID, Channel: "telegram", Agent: input.Agent, Installation: input.Version,
			Conversation: input.ChatID, ThreadID: thread.ID, SenderID: input.SenderID, Author: input.Author,
		},
		Messages: thread.Messages[max(0, len(thread.Messages)-24):],
	}
	mutex.Unlock()
	result, err := worker(r.Context(), "chat", turn, "")
	mutex.Lock()
	if err != nil {
		fail(w, 502, "Message saved. The agent service was unavailable.")
		return
	}
	latest, err := load()
	if err != nil {
		fail(w, 500, "Could not reload workspace.")
		return
	}
	space = latest.Workspaces[input.WorkspaceID]
	if space == nil || !telegramInstallationMatches(latest, space, input.Agent, input.Version, input.ChatID) {
		jsonReply(w, 200, map[string]string{})
		return
	}
	messages := threadMessages(space, turn.ThreadID)
	if messages == nil {
		fail(w, 404, "Conversation not found.")
		return
	}
	*messages = append(*messages, Message{Author: turn.AgentName, Text: result.Reply, At: time.Now(), Agent: true})
	if save(latest) != nil {
		fail(w, 500, "Could not save Telegram reply.")
		return
	}
	jsonReply(w, 200, map[string]string{"reply": result.Reply})
}

func telegramThread(space *Workspace, id string) bool {
	for _, thread := range space.Threads {
		if thread.ID == id {
			return thread.TelegramTopic != ""
		}
	}
	return false
}

type telegramBot struct {
	ID                                             int64
	Username, Version, EncryptedToken, Destination string
}

func telegramBotKey(workspace, agent string) string {
	if agent == "" {
		return workspace
	}
	return workspace + ":" + agent
}

func telegramInstallationMatches(d *database, space *Workspace, agent, version, destination string) bool {
	if (agent != "" && namedChannelAgents[agent].Name == "") || version == "" || space.channelAgentRemoved(agent) {
		return false
	}
	bot := d.TelegramBots[telegramBotKey(space.ID, agent)]
	group := bot.Destination
	if agent == "" {
		group = space.Channels["Telegram"]
	}
	return bot.Version == version && group == destination
}

func telegramAgentSettings(d *database, workspace string) map[string]struct{ Username, Destination string } {
	result := make(map[string]struct{ Username, Destination string })
	for agent := range namedChannelAgents {
		bot := d.TelegramBots[telegramBotKey(workspace, agent)]
		if bot.Username != "" {
			result[agent] = struct{ Username, Destination string }{bot.Username, bot.Destination}
		}
	}
	return result
}

var telegramTokenPattern = regexp.MustCompile(`^[0-9]{1,20}:[A-Za-z0-9_-]{20,100}$`)

func updateTelegramBot(w http.ResponseWriter, r *http.Request, d *database, account Account, space *Workspace) {
	if account.ID != space.Owner {
		fail(w, 403, "Workspace owner access required.")
		return
	}
	var input struct {
		Token, Destination, Agent string
		Remove                    bool
	}
	if !decode(w, r, &input) {
		return
	}
	if input.Agent != "" && namedChannelAgents[input.Agent].Name == "" {
		fail(w, 400, "Unknown Telegram agent.")
		return
	}
	if !input.Remove && space.channelAgentRemoved(input.Agent) {
		fail(w, http.StatusConflict, "Add this agent to the workspace before connecting Telegram.")
		return
	}
	botKey := telegramBotKey(space.ID, input.Agent)
	if space.Channels == nil {
		space.Channels = make(map[string]string)
	}
	if input.Remove {
		delete(d.TelegramBots, botKey)
		if input.Agent == "" {
			delete(space.Channels, "Telegram")
		}
	} else {
		input.Destination = strings.TrimSpace(input.Destination)
		if !telegramDestination(input.Destination) {
			fail(w, 400, "Enter a numeric Telegram group ID, including its minus sign.")
			return
		}
		bot := d.TelegramBots[botKey]
		token := strings.TrimSpace(input.Token)
		if token != "" {
			if !telegramTokenPattern.MatchString(token) {
				fail(w, 400, "Enter the token issued by BotFather.")
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			request, err := http.NewRequestWithContext(ctx, "GET", "https://api.telegram.org/bot"+token+"/getMe", nil)
			if err != nil {
				fail(w, 400, "Invalid Telegram bot token.")
				return
			}
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				fail(w, 502, "Could not reach Telegram to check the bot token.")
				return
			}
			defer response.Body.Close()
			var identity struct {
				OK     bool
				Result struct {
					ID       int64
					Username string
					IsBot    bool `json:"is_bot"`
				}
			}
			if json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(&identity) != nil ||
				!identity.OK || !identity.Result.IsBot || identity.Result.ID == 0 || identity.Result.Username == "" {
				fail(w, 400, "Telegram could not verify this bot token.")
				return
			}
			for id, existing := range d.TelegramBots {
				if id != botKey && existing.ID == identity.Result.ID {
					fail(w, 409, "This Telegram bot is already connected to an agent or workspace.")
					return
				}
			}
			aead, err := agentConnectionCipher(len(d.TelegramBots) == 0 && len(d.AgentConnectionKeys) == 0 && len(d.GitTokens) == 0)
			if err != nil {
				fail(w, 500, "Could not encrypt the Telegram token.")
				return
			}
			bot = telegramBot{
				ID: identity.Result.ID, Username: identity.Result.Username, Version: key(),
				EncryptedToken: sealAgentConnectionKey(aead, "telegram:"+botKey, token),
			}
		}
		if bot.EncryptedToken == "" {
			fail(w, 400, "Enter the token issued by BotFather.")
			return
		}
		if d.TelegramBots == nil {
			d.TelegramBots = make(map[string]telegramBot)
		}
		if input.Agent == "" {
			space.Channels["Telegram"] = input.Destination
		} else {
			bot.Destination = input.Destination
		}
		d.TelegramBots[botKey] = bot
	}
	if save(d) != nil {
		fail(w, 500, "Could not save Telegram settings.")
		return
	}
	view(w, d, account)
}

//encore:api public raw method=GET,POST path=/internal/telegram/*route
func TelegramBridge(w http.ResponseWriter, r *http.Request) {
	secret := strings.TrimSpace(os.Getenv("COWORK_TELEGRAM_BRIDGE_SECRET"))
	if secret == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+secret)) != 1 {
		fail(w, 403, "Telegram bridge access required.")
		return
	}
	switch {
	case r.Method == "POST" && r.URL.Path == "/internal/telegram/message":
		receiveTelegramMessage(w, r)
	case r.Method == "GET" && r.URL.Path == "/internal/telegram/installations":
		listTelegramInstallations(w)
	default:
		fail(w, 404, "Unknown Telegram endpoint.")
	}
}

func listTelegramInstallations(w http.ResponseWriter) {
	mutex.Lock()
	defer mutex.Unlock()
	d, err := load()
	if err != nil {
		fail(w, 500, "Could not load Telegram settings.")
		return
	}
	type installation struct{ WorkspaceID, Agent, Version, Token string }
	result := []installation{}
	if len(d.TelegramBots) > 0 {
		aead, err := agentConnectionCipher(false)
		if err != nil {
			fail(w, 500, "Could not unlock Telegram tokens.")
			return
		}
		for id, bot := range d.TelegramBots {
			token, err := openAgentConnectionKey(aead, "telegram:"+id, bot.EncryptedToken)
			if err != nil {
				fail(w, 500, "Could not unlock Telegram token.")
				return
			}
			workspace, agent, _ := strings.Cut(id, ":")
			result = append(result, installation{workspace, agent, bot.Version, token})
		}
	}
	jsonReply(w, 200, result)
}
