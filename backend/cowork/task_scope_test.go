package cowork

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func allowTaskAssignments(t *testing.T) {
	t.Helper()
	stubTaskScope(t, func(workerRequest) string { return `{"ScopeAllowed":true}` })
}

func stubTaskScope(t *testing.T, decide func(workerRequest) string) {
	t.Helper()
	previous := workerClient
	t.Cleanup(func() { workerClient = previous })
	workerClient = &http.Client{Transport: scheduledWorkerTransport(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/task-scope" {
			t.Errorf("unexpected worker request: %s", request.URL.Path)
			return &http.Response{StatusCode: 500, Body: http.NoBody}, nil
		}
		var input workerRequest
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(decide(input)))}, nil
	})}
}

func TestTaskScopeRejectsWritesBeforeTheyAreSaved(t *testing.T) {
	useTestPostgres(t)
	t.Setenv("COWORK_AUTH", "local")
	database, err := load()
	if err != nil {
		t.Fatal(err)
	}
	database.Accounts["owner"] = Account{ID: "owner", Workspace: "space"}
	database.Sessions["session"] = "owner"
	database.Workspaces["space"] = &Workspace{ID: "space", Role: "Sales Lead", Agents: []workspaceAgent{
		{ID: "sales", Role: "Sales Lead"}, {ID: "developer", Role: "Developer"},
	}}
	if err := save(database); err != nil {
		t.Fatal(err)
	}
	checks := 0
	stubTaskScope(t, func(input workerRequest) string {
		checks++
		if input.Task.Title == "Unavailable" {
			return `{"ScopeUnavailable":true,"Error":"Try again shortly."}`
		}
		if input.Task.Brief == "Repair the JavaScript parser" && input.Role != "Developer" {
			return `{"Error":"Assign this task to a Developer agent."}`
		}
		return `{"ScopeAllowed":true}`
	})
	request := func(path, body string, status int) string {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, "/api/"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: "cowork_session", Value: "session"})
		w := httptest.NewRecorder()
		API(w, r)
		if w.Code != status {
			t.Fatalf("%s returned %d, want %d: %s", path, w.Code, status, w.Body)
		}
		id := w.Header().Get("X-Cowork-Record-Id")
		if status >= 400 && id != "" {
			t.Fatalf("rejected %s returned a saved record ID: %s", path, id)
		}
		return id
	}
	request("task", `{"Title":"Repair parser","Brief":"Repair the JavaScript parser","Assignee":"agent:sales","PlanOnly":true}`, 422)
	request("task/schedule", `{"Title":"Repair parser","Brief":"Repair the JavaScript parser","Assignee":"agent:sales","DelaySeconds":60}`, 422)
	request("task", `{"Title":"Unavailable","Brief":"Repair the JavaScript parser","Assignee":"agent:developer","PlanOnly":true}`, 503)
	id := request("task", `{"Title":"Repair parser","Brief":"Repair the JavaScript parser","Assignee":"agent:developer","PlanOnly":true}`, 200)
	request("task/update", `{"ID":"`+id+`","ExpectedStatus":"Assigned","Assignee":"agent:sales","Title":"Reassigned"}`, 422)
	schedule := request("task/schedule", `{"Title":"Follow up","Brief":"Draft a prospect follow-up","Assignee":"agent:sales","DelaySeconds":60}`, 200)
	request("task/schedule/update", `{"ID":"`+schedule+`","Action":"edit","Title":"Repair parser","Brief":"Repair the JavaScript parser"}`, 422)
	request("task", `{"Title":"Unavailable","Brief":"Repair the JavaScript parser","Assignee":"member:owner"}`, 200)

	latest, err := load()
	if err != nil {
		t.Fatal(err)
	}
	tasks := latest.Workspaces["space"].Tasks
	if checks != 7 || len(tasks) != 3 || tasks[0].AgentID != "developer" || tasks[0].Title != "Repair parser" ||
		tasks[1].Title != "Follow up" || tasks[1].Brief != "Draft a prospect follow-up" || tasks[2].AssigneeMemberID != "owner" {
		t.Fatalf("unexpected task writes after %d scope checks: %+v", checks, tasks)
	}
}
