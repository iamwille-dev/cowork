package cowork

import (
	"errors"
	"net/http"
	"strings"
	"time"
)

func taskAssignee(d *database, space *Workspace, selection string, fallback workspaceAgent) (workspaceAgent, string, bool) {
	if selection == "" {
		// Conversation and channel calls already supply their own default agent.
		return fallback, "", true
	}
	kind, id, _ := strings.Cut(selection, ":")
	switch kind {
	case "agent":
		if selection == "agent:" || id != "" {
			agent, ok := space.agent(id)
			return agent, "", ok
		}
	case "member":
		for _, member := range d.Accounts {
			if id != "" && member.ID == id && member.Workspace == space.ID {
				return workspaceAgent{}, id, true
			}
		}
	}
	return workspaceAgent{}, "", false
}

func boardTaskStatus(status string) bool {
	switch status {
	case "Assigned", "In progress", "Ready for review", "Blocked", "Completed":
		return true
	}
	return false
}

func taskRunActive(task Task, now time.Time) bool {
	return task.Status == "Running" && (task.ScheduledStarted != nil ||
		(task.WorkflowStarted != nil && now.Before(task.WorkflowStarted.Add(scheduledRunLease))))
}

type taskUpdate struct {
	ID, ExpectedStatus, Status string
	Assignee, Title, Brief     *string
}

func applyTaskUpdate(d *database, space *Workspace, task *Task, input taskUpdate, now time.Time) (int, string) {
	if input.Status == "" && input.Assignee == nil && input.Title == nil && input.Brief == nil {
		return 400, "Choose a task change."
	}
	if input.ExpectedStatus == "" || input.ExpectedStatus != task.Status {
		return 409, "This task’s status changed. Refresh the task and try again."
	}
	if taskRunActive(*task, now) {
		return 409, "This task can be edited when the agent finishes its run."
	}
	updated := *task
	if input.Status != "" {
		if !boardTaskStatus(input.Status) {
			return 400, "Choose a status from the task board."
		}
		switch task.Status {
		case "Scheduled", "Paused", "Canceled":
			return 409, "Use the schedule controls to manage this task."
		}
		updated.Status = input.Status
	}
	if input.Assignee != nil {
		if *input.Assignee == "" {
			return 400, "Select an agent or a team member."
		}
		agent, member, ok := taskAssignee(d, space, *input.Assignee, workspaceAgent{})
		if !ok {
			return 400, "Select an agent or a team member in this workspace."
		}
		if member != "" && (task.Status == "Scheduled" || task.Status == "Paused") {
			return 400, "Scheduled runs require an agent assignee."
		}
		updated.AgentID, updated.AgentRole, updated.AssigneeMemberID = agent.ID, agent.Role, member
	}
	if input.Title != nil {
		updated.Title = strings.TrimSpace(*input.Title)
		if updated.Title == "" || len(updated.Title) > 120 {
			return 400, "Enter a task title within the displayed limit."
		}
	}
	if input.Brief != nil {
		updated.Brief = strings.TrimSpace(*input.Brief)
		if updated.Brief == "" || len(updated.Brief) > 6000 {
			return 400, "Enter a task brief within the displayed limit."
		}
	}
	*task = updated
	return 200, ""
}

func updateBoardTask(w http.ResponseWriter, r *http.Request, d *database, a Account, space *Workspace) {
	var input taskUpdate
	if !decode(w, r, &input) {
		return
	}
	for i := range space.Tasks {
		task := &space.Tasks[i]
		if task.ID != input.ID {
			continue
		}
		if code, message := applyTaskUpdate(d, space, task, input, time.Now()); code != 200 {
			fail(w, code, message)
			return
		}
		if err := save(d); err != nil {
			if errors.Is(err, errStaleWorkspace) {
				fail(w, 409, "The workspace changed. Try again.")
			} else {
				fail(w, 500, "Could not save task changes.")
			}
			return
		}
		w.Header().Set("X-Cowork-Record-Id", task.ID)
		view(w, d, a)
		return
	}
	fail(w, 404, "Task not found in this workspace.")
}

func findBoardTasks(w http.ResponseWriter, r *http.Request, space *Workspace) {
	var input struct{ Query string }
	if !decode(w, r, &input) {
		return
	}
	query := strings.ToLower(strings.TrimSpace(input.Query))
	type match struct{ ID, Title, Status, Author string }
	matches := []match{}
	more := false
	for i := len(space.Tasks) - 1; i >= 0; i-- {
		task := space.Tasks[i]
		if query != "" && task.ID != query && !strings.Contains(strings.ToLower(task.Title), query) {
			continue
		}
		if len(matches) == 20 {
			more = true
			break
		}
		matches = append(matches, match{task.ID, task.Title, task.Status, task.Author})
	}
	jsonReply(w, 200, map[string]any{"tasks": matches, "more": more})
}
