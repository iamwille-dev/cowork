package cowork

import (
	"context"
	"errors"
	"log"
	"os"
	"strings"
	"syscall"
	"time"
)

const (
	taskPollInterval = 2 * time.Second
	taskRunLease     = 3 * time.Minute
	taskRetryDelay   = 5 * time.Second
	taskParallelism  = 4
)

func init() {
	if strings.TrimSpace(os.Getenv("DATABASE_URL")) != "" {
		go dispatchTasks()
	}
}

func dispatchTasks() {
	ticker := time.NewTicker(taskPollInterval)
	defer ticker.Stop()
	done := make(chan error, taskParallelism)
	active := 0
	report := func(err error) {
		if err != nil && !errors.Is(err, errStaleWorkspace) {
			log.Printf("Cowork task dispatcher: %v", err)
		}
	}
	for {
		for active < taskParallelism {
			request, err := claimNextTask(time.Now().UTC())
			if err != nil || request.Task.ID == "" {
				report(err)
				break
			}
			active++
			go func() { done <- executeTaskRun(request, false) }()
		}
		select {
		case <-ticker.C:
		case err := <-done:
			active--
			report(err)
		}
	}
}

func taskAgent(space *Workspace, task Task) (workspaceAgent, bool) {
	if task.AssigneeMemberID != "" {
		return workspaceAgent{}, false
	}
	if task.AgentID != "" {
		return space.agent(task.AgentID)
	}
	if task.AgentRole == "" {
		if space.threadHasRemovedAgent(task.ThreadID) {
			return workspaceAgent{}, false
		}
		agent := space.threadAgent(task.ThreadID)
		return agent, roles[agent.Role]
	}
	if space.RemovedAgentRoles[task.AgentRole] {
		return workspaceAgent{}, false
	}
	for _, agent := range space.Agents {
		if agent.Role == task.AgentRole {
			return agent, true
		}
	}
	// Legacy channel agents stored their role even when they had no agent ID.
	if primary, _ := space.agent(""); primary.ID == "" && roles[task.AgentRole] {
		return workspaceAgent{Role: task.AgentRole, Name: task.AgentRole + " agent"}, true
	}
	return workspaceAgent{}, false
}

func taskRunStarted(task Task) *time.Time {
	if task.ScheduledStarted != nil {
		return task.ScheduledStarted
	}
	return task.WorkflowStarted
}

func nextWorkspaceTask(space *Workspace, now time.Time, onlyRole string) *Task {
	busy := make(map[string]bool)
	for _, task := range space.Tasks {
		started := taskRunStarted(task)
		if task.Status == "In progress" ||
			(task.Status == "Running" && started != nil && now.Before(started.Add(taskRunLease))) {
			if agent, ok := taskAgent(space, task); ok {
				busy[agent.Role] = true
			}
		}
	}

	var next *Task
	for i := range space.Tasks {
		task := &space.Tasks[i]
		if task.RetryAfter != nil && task.RetryAfter.After(now) {
			continue
		}
		agent, available := taskAgent(space, *task)
		if (onlyRole != "" && (!available || agent.Role != onlyRole)) || busy[agent.Role] {
			continue
		}
		switch task.Status {
		case "Assigned":
			if !available {
				continue
			}
		case "Scheduled":
			if task.ScheduledFor == nil || task.ScheduledFor.After(now) {
				continue
			}
		case "Running":
			started := taskRunStarted(*task)
			if started == nil || now.Before(started.Add(taskRunLease)) {
				continue
			}
		default:
			continue
		}
		if next == nil || taskRunsBefore(*task, *next) {
			next = task
		}
	}
	return next
}

func taskRunsBefore(task, other Task) bool {
	order := func(task Task) (int, *time.Time) {
		switch task.Status {
		case "Running":
			return 0, taskRunStarted(task)
		case "Scheduled":
			return 1, task.ScheduledFor
		default:
			return 2, task.QueuedAt
		}
	}
	priority, at := order(task)
	otherPriority, otherAt := order(other)
	if priority != otherPriority {
		return priority < otherPriority
	}
	return otherAt != nil && (at == nil || at.Before(*otherAt))
}

func nextTask(d *database, now time.Time) (*Workspace, *Task) {
	var selected *Task
	var workspace *Workspace
	for _, space := range d.Workspaces {
		task := nextWorkspaceTask(space, now, "")
		if task != nil && (selected == nil || taskRunsBefore(*task, *selected) ||
			(!taskRunsBefore(*selected, *task) && space.ID < workspace.ID)) {
			workspace, selected = space, task
		}
	}
	return workspace, selected
}

func claimNextTask(now time.Time) (workerRequest, error) {
	mutex.Lock()
	defer mutex.Unlock()
	d, err := load()
	if err != nil {
		return workerRequest{}, err
	}
	space, task := nextTask(d, now)
	if task == nil {
		return workerRequest{}, nil
	}
	agent, available := taskAgent(space, *task)
	if task.Status == "Running" && task.ScheduledFor == nil && (!available || agent.Role == "Developer" || task.AgentRole == "Developer") {
		// A developer runner can change external state. An expired claim has an unknown outcome.
		task.Status, task.WorkflowStarted = "Failed", nil
		task.Error = "The agent run was interrupted. Check for partial work before running this task again."
		appendTaskNote(task, "Cowork dispatcher", task.Error, now)
		return workerRequest{}, save(d)
	}
	if !available {
		task.Status, task.ScheduledStarted = "Canceled", nil
		return workerRequest{}, save(d)
	}
	request := startTaskRun(d, space, task, agent, now)
	if err := save(d); err != nil {
		return workerRequest{}, err
	}
	return request, nil
}

