package cowork

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestPersonalAgentMemory(t *testing.T) {
	useTestPostgres(t)
	t.Setenv("COWORK_AUTH", "local")
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	space := &Workspace{ID: "space", Role: "Developer", Owner: "owner",
		Threads: []Thread{{ID: "another-chat"}, {ID: "sales-chat", AgentID: "sales-lead"}, {ID: "with-guest"}},
		Agents:  []workspaceAgent{{Role: "Developer", Name: "Developer agent"}, {ID: "sales-lead", Role: "Sales Lead"}},
	}
	d.Workspaces[space.ID] = space
	d.GuestGrants = map[string]guestGrant{"guest": {WorkspaceID: space.ID, ThreadID: "with-guest", Expires: time.Now().Add(time.Hour)}}
	for _, id := range []string{"owner", "member"} {
		d.Accounts[id] = Account{ID: id, Name: id, Workspace: space.ID}
		d.Sessions[id] = id
	}
	if err := save(d); err != nil {
		t.Fatal(err)
	}

	request := func(session, path, body string, want int) string {
		t.Helper()
		method := http.MethodPost
		if body == "" {
			method = http.MethodGet
		}
		r := httptest.NewRequest(method, "/api/"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: "cowork_session", Value: session})
		response := httptest.NewRecorder()
		API(response, r)
		if response.Code != want {
			t.Fatalf("%s %s = %d, want %d: %s", method, path, response.Code, want, response.Body)
		}
		return response.Body.String()
	}
	memoryFrom := func(response, agent string) agentMemory {
		t.Helper()
		var view struct{ AgentMemories map[string]agentMemory }
		if err := json.Unmarshal([]byte(response), &view); err != nil {
			t.Fatal(err)
		}
		return view.AgentMemories[agent]
	}
	const learned = "Prefers bullet points"
	var sent workerRequest
	var nextItems *[]string
	var whileReplying func()
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	http.DefaultTransport = scheduledWorkerTransport(func(r *http.Request) (*http.Response, error) {
		sent = workerRequest{}
		if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
			return nil, err
		}
		if whileReplying != nil {
			whileReplying()
		}
		reply, err := json.Marshal(workerResponse{Reply: "Ready.", AgentMemory: nextItems})
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(string(reply)))}, err
	})

	request("", "agent/memory", `{"ID":"","Items":["unauthorized"]}`, http.StatusUnauthorized)
	request("member", "agent/memory", `{"ID":"missing-agent","Items":["wrong agent"]}`, http.StatusConflict)
	request("member", "agent/memory", `{"ID":"","Items":["one\ntwo"]}`, http.StatusBadRequest)
	request("member", "agent/memory", `{"ID":"sales-lead","Items":["  Prefers monthly reports  ","Prefers monthly reports"]}`, http.StatusOK)

	nextItems = &[]string{learned}
	first := request("member", "chat", `{"Text":"Remember that I prefer bullet points."}`, http.StatusOK)
	if len(sent.AgentMemory) != 0 || !strings.Contains(first, "Agent memory updated.") {
		t.Fatalf("expected empty initial memory and a confirmed update: sent=%v response=%s", sent.AgentMemory, first)
	}
	saved := memoryFrom(first, "")
	if !slices.Equal(saved.Items, []string{learned}) || saved.Revision == "" || strings.Contains(first, `"AgentMemories":`) {
		t.Fatalf("unexpected memory state: %+v", saved)
	}
	nextItems = nil
	request("member", "chat", `{"ThreadID":"another-chat","Text":"Draft a summary."}`, http.StatusOK)
	if !slices.Equal(sent.AgentMemory, []string{learned}) {
		t.Fatalf("new conversation did not load this member's memory: %v", sent.AgentMemory)
	}
	request("member", "task/schedule", `{"Title":"Write a summary","Brief":"Draft next week's summary.","TimeZone":"UTC","DelaySeconds":60}`, http.StatusOK)
	_, scheduled, err := claimScheduledTask(time.Now().Add(2 * time.Minute))
	if err != nil || !slices.Equal(scheduled.AgentMemory, []string{learned}) {
		t.Fatalf("scheduled run did not load the requesting member's memory: %v, %v", scheduled.AgentMemory, err)
	}
	request("member", "chat", `{"ThreadID":"sales-chat","Text":"Draft a summary."}`, http.StatusOK)
	if !slices.Equal(sent.AgentMemory, []string{"Prefers monthly reports"}) {
		t.Fatalf("chat loaded the wrong agent's memory: %v", sent.AgentMemory)
	}
	owner := request("owner", "chat", `{"ThreadID":"another-chat","Text":"Draft a summary."}`, http.StatusOK)
	if len(sent.AgentMemory) != 0 || strings.Contains(owner, learned) || strings.Contains(owner, "Prefers monthly reports") {
		t.Fatalf("another member's memory was exposed: sent=%v response=%s", sent.AgentMemory, owner)
	}
	nextItems = &[]string{"Guest-accessible memory"}
	guestChat := request("member", "chat", `{"ThreadID":"with-guest","Text":"Draft a summary."}`, http.StatusOK)
	if len(sent.AgentMemory) != 0 || strings.Contains(guestChat, "Guest-accessible memory") {
		t.Fatal("personal memory was used or updated in a guest-accessible conversation")
	}

	whileReplying = func() {
		request("member", "agent/memory", `{"ID":"","Revision":"`+saved.Revision+`","Items":[]}`, http.StatusOK)
	}
	nextItems = &[]string{"An outdated change"}
	raced := request("member", "chat", `{"Text":"Update my preferences."}`, http.StatusOK)
	if memory := memoryFrom(raced, ""); len(memory.Items) != 0 || memory.Revision == saved.Revision {
		t.Fatalf("an in-flight reply overwrote a more recent edit: %+v", memory)
	}
	request("member", "agent/memory", `{"ID":"","Revision":"`+saved.Revision+`","Items":["stale browser"]}`, http.StatusConflict)
}
