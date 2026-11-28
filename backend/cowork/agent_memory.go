package cowork

import (
	"errors"
	"net/http"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

type agentMemory struct {
	Revision string
	Items    []string
}

var errAgentMemoryChanged = errors.New("Agent memory changed. Reopen the editor to see the latest list.")

func normalizeAgentMemory(items []string) ([]string, error) {
	if len(items) > 20 {
		return nil, errors.New("Agent memory can hold up to 20 items.")
	}
	normalized := make([]string, 0, len(items))
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item == "" || utf8.RuneCountInString(item) > 240 || strings.ContainsFunc(item, func(char rune) bool {
			return unicode.IsControl(char) || char == '\u2028' || char == '\u2029'
		}) {
			return nil, errors.New("Enter each memory item on one line, up to 240 characters.")
		}
		if !slices.Contains(normalized, item) {
			normalized = append(normalized, item)
		}
	}
	return normalized, nil
}

func (space *Workspace) memoryFor(memberID, agentID string) agentMemory {
	return space.AgentMemories[memberID][agentID]
}

func (space *Workspace) replaceAgentMemory(memberID, agentID, revision string, items []string) error {
	agent, active := space.agent(agentID)
	current := space.memoryFor(memberID, agentID)
	if !active || agent.ID != agentID || current.Revision != revision {
		return errAgentMemoryChanged
	}
	if slices.Equal(current.Items, items) {
		return nil
	}
	if space.AgentMemories == nil {
		space.AgentMemories = make(map[string]map[string]agentMemory)
	}
	if space.AgentMemories[memberID] == nil {
		space.AgentMemories[memberID] = make(map[string]agentMemory)
	}
	space.AgentMemories[memberID][agentID] = agentMemory{Revision: key(), Items: items}
	return nil
}

func updateAgentMemory(w http.ResponseWriter, r *http.Request, d *database, account Account, space *Workspace) {
	var input struct {
		ID       *string
		Revision string
		Items    *[]string
	}
	if !decode(w, r, &input) {
		return
	}
	if input.ID == nil || input.Items == nil {
		fail(w, http.StatusBadRequest, "Choose an agent and provide its memory list.")
		return
	}
	items, err := normalizeAgentMemory(*input.Items)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := space.replaceAgentMemory(account.ID, *input.ID, input.Revision, items); err != nil {
		fail(w, http.StatusConflict, err.Error())
		return
	}
	if err := save(d); err != nil {
		if errors.Is(err, errStaleWorkspace) {
			fail(w, http.StatusConflict, errAgentMemoryChanged.Error())
		} else {
			fail(w, http.StatusInternalServerError, "Could not save agent memory. Try again.")
		}
		return
	}
	view(w, d, account)
}
