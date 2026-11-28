package cowork

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"
)

func mayManageWorkspaceAgents(w http.ResponseWriter, account Account, space *Workspace) bool {
	if account.ID != space.Owner {
		fail(w, http.StatusForbidden, "Workspace owner access required.")
		return false
	}
	if space.OnboardingStep != "" {
		fail(w, http.StatusConflict, "Finish workspace setup before managing agents.")
		return false
	}
	return true
}

func workspaceAgentName(name, fallback string) (string, error) {
	name = strings.TrimSpace(name)
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) > 48 || strings.ContainsAny(name, "\r\n\t") {
		return "", errors.New("Agent names can be up to 48 characters on one line.")
	}
	if name == "" {
		return fallback, nil
	}
	return name, nil
}

func workspaceAgentChannel(role, channel string) (string, error) {
	switch channel {
	case "", "cowork":
		return "cowork", nil
	case "slack":
		return channel, nil
	case "telegram":
		if role != "Developer" && role != "Sales Lead" {
			return "", errors.New("This agent is available in Cowork.")
		}
		return channel, nil
	default:
		return "", errors.New("Choose a supported messaging channel.")
	}
}

func addWorkspaceAgent(w http.ResponseWriter, r *http.Request, d *database, account Account, space *Workspace) {
	if !mayManageWorkspaceAgents(w, account, space) {
		return
	}
	var input struct{ ID, Name, Channel string }
	if !decode(w, r, &input) {
		return
	}
	agents, err := onboardingAgents([]workspaceAgent{{ID: input.ID, Name: input.Name}})
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	agent := agents[0]
	agent.Channel, err = workspaceAgentChannel(agent.Role, input.Channel)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	for _, existing := range space.Agents {
		if existing.Role != agent.Role {
			continue
		}
		if existing.ID != "" && existing.Name == agent.Name && existing.Channel == agent.Channel {
			view(w, d, account)
			return
		}
		fail(w, http.StatusConflict, "This workspace already has an agent for that role.")
		return
	}
	if len(space.Agents) == 0 {
		legacy, _ := space.agent("")
		if legacy.Role == agent.Role {
			fail(w, http.StatusConflict, "This workspace already has an agent for that role.")
			return
		}
		// An empty ID preserves the original agent, thread assignments, and tool access.
		space.Agents = append(space.Agents, legacy)
	}
	if space.RemovedAgentRoles[agent.Role] {
		// A replacement starts with a new identity so it cannot inherit old assignments.
		agent.ID += "-" + key()
	}
	space.Agents = append(space.Agents, agent)
	saveWorkspaceAgentSettings(w, d, account)
}

func updateWorkspaceAgent(w http.ResponseWriter, r *http.Request, d *database, account Account, space *Workspace) {
	if !mayManageWorkspaceAgents(w, account, space) {
		return
	}
	var input struct {
		ID            string
		Name, Channel *string
	}
	if !decode(w, r, &input) {
		return
	}
	if input.ID == "" {
		fail(w, http.StatusBadRequest, "Choose an agent to edit.")
		return
	}
	for i, agent := range space.Agents {
		if agent.ID != input.ID {
			continue
		}
		name, channel := agent.Name, agent.Channel
		var err error
		if input.Name != nil {
			name, err = workspaceAgentName(*input.Name, agent.Role)
			if err != nil {
				fail(w, http.StatusBadRequest, err.Error())
				return
			}
		}
		if input.Channel != nil {
			channel, err = workspaceAgentChannel(agent.Role, *input.Channel)
			if err != nil {
				fail(w, http.StatusBadRequest, err.Error())
				return
			}
		}
		if name == agent.Name && channel == agent.Channel {
			view(w, d, account)
			return
		}
		space.Agents[i].Name, space.Agents[i].Channel = name, channel
		saveWorkspaceAgentSettings(w, d, account)
		return
	}
	fail(w, http.StatusNotFound, "Agent not found in this workspace.")
}

func removeWorkspaceAgent(w http.ResponseWriter, r *http.Request, d *database, account Account, space *Workspace) {
	if !mayManageWorkspaceAgents(w, account, space) {
		return
	}
	var input struct{ ID string }
	if !decode(w, r, &input) {
		return
	}
	if input.ID == "" {
		fail(w, http.StatusBadRequest, "Choose an added agent to remove.")
		return
	}
	for index, agent := range space.Agents {
		if agent.ID != input.ID {
			continue
		}
		if len(space.Agents) == 1 {
			fail(w, http.StatusConflict, "Keep at least one agent in the workspace.")
			return
		}
		space.Agents = append(space.Agents[:index], space.Agents[index+1:]...)
		for _, memories := range space.AgentMemories {
			delete(memories, agent.ID)
		}
		space.Role = space.Agents[0].Role
		if space.RemovedAgentRoles == nil {
			space.RemovedAgentRoles = make(map[string]bool)
		}
		space.RemovedAgentRoles[agent.Role] = true
		for i := range space.Tasks {
			task := &space.Tasks[i]
			assigned := task.AgentID == agent.ID || (task.AgentID == "" && task.AgentRole == agent.Role)
			if assigned && (task.Status == "Scheduled" || task.Status == "Paused") {
				task.Status = "Canceled"
			}
		}
		for slug, channelAgent := range namedChannelAgents {
			if channelAgent.Role == agent.Role {
				delete(d.TelegramBots, telegramBotKey(space.ID, slug))
			}
		}
		saveWorkspaceAgentSettings(w, d, account)
		return
	}
	fail(w, http.StatusNotFound, "Agent not found in this workspace.")
}

func (space *Workspace) threadHasRemovedAgent(id string) bool {
	for _, thread := range space.Threads {
		if thread.ID == id && thread.AgentID != "" {
			_, active := space.agent(thread.AgentID)
			return !active
		}
	}
	return false
}

func saveWorkspaceAgentSettings(w http.ResponseWriter, d *database, account Account) {
	if err := save(d); err != nil {
		if errors.Is(err, errStaleWorkspace) {
			fail(w, http.StatusConflict, "The workspace changed. Try again.")
		} else {
			fail(w, http.StatusInternalServerError, "Could not save agent settings. Try again.")
		}
		return
	}
	view(w, d, account)
}