func startTaskRun(d *database, space *Workspace, task *Task, agent workspaceAgent, now time.Time) workerRequest {
	run := *task
	run.AgentID, run.AgentRole = agent.ID, agent.Role
	run.Status, run.RetryAfter = "Running", nil
	run.Result, run.Error, run.Steps, run.Artifacts = "", "", nil, nil
	run.ScheduledStarted, run.WorkflowStarted = nil, nil
	if run.ScheduledFor != nil {
		run.ScheduledStarted = &now
	} else {
		run.WorkflowStarted = &now
	}
	if task.Status == "Scheduled" && task.RecurrenceStart != nil && recurrenceDays(task.Recurrence) > 0 {
		// Persist the instance and advance the schedule in the same write.
		next := nextOccurrence(*task, now)
		task.ScheduledFor = &next
		run.ID, run.RunRecurrence = key(), task.Recurrence
		run.Recurrence, run.RecurrenceStart = "", nil
		run.Notes = nil
		space.Tasks = append(space.Tasks, run)
	} else {
		*task = run
	}
	zone := run.ScheduledTimeZone
	if zone == "" {
		zone = "UTC"
	}
	request := workerRequest{
		Task: run, Role: agent.Role, AgentName: agent.Name, TimeZone: zone,
		WorkspaceID: space.ID, ThreadID: run.ThreadID,
	}
	if run.GmailConnectionID != "" {
		configureGmailDigest(d, space, agent, &request)
	} else if run.MemoryMemberID != "" && !hasActiveGuestGrant(d, space.ID, run.ThreadID) {
		request.AgentMemory = space.memoryFor(run.MemoryMemberID, agent.ID).Items
	}
	return request
}

func executeTaskRun(request workerRequest, scopeChecked bool) error {
	path := "scheduled-task"
	timeout := 90 * time.Second
	if request.Task.GmailConnectionID != "" {
		if request.AgentConnectionWorkspace == "" {
			return finishTaskRun(request, workerResponse{Error: "Gmail access changed. Check the selected account and agent grant in Settings."}, nil)
		}
		path = "gmail-digest"
	} else if request.Task.ScheduledFor == nil && request.Role == "Developer" {
		path = "task"
		if !scopeChecked {
			scope, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			result, err := worker(scope, "task-scope", workerRequest{Role: request.Role, Task: request.Task}, "")
			cancel()
			if err != nil || !result.ScopeAllowed {
				if result.Error == "" {
					result.Error = "Cowork could not check the task assignment."
				}
				return finishTaskRun(request, result, err)
			}
			timeout = 150 * time.Second
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	result, runErr := worker(ctx, path, request, "")
	if path == "task" && runErr != nil && !errors.Is(runErr, errWorkerResponse) && !errors.Is(runErr, syscall.ECONNREFUSED) {
		// Keep the lease until expiry when the worker may still be running.
		return nil
	}
	return finishTaskRun(request, result, runErr)
}

func finishTaskRun(request workerRequest, result workerResponse, runErr error) error {
	finished := time.Now().UTC()
	var err error
	for range 3 {
		err = storeTaskResult(request, result, runErr, finished)
		if !errors.Is(err, errStaleWorkspace) {
			break
		}
	}
	return err
}

func storeTaskResult(request workerRequest, result workerResponse, runErr error, finished time.Time) error {
	mutex.Lock()
	defer mutex.Unlock()
	d, err := load()
	if err != nil {
		return err
	}
	space := d.Workspaces[request.WorkspaceID]
	if space == nil {
		return nil
	}
	for i := range space.Tasks {
		task := &space.Tasks[i]
		current, started := taskRunStarted(*task), taskRunStarted(request.Task)
		if task.ID != request.Task.ID || task.Status != "Running" || current == nil || started == nil || !current.Equal(*started) {
			continue
		}
		task.ScheduledStarted, task.WorkflowStarted = nil, nil
		task.Status = "Ready for review"
		task.Result, task.Error, task.Steps, task.Artifacts = result.Reply, result.Error, result.Steps, result.Artifacts
		switch {
		case errors.Is(runErr, syscall.ECONNREFUSED):
			retry := finished.Add(taskRetryDelay)
			task.RetryAfter, task.Error, task.Status = &retry, "", "Assigned"
			if task.ScheduledFor != nil {
				task.Status = "Scheduled"
			}
			return save(d)
		case runErr != nil:
			task.Status, task.Error = "Failed", "The agent service was unavailable."
		case result.Error != "":
			task.Status = "Blocked"
			if task.ScheduledFor != nil {
				task.Status = "Failed"
			}
		}
		author := request.AgentName
		if runErr != nil {
			author = "Cowork dispatcher"
		}
		note := strings.TrimSpace(result.Note)
		switch {
		case task.Error != "" && note == "":
			note = task.Error
		case note == "" && len(result.Steps) > 0:
			note = strings.Join(result.Steps, "\n")
		case note == "":
			note = "I saved the task result for review."
		}
		appendTaskNote(task, author, note, finished)
		return save(d)
	}
	return nil
}

func appendTaskNote(task *Task, author, note string, at time.Time) {
	if author == "" {
		author = "Cowork agent"
	}
	characters := []rune(note)
	if len(characters) > 1000 {
		note = strings.TrimSpace(string(characters[:999])) + "…"
	}
	task.Notes = append(task.Notes, TaskNote{Author: author, Text: note, At: at})
}
