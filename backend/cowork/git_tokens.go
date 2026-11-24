package cowork

import (
	"net/http"
	"regexp"
	"strings"
)

var gitTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

func gitTokenScope(workspaceID, provider string) string {
	return "git:" + workspaceID + ":" + provider
}

func gitTokenStatus(stored map[string]string) map[string]bool {
	return map[string]bool{"github": stored["github"] != "", "gitlab": stored["gitlab"] != ""}
}

func unlockGitTokens(workspaceID string, stored map[string]string) (map[string]string, error) {
	aead, err := agentConnectionCipher(false)
	if err != nil {
		return nil, err
	}
	tokens := make(map[string]string, len(stored))
	for provider, encrypted := range stored {
		token, err := openAgentConnectionKey(aead, gitTokenScope(workspaceID, provider), encrypted)
		if err != nil {
			return nil, err
		}
		tokens[provider] = token
	}
	return tokens, nil
}

func updateGitToken(w http.ResponseWriter, r *http.Request, d *database, account Account, space *Workspace) {
	if account.ID != space.Owner {
		fail(w, 403, "Workspace owner access required.")
		return
	}
	var input struct {
		Provider string
		Token    string
		Remove   bool
	}
	if !decode(w, r, &input) {
		return
	}
	if input.Provider != "github" && input.Provider != "gitlab" {
		fail(w, 400, "Choose GitHub or GitLab.")
		return
	}
	stored := d.GitTokens[space.ID]
	if input.Remove {
		delete(stored, input.Provider)
		if len(stored) == 0 {
			delete(d.GitTokens, space.ID)
		}
	} else {
		token := strings.TrimSpace(input.Token)
		if len(token) > 1024 || !gitTokenPattern.MatchString(token) {
			fail(w, 400, "Enter a valid access token.")
			return
		}
		aead, err := agentConnectionCipher(len(d.AgentConnectionKeys) == 0 && len(d.GitTokens) == 0)
		if err != nil {
			fail(w, 500, "Could not encrypt the Git token.")
			return
		}
		if d.GitTokens == nil {
			d.GitTokens = make(map[string]map[string]string)
		}
		if stored == nil {
			stored = make(map[string]string)
			d.GitTokens[space.ID] = stored
		}
		stored[input.Provider] = sealAgentConnectionKey(aead, gitTokenScope(space.ID, input.Provider), token)
	}
	if save(d) != nil {
		fail(w, 500, "Could not save Git token settings.")
		return
	}
	view(w, d, account)
}
