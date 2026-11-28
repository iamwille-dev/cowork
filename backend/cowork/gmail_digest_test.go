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

func TestGmailDigestScheduleKeepsResultsPrivateAndRechecksGrant(t *testing.T) {
	useTestPostgres(t)
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	mail := strings.Repeat("m", 40)
	d.Accounts["owner"] = Account{ID: "owner", Workspace: "space"}
	d.Accounts["member"] = Account{ID: "member", Workspace: "space"}
	d.Sessions["owner"], d.Sessions["member"] = "owner", "member"
	space := &Workspace{ID: "space", Owner: "owner", Role: "Product Manager", AgentConnectionEnabled: true,
		Agents:  []workspaceAgent{{ID: "product-manager", Role: "Product Manager", ConnectionIDs: []string{mail, "other"}}},
		Threads: []Thread{{ID: "thread", AgentID: "product-manager"}}}
	d.Workspaces[space.ID] = space
	if err := save(d); err != nil {
		t.Fatal(err)
	}
	previous := workerClient
	t.Cleanup(func() { workerClient = previous })
	var checks, runs int
	workerClient = &http.Client{Transport: scheduledWorkerTransport(func(r *http.Request) (*http.Response, error) {
		var request workerRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if request.AgentConnectionWorkspace != "space" || request.AgentConnectionIDs == nil ||
			len(*request.AgentConnectionIDs) != 1 || (*request.AgentConnectionIDs)[0] != mail ||
			request.Task.GmailConnectionID != mail || request.Task.ThreadID != "" || len(request.AgentMemory) != 0 {
			t.Fatalf("unexpected Gmail access: %+v", request)
		}
		body := `{"ScopeAllowed":true}`
		switch r.URL.Path {
		case "/gmail-digest-check":
			checks++
		case "/gmail-digest":
			runs++
			body = `{"Reply":"Private inbox digest","Note":"Summarized the inbox."}`
		default:
			t.Fatalf("unexpected worker request %q", r.URL.Path)
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	request := func(session, route, body string, want int) *httptest.ResponseRecorder {
		t.Helper()
		method := http.MethodPost
		if body == "" {
			method = http.MethodGet
		}
		r := httptest.NewRequest(method, "/api/"+route, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: "cowork_session", Value: session})
		response := httptest.NewRecorder()
		API(response, r)
		if response.Code != want {
			t.Fatalf("%s %s = %d, want %d: %s", session, route, response.Code, want, response.Body)
		}
		return response
	}
	due := time.Now().UTC().Add(time.Hour)
	body, err := json.Marshal(taskSchedule{Title: "Gmail digest", Brief: "Summarize unread mail.", ThreadID: "thread", Recurrence: "daily", Due: &due, GmailConnectionID: mail})
	if err != nil {
		t.Fatal(err)
	}
	request("member", "task/schedule", string(body), 403)
	schedule := request("owner", "task/schedule", string(body), 200).Header().Get("X-Cowork-Record-Id")
	dispatch, err := claimNextTask(due)
	if err != nil || dispatch.Task.RunRecurrence != "daily" || dispatch.Task.PrivateMemberID != "owner" {
		t.Fatalf("expected private recurring instance, got %+v, %v", dispatch.Task, err)
	}
	if err := executeTaskRun(dispatch, false); err != nil {
		t.Fatal(err)
	}
	if result := request("owner", "workspace", "", 200).Body.String(); !strings.Contains(result, "Private inbox digest") || !strings.Contains(result, "Summarized the inbox.") {
		t.Fatalf("owner could not read the result: %s", result)
	}
	for _, list := range []*httptest.ResponseRecorder{
		request("member", "workspace", "", 200),
		request("member", "task/find", `{"Query":"Gmail digest"}`, 200),
	} {
		if strings.Contains(list.Body.String(), "Gmail digest") || strings.Contains(list.Body.String(), "Private inbox digest") {
			t.Fatal("private Gmail task appeared in a member response")
		}
	}
	request("member", "task/schedule/update", `{"ID":"`+schedule+`","Action":"cancel"}`, 404)
	request("member", "task/update", `{"ID":"`+dispatch.Task.ID+`","ExpectedStatus":"Ready for review","Status":"Completed"}`, 404)
	request("owner", "agent-grants", `{"Grants":{"product-manager":[]}}`, 200)
	revoked, err := claimNextTask(due.AddDate(0, 0, 1))
	if err != nil || revoked.Task.ID == "" || revoked.AgentConnectionWorkspace != "" {
		t.Fatalf("expected a run without the revoked grant, got %+v, %v", revoked.Task, err)
	}
	if err := executeTaskRun(revoked, false); err != nil {
		t.Fatal(err)
	}
	if result := request("owner", "workspace", "", 200).Body.String(); !strings.Contains(result, "Gmail access changed") {
		t.Fatalf("owner could not see the revoked grant failure: %s", result)
	}
	if checks != 1 || runs != 1 {
		t.Fatalf("unexpected Gmail dispatches: %d checks, %d runs", checks, runs)
	}
}
