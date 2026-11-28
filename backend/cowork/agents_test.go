package cowork

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestManageWorkspaceAgents(t *testing.T) {
	useTestPostgres(t)
	allowTaskAssignments(t)
	t.Setenv("COWORK_AUTH", "local")
	t.Setenv("MASTRA_ENCRYPTION_KEY", strings.Repeat("a", 48))
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	workspaceID := key()
	d.Workspaces[workspaceID] = &Workspace{ID: workspaceID, Role: "Developer", Owner: "owner", AgentConnectionEnabled: true,
		Threads: []Thread{{ID: "existing-thread", Title: "Existing conversation"}}}
	for _, id := range []string{"owner", "member"} {
		email := id + "@example.test"
		d.Accounts[email] = Account{ID: id, Email: email, Workspace: workspaceID}
		d.Sessions[id] = email
	}
	if err := save(d); err != nil {
		t.Fatal(err)
	}
	post := func(session, path, body string, want int) {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, "/api/"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: "cowork_session", Value: session})
		response := httptest.NewRecorder()
		API(response, r)
		if response.Code != want {
			t.Fatalf("POST %s returned %d, want %d: %s", path, response.Code, want, response.Body)
		}
	}
	const sales = `{"ID":"sales-lead","Name":"  Taylor  ","Channel":"slack","ConnectionIDs":["ignored"]}`
	post("", "agent/add", sales, http.StatusUnauthorized)
	post("member", "agent/add", sales, http.StatusForbidden)
	post("owner", "agent/add", `{"ID":"developer"}`, http.StatusConflict)
	post("owner", "agent/add", `{"ID":"unknown"}`, http.StatusBadRequest)
	post("owner", "agent/add", `{"ID":"sales-lead","Name":"Invalid\nName"}`, http.StatusBadRequest)
	post("owner", "agent/add", `{"ID":"social-media","Channel":"discord"}`, http.StatusBadRequest)
	post("owner", "agent/add", sales, http.StatusOK)
	post("owner", "agent/add", sales, http.StatusOK)
	post("owner", "agent/add", `{"ID":"sales-lead","Name":"Different"}`, http.StatusConflict)
	post("member", "thread", `{"Text":"Sales follow-up","AgentID":"sales-lead"}`, http.StatusOK)
	post("member", "thread", `{"AgentID":"sales-lead"}`, http.StatusOK)
	post("member", "task", `{"Title":"Check pipeline","Brief":"Write a summary","Assignee":"agent:sales-lead"}`, http.StatusOK)
	d, err = load()
	if err != nil {
		t.Fatal(err)
	}
	space := d.Workspaces[workspaceID]
	if len(space.Agents) != 2 || space.threadAgent("existing-thread").ID != "" || space.threadAgent("existing-thread").Name != "Developer agent" {
		t.Fatalf("original agent changed: %#v", space.Agents)
	}
	if added := space.threadAgent(space.Threads[1].ID); added.ID != "sales-lead" || added.Name != "Taylor" || added.Role != "Sales Lead" || len(added.ConnectionIDs) != 0 {
		t.Fatalf("unexpected new thread agent: %#v", added)
	}
	if space.Threads[1].Title != "Sales follow-up" || space.Threads[2].Title != "Chat with Taylor" || space.Threads[2].AgentID != "sales-lead" {
		t.Fatalf("conversation titles or assignment did not persist: %#v", space.Threads)
	}
	if added, ok := slackAgent(space, "sam"); !ok || added.ID != "sales-lead" {
		t.Fatalf("Slack agent has not been enabled for sync: %#v", added)
	}
	if task := space.Tasks[0]; task.AgentID != "sales-lead" || task.AgentRole != "Sales Lead" {
		t.Fatalf("unexpected task assignee: %#v", task)
	}
	channelContext := func(agent string) workerRequest {
		t.Helper()
		body, err := json.Marshal(channelActor{WorkspaceID: workspaceID, Channel: "slack", Agent: agent, Installation: "test", SenderID: "test"})
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodPost, "/internal/channel-tools/context", strings.NewReader(string(body)))
		r.Header.Set("Authorization", "Bearer "+channelBridgeSecret("slack"))
		response := httptest.NewRecorder()
		ChannelToolBridge(response, r)
		var context workerRequest
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &context) != nil {
			t.Fatalf("could not get context for %s: %s", agent, response.Body)
		}
		return context
	}
	if original := channelContext("ada"); original.AgentConnectionIDs != nil || original.AgentConnectionWorkspace != workspaceID {
		t.Fatal("the original agent lost access to workspace tools")
	}
	if added := channelContext("sam"); added.AgentConnectionIDs == nil || len(*added.AgentConnectionIDs) != 0 || added.AgentConnectionWorkspace != "" {
		t.Fatal("the new agent inherited workspace tools")
	}

	const edit = `{"ID":"sales-lead","Name":"  Morgan ","Channel":"telegram","Role":"Developer","ConnectionIDs":[]}`
	post("", "agent/update", edit, http.StatusUnauthorized)
	post("member", "agent/update", edit, http.StatusForbidden)
	post("owner", "agent/update", `{"ID":"developer","Name":"Morgan"}`, http.StatusNotFound)
	post("owner", "agent/update", `{"ID":"sales-lead","Channel":"other"}`, http.StatusBadRequest)
	post("owner", "agent/update", `{"ID":"sales-lead","Name":"Invalid\nName"}`, http.StatusBadRequest)
	post("owner", "agent/add", `{"ID":"social-media"}`, http.StatusOK)
	post("owner", "agent/update", `{"ID":"social-media","Channel":"telegram"}`, http.StatusOK)
	const connectionID = "abcdefghijklmnopqrstuvwxyz0123456789"
	post("owner", "agent-grants", `{"Grants":{"sales-lead":["`+connectionID+`"]}}`, http.StatusOK)
	post("owner", "agent/update", edit, http.StatusOK)
	post("owner", "agent/update", edit, http.StatusOK)
	if changed := channelContext("sam"); changed.AgentName != "Morgan" || changed.Role != "Sales Lead" ||
		changed.AgentConnectionIDs == nil || len(*changed.AgentConnectionIDs) != 1 || (*changed.AgentConnectionIDs)[0] != connectionID {
		t.Fatalf("channel context did not retain the agent's identity and tools: %#v", changed)
	}
	d, err = load()
	if err != nil {
		t.Fatal(err)
	}
	space = d.Workspaces[workspaceID]
	if updated := space.threadAgent(space.Threads[1].ID); updated.ID != "sales-lead" || updated.Name != "Morgan" || updated.Channel != "telegram" {
		t.Fatalf("existing conversation did not retain its updated agent: %#v", updated)
	}
	if _, ok := slackAgent(space, "sam"); ok {
		t.Fatal("Slack still mirrors threads after switching the preferred channel")
	}
	if task := space.Tasks[0]; task.AgentID != "sales-lead" || task.AgentRole != "Sales Lead" {
		t.Fatalf("task lost its assigned agent after the edit: %#v", task)
	}

	post("owner", "agent/update", `{"ID":"sales-lead","Channel":"slack"}`, http.StatusOK)
	post("owner", "agent/update", `{"ID":"sales-lead","Name":""}`, http.StatusOK)
	d, err = load()
	if err != nil {
		t.Fatal(err)
	}
	if updated, ok := slackAgent(d.Workspaces[workspaceID], "sam"); !ok || updated.Name != "Sales Lead" {
		t.Fatalf("resetting the name changed the agent's preferred channel: %#v", updated)
	}
}

