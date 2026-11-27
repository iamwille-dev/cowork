package cowork

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"strings"
)

type channelActor struct {
	WorkspaceID, Channel, Agent, Installation, Conversation, SenderID, Author string
}

var namedChannelAgents = map[string]struct{ Name, Role string }{
	"ada": {"Ada", "Developer"},
	"sam": {"Sam", "Sales Lead"},
}

func channelAgentRole(space *Workspace, agent string) string {
	if agent == "" {
		return space.Role
	}
	return namedChannelAgents[agent].Role
}

var channelWorkspaceID = regexp.MustCompile(`^[a-f0-9]{48}$`)

func channelBridgeSecret(channel string) string {
	switch channel {
	case "telegram":
		return strings.TrimSpace(os.Getenv("COWORK_TELEGRAM_BRIDGE_SECRET"))
	case "slack":
		key := strings.TrimSpace(os.Getenv("MASTRA_ENCRYPTION_KEY"))
		if len(key) >= 32 {
			digest := sha256.Sum256([]byte("cowork-slack-tools\x00" + key))
			return hex.EncodeToString(digest[:])
		}
	}
	return ""
}

//encore:api public raw method=POST path=/internal/channel-tools/*action
func ChannelToolBridge(w http.ResponseWriter, r *http.Request) {
	var input struct {
		channelActor
		Data json.RawMessage
	}
	if !decode(w, r, &input) {
		return
	}
	secret := channelBridgeSecret(input.Channel)
	if secret == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+secret)) != 1 {
		fail(w, 403, "Channel bridge access required.")
		return
	}
	if !channelWorkspaceID.MatchString(input.WorkspaceID) || input.Installation == "" || input.SenderID == "" || len(input.SenderID) > 128 {
		fail(w, 400, "Invalid channel participant.")
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
	if space == nil || (input.Channel == "telegram" && !telegramInstallationMatches(d, space, input.Agent, input.Installation, input.Conversation)) {
		fail(w, 403, "Channel installation unavailable.")
		return
	}

	role := channelAgentRole(space, input.Agent)
	if !roles[role] {
		fail(w, 403, "Channel agent unavailable.")
		return
	}

	switch r.URL.Path {
	case "/internal/channel-tools/slack-message":
		recordSlackTurn(w, d, space, input.channelActor, input.Data)
	case "/internal/channel-tools/context":
		context := workerRequest{Role: role, WorkspaceID: space.ID, AgentConnectionPaused: !space.AgentConnectionEnabled && d.AgentConnectionKeys[space.ID] != ""}
		for _, agent := range space.Agents {
			if agent.Role == role {
				context.AgentName = agent.Name
				ids := append([]string{}, agent.ConnectionIDs...)
				context.AgentConnectionIDs = &ids
				break
			}
		}
		if len(space.Agents) > 0 && context.AgentConnectionIDs == nil {
			fail(w, 403, "Channel agent is disabled in this workspace.")
			return
		}
		if context.AgentConnectionIDs == nil && len(d.GitTokens[space.ID]) > 0 {
			context.GitTokens, err = unlockGitTokens(space.ID, d.GitTokens[space.ID])
		}
		if err == nil && space.AgentConnectionEnabled && (context.AgentConnectionIDs == nil || len(*context.AgentConnectionIDs) > 0) {
			context.AgentConnectionWorkspace = space.ID
			if stored := d.AgentConnectionKeys[space.ID]; stored != "" {
				aead, cipherErr := agentConnectionCipher(false)
				if cipherErr != nil {
					err = cipherErr
				} else {
					context.AgentConnectionKey, err = openAgentConnectionKey(aead, space.ID, stored)
				}
			}
		}
		if err != nil {
			fail(w, 500, "Could not unlock repository access.")
			return
		}
		jsonReply(w, 200, context)
	case "/internal/channel-tools/task":
		var data struct {
			Title, Brief, Repository string
			UI                       bool
			ThreadID                 string
		}
		if err := json.Unmarshal(input.Data, &data); err != nil {
			fail(w, 400, "Invalid task.")
			return
		}
		data.ThreadID = ""
		if input.Channel == "slack" {
			if thread := boundSlackThread(space, input.channelActor); thread != nil {
				data.ThreadID = thread.ID
			}
		}
		// Construct the task request from allowlisted fields. Its workspace and author
		// come from the channel binding, outside the model's tool inputs.
		body, _ := json.Marshal(data)
		taskRequest, err := http.NewRequestWithContext(r.Context(), http.MethodPost, r.URL.String(), strings.NewReader(string(body)))
		if err != nil {
			fail(w, 400, "Invalid task request.")
			return
		}
		displayName := strings.TrimSpace(input.Author)
		if displayName == "" || len(displayName) > 160 {
			displayName = input.SenderID
		}
		actor := Account{ID: input.Channel + ":" + input.SenderID, Name: displayName + " (" + input.Channel + ")", Workspace: space.ID}
		runAgent(w, taskRequest, d, actor, space, "task", role)
	default:
		fail(w, 404, "Unknown channel tool.")
	}
}
