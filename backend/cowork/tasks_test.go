package cowork

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTaskBoardUsesWorkspaceAssigneesAndProtectsRuns(t *testing.T) {
	d := emptyDatabase()
	d.Accounts["teammate"] = Account{ID: "member", Workspace: "space"}
	d.Accounts["other"] = Account{ID: "outside", Workspace: "other"}
	space := &Workspace{ID: "space", Role: "Developer", Agents: []workspaceAgent{{ID: "sales", Role: "Sales Lead"}}}
	task := Task{Title: "Original", Status: "Assigned", AgentID: "sales"}
	now := time.Now()
	outside := "member:outside"
	title := "New title"
	code, _ := applyTaskUpdate(d, space, &task, taskUpdate{
		ExpectedStatus: "Assigned", Status: "Completed", Title: &title, Assignee: &outside,
	}, now)
	if code != 400 || task.Status != "Assigned" || task.Title != "Original" {
		t.Fatalf("invalid assignee should reject the whole update, got %d %+v", code, task)
	}
	member := "member:member"
	code, _ = applyTaskUpdate(d, space, &task, taskUpdate{
		ExpectedStatus: "Assigned", Status: "In progress", Title: &title, Assignee: &member,
	}, now)
	if code != 200 || task.Status != "In progress" || task.Title != title || task.AgentID != "" || task.AssigneeMemberID != "member" {
		t.Fatalf("expected the task to move and be assigned to a member, got %d %+v", code, task)
	}
	for _, current := range []Task{
		{Status: "Running", WorkflowStarted: &now},
		{Status: "Running", ScheduledStarted: &now},
		{Status: "Scheduled"},
		{Status: "Paused"},
		{Status: "Canceled"},
	} {
		code, _ = applyTaskUpdate(d, space, &current, taskUpdate{ExpectedStatus: current.Status, Status: "Completed"}, now)
		if code != 409 {
			t.Fatalf("expected a protected status, got %d %+v", code, current)
		}
	}
	code, _ = applyTaskUpdate(d, space, &task, taskUpdate{ExpectedStatus: "Assigned", Status: "Completed"}, now)
	if code != 409 || task.Status != "In progress" {
		t.Fatalf("a stale change should leave the task alone, got %d %+v", code, task)
	}
}

func TestTaskBoardAgentCanFindAndMoveWorkspaceTask(t *testing.T) {
	useTestPostgres(t)
	t.Setenv("COWORK_AUTH", "clerk")
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	account := Account{ID: key(), ClerkID: "user_clerk", Workspace: "space"}
	d.Accounts["owner"] = account
	d.Workspaces["space"] = &Workspace{ID: "space", Tasks: []Task{{ID: "owned", Title: "Launch plan", Status: "Assigned"}}}
	d.Workspaces["other"] = &Workspace{ID: "other", Tasks: []Task{{ID: "outside", Title: "Launch plan", Status: "Assigned"}}}
	if err := save(d); err != nil {
		t.Fatal(err)
	}
	session := newWorkerSession(account.ID)
	request := func(path, body string, want int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/task/"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Cowork-Worker", session)
		reply := httptest.NewRecorder()
		API(reply, req)
		if reply.Code != want {
			t.Fatalf("%s returned %d: %s", path, reply.Code, reply.Body.String())
		}
		return reply
	}
	found := request("find", `{"Query":"launch"}`, http.StatusOK)
	var matches struct{ Tasks []Task }
	if err := json.Unmarshal(found.Body.Bytes(), &matches); err != nil || len(matches.Tasks) != 1 || matches.Tasks[0].ID != "owned" {
		t.Fatalf("expected only the workspace task, got %s", found.Body.String())
	}
	request("update", `{"ID":"outside","ExpectedStatus":"Assigned","Status":"Completed"}`, http.StatusNotFound)
	moved := request("update", `{"ID":"owned","ExpectedStatus":"Assigned","Status":"Completed","Brief":"Ready to ship"}`, http.StatusOK)
	if moved.Header().Get("X-Cowork-Record-Id") != "owned" {
		t.Fatal("expected a confirmed task ID")
	}
	latest, err := load()
	if err != nil {
		t.Fatal(err)
	}
	task := latest.Workspaces["space"].Tasks[0]
	if task.Status != "Completed" || task.Brief != "Ready to ship" {
		t.Fatalf("expected persisted changes, got %+v", task)
	}
}
