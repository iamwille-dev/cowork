package cowork

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestTaskDispatcherWaitsForTheAssignedAgent(t *testing.T) {
	useTestPostgres(t)
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	due := now.Add(-time.Minute)
	d.Accounts["owner"] = Account{ID: "owner", Workspace: "space"}
	d.Sessions["session"] = "owner"
	d.Workspaces["space"] = &Workspace{
		ID: "space", Role: "Developer",
		Agents: []workspaceAgent{{ID: "developer", Role: "Developer"}, {ID: "sales", Role: "Sales Lead", Name: "Sam"}},
		Tasks: []Task{
			{ID: "active", AgentID: "developer", Status: "Running", WorkflowStarted: &now},
			{ID: "meeting", AgentID: "sales", Status: "In progress"},
			{ID: "human", AssigneeMemberID: "owner", Status: "Assigned"},
			{ID: "removed", AgentID: "missing", Status: "Assigned"},
			{ID: "review", AgentID: "developer", Status: "Ready for review"},
			{ID: "timer", AgentID: "developer", Status: "Scheduled", ScheduledFor: &due},
			{ID: "old-backlog", AgentID: "sales", Status: "Assigned", Title: "Write outreach"},
		},
	}
	d.Workspaces["other"] = &Workspace{ID: "other", Role: "Developer", Tasks: []Task{
		{ID: "independent", Status: "Assigned"},
	}}
	if err := save(d); err != nil {
		t.Fatal(err)
	}
	previous := workerClient
	t.Cleanup(func() { workerClient = previous })
	var dispatched []string
	workerClient = &http.Client{Transport: scheduledWorkerTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/task-scope" {
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"ScopeAllowed":true}`))}, nil
		}
		var request workerRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			return nil, err
		}
		dispatched = append(dispatched, r.URL.Path+":"+request.Task.ID)
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"Reply":"Deliverable","Note":"Completed the brief."}`))}, nil
	})}
	post := func(path, body string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest("POST", "/api/"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: "cowork_session", Value: "session"})
		response := httptest.NewRecorder()
		API(response, r)
		if response.Code != http.StatusOK {
			t.Fatalf("%s returned %d: %s", path, response.Code, response.Body.String())
		}
		return response
	}
	created := post("task", `{"Title":"Update website","Brief":"Build the approved UI.","UI":true}`)
	newID := created.Header().Get("X-Cowork-Record-Id")
	if newID == "" || len(dispatched) != 0 {
		t.Fatalf("new assignment should wait for the developer, got id %q and dispatches %v", newID, dispatched)
	}
	claim := func(want string) workerRequest {
		t.Helper()
		request, err := claimNextTask(time.Now().UTC())
		if err != nil || request.Task.ID != want {
			t.Fatalf("claim = %q, %v, want %q", request.Task.ID, err, want)
		}
		return request
	}
	run := func(request workerRequest) {
		t.Helper()
		if err := executeTaskRun(request, false); err != nil {
			t.Fatal(err)
		}
	}
	other := claim("independent")
	if other.WorkspaceID != "other" {
		t.Fatalf("unexpected workspace: %q", other.WorkspaceID)
	}
	claim("")
	post("task/update", `{"ID":"meeting","ExpectedStatus":"In progress","Status":"Completed"}`)
	sales := claim("old-backlog")
	if sales.Role != "Sales Lead" || sales.TimeZone != "UTC" {
		t.Fatalf("unexpected background dispatch: %+v", sales)
	}
	run(sales)
	run(other)

	active := workerRequest{WorkspaceID: "space", Task: d.Workspaces["space"].Tasks[0]}
	if err := finishTaskRun(active, workerResponse{}, nil); err != nil {
		t.Fatal(err)
	}
	run(claim("timer"))
	run(claim(newID))
	claim("")

	if want := "/scheduled-task:old-backlog,/task:independent,/scheduled-task:timer,/task:" + newID; strings.Join(dispatched, ",") != want {
		t.Fatalf("dispatches = %v, want %s", dispatched, want)
	}
	latest, err := load()
	if err != nil {
		t.Fatal(err)
	}
	tasks := latest.Workspaces["space"].Tasks
	if tasks[2].Status != "Assigned" || tasks[3].Status != "Assigned" ||
		tasks[6].Status != "Ready for review" || tasks[6].Result != "Deliverable" ||
		len(tasks[6].Notes) != 1 || tasks[6].Notes[0].Author != "Sam" ||
		tasks[6].Notes[0].Text != "Completed the brief." || tasks[6].Notes[0].At.Before(now) ||
		tasks[7].Status != "Ready for review" || tasks[7].WorkflowStarted != nil || len(tasks[7].Notes) != 1 {
		t.Fatalf("unexpected board after dispatch: %+v", tasks)
	}
}

func TestTaskDispatcherRecoversWithoutDuplicatingRecurringRuns(t *testing.T) {
	useTestPostgres(t)
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	due := now.Add(-time.Hour)
	d.Workspaces["space"] = &Workspace{ID: "space", Role: "Developer", Tasks: []Task{
		{ID: "expired", AgentRole: "Developer", Status: "Running", WorkflowStarted: &due},
		{ID: "daily", Status: "Scheduled", ScheduledFor: &due, Recurrence: "daily", RecurrenceStart: &due},
	}}
	if err := save(d); err != nil {
		t.Fatal(err)
	}
	if request, err := claimNextTask(now); err != nil || request.Task.ID != "" {
		t.Fatalf("an expired developer workflow should not be replayed: %+v, %v", request.Task, err)
	}
	first, err := claimNextTask(now)
	if err != nil || first.Task.ID == "" || first.Task.ID == "daily" {
		t.Fatalf("expected a recurring instance, got %+v, %v", first.Task, err)
	}
	if err := finishTaskRun(first, workerResponse{}, syscall.ECONNREFUSED); err != nil {
		t.Fatal(err)
	}
	if request, err := claimNextTask(now); err != nil || request.Task.ID != "" {
		t.Fatalf("retry should wait for backoff: %+v, %v", request.Task, err)
	}
	retry, err := claimNextTask(time.Now().UTC().Add(taskRetryDelay))
	if err != nil || retry.Task.ID != first.Task.ID {
		t.Fatalf("expected to retry the same occurrence, got %+v, %v", retry.Task, err)
	}
	if err := finishTaskRun(first, workerResponse{Reply: "Old claim", Note: "Stale note"}, nil); err != nil {
		t.Fatal(err)
	}
	if err := finishTaskRun(retry, workerResponse{Reply: "Current claim"}, nil); err != nil {
		t.Fatal(err)
	}
	latest, err := load()
	if err != nil {
		t.Fatal(err)
	}
	tasks := latest.Workspaces["space"].Tasks
	if len(tasks) != 3 || tasks[0].Status != "Failed" || tasks[0].Error == "" ||
		len(tasks[0].Notes) != 1 || tasks[0].Notes[0].Text != tasks[0].Error ||
		!tasks[1].ScheduledFor.Equal(due.AddDate(0, 0, 1)) || tasks[2].Result != "Current claim" ||
		len(tasks[2].Notes) != 1 || tasks[2].Notes[0].Text != "I saved the task result for review." {
		t.Fatalf("unexpected recovery state: %+v", tasks)
	}
}
