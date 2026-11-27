package cowork

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type slackThread struct {
	Installation, Conversation string
}

var slackPublicThread = regexp.MustCompile(`^slack:C[A-Z0-9]+:[0-9]+\.[0-9]+$`)

func slackAgent(space *Workspace, agent string) (workspaceAgent, bool) {
	if id, managed := strings.CutPrefix(agent, "agent:"); managed {
		active, ok := space.agent(id)
		return active, id != "" && ok && active.Channel == "slack"
	}
	role := channelAgentRole(space, agent)
	for _, candidate := range space.Agents {
		if candidate.Role == role && candidate.Channel == "slack" {
			return candidate, true
		}
	}
	return workspaceAgent{}, false
}

func boundSlackThread(space *Workspace, actor channelActor) *Thread {
	for i := range space.Threads {
		thread := &space.Threads[i]
		if thread.Slack != nil && thread.Slack.Installation == actor.Installation && thread.Slack.Conversation == actor.Conversation {
			if _, active := space.agent(thread.AgentID); active {
				return thread
			}
		}
	}
	return nil
}

// Only the authenticated Slack adapter can mark a channel as public and internal.
func recordSlackTurn(w http.ResponseWriter, d *database, space *Workspace, actor channelActor, body json.RawMessage) {
	var input struct {
		ID, Text, Title string
		At              time.Time
		Reply           bool
	}
	if actor.Channel != "slack" || !slackPublicThread.MatchString(actor.Conversation) ||
		json.Unmarshal(body, &input) != nil || input.ID == "" || len(input.ID) > 128 || input.At.IsZero() ||
		strings.TrimSpace(input.Text) == "" || len(input.Text) > 12000 {
		fail(w, http.StatusBadRequest, "Invalid Slack message.")
		return
	}
	agent, allowed := slackAgent(space, actor.Agent)
	if !allowed {
		jsonReply(w, http.StatusOK, map[string]bool{"Sync": false})
		return
	}
	thread := boundSlackThread(space, actor)
	if thread == nil {
		if input.Reply {
			fail(w, http.StatusNotFound, "Slack conversation not found.")
			return
		}
		title := strings.TrimSpace(input.Title)
		if title == "" || len(title) > 120 {
			title = "Slack conversation"
		}
		space.Threads = append(space.Threads, Thread{
			ID: key(), Title: title, Author: actor.Author, AgentID: agent.ID, CreatedAt: input.At,
			Slack: &slackThread{Installation: actor.Installation, Conversation: actor.Conversation},
		})
		thread = &space.Threads[len(space.Threads)-1]
	}
	for _, message := range thread.Messages {
		if message.SlackMessage == input.ID {
			jsonReply(w, http.StatusOK, map[string]any{"Sync": true, "ThreadID": thread.ID, "Duplicate": true})
			return
		}
	}
	message := Message{Text: input.Text, At: input.At, SlackMessage: input.ID, Agent: input.Reply}
	if input.Reply {
		message.Author = agent.Name
	} else {
		message.Author, message.SenderID = actor.Author, actor.SenderID
		if message.Author == "" || len(message.Author) > 160 {
			message.Author = actor.SenderID
		}
	}
	thread.Messages = append(thread.Messages, message)
	if save(d) != nil {
		fail(w, http.StatusConflict, "Could not save the Slack message.")
		return
	}
	jsonReply(w, http.StatusOK, map[string]any{
		"Sync": true, "ThreadID": thread.ID, "Messages": thread.Messages[max(0, len(thread.Messages)-24):],
	})
}

func slackLinked(space *Workspace, id string) bool {
	for _, thread := range space.Threads {
		if thread.ID == id {
			return thread.Slack != nil
		}
	}
	return false
}
