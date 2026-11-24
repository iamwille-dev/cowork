package cowork

import (
	"net/http"
	"regexp"
	"strings"
	"time"
)

var agentConnectionKeyPattern = regexp.MustCompile(`^ellie_agent_[A-Za-z0-9_-]{16,256}$`)

func updateAgentConnection(w http.ResponseWriter, r *http.Request, d *database, account Account, space *Workspace) {
	if account.ID != space.Owner {
		fail(w, 403, "Workspace owner access required.")
		return
	}
	var input struct {
		Enabled   bool
		Key       string
		RemoveKey bool
	}
	if !decode(w, r, &input) {
		return
	}
	credential := strings.TrimSpace(input.Key)
	if credential != "" && !agentConnectionKeyPattern.MatchString(credential) {
		fail(w, 400, "Enter a named agent key from Agent Connections.")
		return
	}
	if input.RemoveKey {
		delete(d.AgentConnectionKeys, space.ID)
	} else if credential != "" {
		aead, err := agentConnectionCipher(len(d.AgentConnectionKeys) == 0 && len(d.GitTokens) == 0 && len(d.TelegramBots) == 0)
		for workspaceID, stored := range d.AgentConnectionKeys {
			if err == nil {
				_, err = openAgentConnectionKey(aead, workspaceID, stored)
			}
			break
		}
		if err != nil {
			fail(w, 500, "Could not encrypt the Agent Connection key.")
			return
		}
		if d.AgentConnectionKeys == nil {
			d.AgentConnectionKeys = make(map[string]string)
		}
		d.AgentConnectionKeys[space.ID] = sealAgentConnectionKey(aead, space.ID, credential)
	}
	space.AgentConnectionEnabled = input.Enabled && !input.RemoveKey
	if save(d) != nil {
		fail(w, 500, "Could not save Agent Connection settings.")
		return
	}
	view(w, d, account)
}

func protectCredentialThread(d *database, workspaceID, threadID string) bool {
	now := time.Now()
	for _, grant := range d.GuestGrants {
		if grant.WorkspaceID == workspaceID && grant.ThreadID == threadID && grant.Expires.After(now) {
			return false
		}
	}
	if d.AgentConnectionThreads == nil {
		d.AgentConnectionThreads = make(map[string]map[string]bool)
	}
	if d.AgentConnectionThreads[workspaceID] == nil {
		d.AgentConnectionThreads[workspaceID] = make(map[string]bool)
	}
	d.AgentConnectionThreads[workspaceID][threadID] = true
	return true
}
