package cowork

import (
	"context"
	"net/http"
	"time"
)

func assignedTaskRole(space *Workspace, task Task) string {
	if agent, ok := space.agent(task.AgentID); task.AgentID != "" && ok {
		return agent.Role
	}
	if roles[task.AgentRole] {
		return task.AgentRole
	}
	return space.Role
}

// The caller holds mutex for the workspace snapshot. save checks its revision
// after we reacquire the lock, so a concurrent change cannot commit stale data.
func validateTaskAssignment(ctx context.Context, w http.ResponseWriter, role string, task Task) bool {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	request := workerRequest{Role: role, Task: Task{Title: task.Title, Brief: task.Brief, Repository: task.Repository, UI: task.UI}}
	mutex.Unlock()
	decision, err := worker(ctx, "task-scope", request, "")
	mutex.Lock()
	if err != nil || (decision.Error == "" && !decision.ScopeAllowed) {
		fail(w, http.StatusServiceUnavailable, "Cowork could not check the task assignment. Try again shortly.")
		return false
	}
	if decision.Error != "" {
		status := http.StatusUnprocessableEntity
		if decision.ScopeUnavailable {
			status = http.StatusServiceUnavailable
		}
		fail(w, status, decision.Error)
		return false
	}
	return true
}