func TestRemoveWorkspaceAgent(t *testing.T) {
	useTestPostgres(t)
	t.Setenv("COWORK_AUTH", "local")
	t.Setenv("MASTRA_ENCRYPTION_KEY", strings.Repeat("a", 48))
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	workspaceID, guestSessionToken := key(), key()
	for _, id := range []string{"owner", "member"} {
		email := id + "@example.test"
		d.Accounts[email] = Account{ID: id, Email: email, Workspace: workspaceID}
		d.Sessions[id] = email
	}
	now := time.Now().UTC()
	past, future := now.Add(-time.Hour), now.Add(time.Hour)
	d.Workspaces[workspaceID] = &Workspace{
		ID: workspaceID, Owner: "owner", Role: "Developer",
		Agents: []workspaceAgent{{ID: "developer", Role: "Developer", Name: "Ada", Channel: "slack", ConnectionIDs: []string{"old-access"}},
			{ID: "sales-lead", Role: "Sales Lead", Name: "Sam"}},
		Threads: []Thread{{ID: "old-chat", Title: "Existing conversation", AgentID: "developer", Messages: []Message{{Text: "Keep this message"}}},
			{ID: "old-slack", AgentID: "developer", Slack: &slackThread{Installation: "install", Conversation: "slack:C123:123.456"}},
			{ID: "old-telegram", AgentID: "developer", TelegramTopic: "ada:group"}},
		Tasks: []Task{{ID: "planned", AgentID: "developer", AgentRole: "Developer", Status: "Assigned"},
			{ID: "scheduled", AgentID: "developer", AgentRole: "Developer", Status: "Scheduled", ScheduledFor: &future},
			{ID: "paused", AgentID: "developer", AgentRole: "Developer", Status: "Paused", ScheduledFor: &future},
			{ID: "expired", AgentID: "developer", AgentRole: "Developer", Status: "Running", ScheduledFor: &past, ScheduledStarted: &past},
			{ID: "other", AgentID: "sales-lead", AgentRole: "Sales Lead", Status: "Scheduled", ScheduledFor: &future}},
	}
	d.TelegramBots = map[string]telegramBot{telegramBotKey(workspaceID, "ada"): {Version: "ada-install", Destination: "-1001"},
		telegramBotKey(workspaceID, "sam"): {Version: "sam-install", Destination: "-1002"}}
	d.GuestGrants = map[string]guestGrant{"invite": {WorkspaceID: workspaceID, ThreadID: "old-chat", SessionHash: hashToken(guestSessionToken), Expires: future}}
	if err := save(d); err != nil {
		t.Fatal(err)
	}
	request := func(method, path, cookie, session, body string, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, "/api/"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: cookie, Value: session})
		response := httptest.NewRecorder()
		API(response, r)
		if response.Code != want {
			t.Fatalf("%s %s returned %d, want %d: %s", method, path, response.Code, want, response.Body)
		}
		return response
	}
	post := func(session, path, body string, want int) {
		t.Helper()
		request(http.MethodPost, path, "cowork_session", session, body, want)
	}
	const removal = `{"ID":"developer"}`
	post("", "agent/remove", removal, http.StatusUnauthorized)
	post("member", "agent/remove", removal, http.StatusForbidden)
	post("owner", "agent/remove", removal, http.StatusOK)
	post("owner", "agent/remove", removal, http.StatusNotFound)
	post("owner", "agent/remove", `{"ID":"sales-lead"}`, http.StatusConflict)
	post("member", "thread", `{"Text":"Use removed agent","AgentID":"developer"}`, http.StatusBadRequest)
	post("member", "chat", `{"ThreadID":"old-chat","Text":"Hello"}`, http.StatusConflict)
	post("owner", "telegram", `{"Agent":"ada","Destination":"-1001"}`, http.StatusConflict)
	guestView := request(http.MethodGet, "guest/conversation", "cowork_guest", guestSessionToken, "", http.StatusOK)
	if !strings.Contains(guestView.Body.String(), `"readOnly":true`) || !strings.Contains(guestView.Body.String(), "Keep this message") {
		t.Fatalf("guest history was not preserved: %s", guestView.Body)
	}
	request(http.MethodPost, "guest/chat", "cowork_guest", guestSessionToken, `{"Text":"Hello"}`, http.StatusConflict)
	actor := channelActor{WorkspaceID: workspaceID, Agent: "ada", Channel: "slack", SenderID: "user", Installation: "install", Conversation: "slack:C123:123.456"}
	checkSlack := func(want int) {
		t.Helper()
		body, err := json.Marshal(actor)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodPost, "/internal/channel-tools/available", strings.NewReader(string(body)))
		r.Header.Set("Authorization", "Bearer "+channelBridgeSecret("slack"))
		response := httptest.NewRecorder()
		ChannelToolBridge(response, r)
		if response.Code != want {
			t.Fatalf("Slack agent availability returned %d, want %d: %s", response.Code, want, response.Body)
		}
	}
	checkSlack(http.StatusForbidden)
	if workspace, _, err := claimScheduledTask(now); err != nil || workspace != "" {
		t.Fatalf("scheduler recovered a removed agent's run: %q, %v", workspace, err)
	}
	post("owner", "agent/add", `{"ID":"developer","Name":"New Ada","Channel":"slack"}`, http.StatusOK)
	post("member", "chat", `{"ThreadID":"old-chat","Text":"Hello"}`, http.StatusConflict)
	checkSlack(http.StatusOK)
	oldID := "developer"
	actor.AgentInstance = &oldID
	checkSlack(http.StatusForbidden)
	d, err = load()
	if err != nil {
		t.Fatal(err)
	}
	space := d.Workspaces[workspaceID]
	if len(space.Agents) != 2 || space.Role != "Sales Lead" || space.Agents[1].Role != "Developer" || space.Agents[1].ID == oldID || len(space.Agents[1].ConnectionIDs) != 0 {
		t.Fatalf("replacement or default agent is incorrect: %#v", space.Agents)
	}
	if len(space.Threads) != 3 || space.Threads[0].AgentID != oldID || boundSlackThread(space, actor) != nil {
		t.Fatalf("old threads were changed or reassigned: %#v", space.Threads)
	}
	if _, exists := d.TelegramBots[telegramBotKey(workspaceID, "ada")]; exists || d.TelegramBots[telegramBotKey(workspaceID, "sam")].Version != "sam-install" {
		t.Fatal("removal should disconnect only the selected agent's Telegram bot")
	}
	if space.Tasks[0].AgentID != oldID || space.Tasks[0].Status != "Assigned" || space.Tasks[1].Status != "Canceled" ||
		space.Tasks[2].Status != "Canceled" || space.Tasks[3].Status != "Canceled" || space.Tasks[4].Status != "Scheduled" {
		t.Fatalf("unexpected task history or schedule statuses: %#v", space.Tasks)
	}
}
