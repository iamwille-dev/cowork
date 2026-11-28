package cowork

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSandboxPreviewRequiresWorkspaceAccess(t *testing.T) {
	useTestPostgres(t)
	t.Setenv("COWORK_AUTH", "")
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	id := key()
	path := "/api/artifact/" + id + "/preview"
	d.Accounts["owner"] = Account{ID: "owner", Workspace: "space"}
	d.Accounts["outsider"] = Account{ID: "outsider", Workspace: "other"}
	d.Sessions["owner-session"], d.Sessions["outside-session"] = "owner", "outsider"
	d.Workspaces["space"] = &Workspace{ID: "space", Tasks: []Task{{
		ID: id, Title: "Update API", Artifacts: []Artifact{{Name: "Sandbox preview", URL: path}},
	}}}
	d.Workspaces["other"] = &Workspace{ID: "other"}
	if err := save(d); err != nil {
		t.Fatal(err)
	}
	previous := workerClient
	t.Cleanup(func() { workerClient = previous })
	calls := 0
	const destination = "https://sandbox.example/fresh"
	workerClient = &http.Client{Transport: scheduledWorkerTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host != "127.0.0.1:4401" || r.URL.Path != strings.TrimPrefix(path, "/api") {
			t.Fatalf("unexpected preview request to %s", r.URL)
		}
		return &http.Response{StatusCode: http.StatusTemporaryRedirect, Header: http.Header{"Location": {destination}}, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	for session, status := range map[string]int{"": 401, "outside-session": 404, "owner-session": 307} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.AddCookie(&http.Cookie{Name: "cowork_session", Value: session})
		reply := httptest.NewRecorder()
		API(reply, r)
		if reply.Code != status || (status == 307 && reply.Header().Get("Location") != destination) {
			t.Fatalf("preview for %q returned %d %s", session, reply.Code, reply.Body.String())
		}
	}
	if calls != 1 {
		t.Fatalf("expected only the authorized request to reach the preview worker, got %d", calls)
	}
	found := httptest.NewRecorder()
	replyBoardTaskMatches(found, d.Workspaces["space"], "owner", id)
	var result struct{ Tasks []struct{ PreviewURL string } }
	if err := json.Unmarshal(found.Body.Bytes(), &result); err != nil || len(result.Tasks) != 1 || result.Tasks[0].PreviewURL != path {
		t.Fatalf("task lookup did not return the stable preview URL: %s", found.Body.String())
	}
}

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
