package cowork

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDriveLifecycleAndIsolation(t *testing.T) {
	useTestPostgres(t)
	t.Setenv("COWORK_AUTH", "")
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	owner := Account{ID: key(), Workspace: key(), Name: "Owner"}
	teammate := Account{ID: key(), Workspace: owner.Workspace, Name: "Teammate"}
	outsider := Account{ID: key(), Workspace: key(), Name: "Outsider"}
	thread := Thread{ID: key()}
	space := &Workspace{ID: owner.Workspace, Owner: owner.ID, Role: "Developer", Threads: []Thread{thread}}
	space.Tasks = []Task{
		{ID: key(), Title: "Launch kit", Result: "Public handoff"},
		{ID: key(), Title: "Private planning", Result: "private words", PrivateMemberID: teammate.ID},
		{ID: key(), Title: "No deliverables"},
	}
	publicTask := &space.Tasks[0]
	publicTask.Artifacts = []Artifact{
		{Name: "Implementation plan", URL: "/api/artifact/" + publicTask.ID + "/plan.md"},
		{Name: "Sandbox preview", URL: "/api/artifact/" + publicTask.ID + "/preview"},
		{Name: "Legacy preview", URL: "https://sandbox.example/old"},
		{Name: "Pull request", URL: "https://github.com/example/work/pull/42"},
		{Name: "Unsafe link", URL: "javascript:alert(1)"},
	}
	d.Workspaces[space.ID] = space
	d.Workspaces[outsider.Workspace] = &Workspace{ID: outsider.Workspace, Owner: outsider.ID}
	for _, account := range []Account{owner, teammate, outsider} {
		d.Accounts[account.ID] = account
		d.Sessions[account.ID] = account.ID
	}
	if err := save(d); err != nil {
		t.Fatal(err)
	}

	call := func(method, path, session, grant string, input any, want int) *httptest.ResponseRecorder {
		t.Helper()
		body, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: "cowork_session", Value: session})
		w := httptest.NewRecorder()
		if strings.HasPrefix(path, "/internal/") {
			r.Header.Set("X-Cowork-Drive", grant)
			DriveWorker(w, r)
		} else {
			API(w, r)
		}
		if w.Code != want {
			t.Fatalf("%s %s got %d, want %d %s", method, path, w.Code, want, w.Body.String())
		}
		return w
	}
	decodeItem := func(w *httptest.ResponseRecorder) driveItem {
		t.Helper()
		var item driveItem
		if err := json.Unmarshal(w.Body.Bytes(), &item); err != nil {
			t.Fatal(err)
		}
		return item
	}

	folder := decodeItem(call("POST", "/api/drive/create", owner.ID, "", driveInput{Name: "Planning", Kind: "folder"}, 200))
	content := []byte("Launch date draft")
	file := decodeItem(call("POST", "/api/drive/create", teammate.ID, "", driveInput{Name: "Brief.md", Kind: "file", ParentID: folder.ID, Content: &content}, 200))
	if !file.Editable || file.Revision != 1 || file.Size != len(content) {
		t.Fatalf("unexpected file %+v", file)
	}
	call("POST", "/api/drive/create", owner.ID, "", driveInput{Name: "brief.md", Kind: "file", ParentID: folder.ID, Content: &content}, 409)
	call("POST", "/api/drive/create", outsider.ID, "", driveInput{Name: "other.md", Kind: "file", ParentID: folder.ID, Content: &content}, 404)
	call("GET", "/api/drive/read?id="+file.ID, outsider.ID, "", nil, 404)
	call("GET", "/api/drive/activity", teammate.ID, "", nil, 403)
	call("GET", "/api/drive/list", "", "", nil, 401)
	call("POST", "/api/drive/delete", owner.ID, "", driveInput{ID: folder.ID, Revision: folder.Revision}, 409)
	privateTaskID := space.Tasks[1].ID
	privateID := privateTaskID + ":result"
	root := call("GET", "/api/drive/list?area=artifacts", owner.ID, "", nil, 200)
	var tree struct {
		ArtifactFolders []driveArtifactFolder
		Artifacts       []driveArtifact
	}
	if err := json.Unmarshal(root.Body.Bytes(), &tree); err != nil {
		t.Fatal(err)
	}
	if len(tree.ArtifactFolders) != 1 || tree.ArtifactFolders[0].ID != publicTask.ID ||
		tree.ArtifactFolders[0].Count != 5 || len(tree.Artifacts) != 0 {
		t.Fatalf("expected one task folder grouping five artifacts, got %s", root.Body.String())
	}
	folderPath := "/api/drive/list?area=artifacts&parent="
	taskFiles := call("GET", folderPath+publicTask.ID, teammate.ID, "", nil, 200)
	for _, label := range []string{"Implementation plan", "Sandbox preview", "Legacy preview", "Pull request", "Task result"} {
		if !strings.Contains(taskFiles.Body.String(), label) {
			t.Errorf("task folder missed %s", label)
		}
	}
	legacyID := publicTask.ID + ":link-" + hashToken("https://sandbox.example/old")
	legacy := call("GET", "/api/drive/open?id="+legacyID, teammate.ID, "", nil, 307)
	if legacy.Header().Get("Location") != "https://sandbox.example/old" ||
		strings.Contains(taskFiles.Body.String(), "javascript:") {
		t.Fatal("historic HTTPS preview did not redirect safely")
	}
	call("GET", "/api/drive/open?id="+legacyID, outsider.ID, "", nil, 404)
	call("GET", folderPath+publicTask.ID, outsider.ID, "", nil, 404)
	call("GET", folderPath+privateTaskID, owner.ID, "", nil, 404)
	call("GET", folderPath+privateTaskID, teammate.ID, "", nil, 200)
	call("GET", "/api/drive/download?id="+privateID, owner.ID, "", nil, 404)
	call("GET", "/api/drive/download?id="+privateID, teammate.ID, "", nil, 200)
	dl := call("GET", "/api/drive/download?id="+file.ID, owner.ID, "", nil, 200)
	if dl.Body.String() != string(content) || !strings.HasPrefix(dl.Header().Get("Content-Disposition"), "attachment;") {
		t.Fatal("incorrect download")
	}
	agent := space.threadAgent(thread.ID)
	grant := newDriveGrant(space, teammate.ID, thread.ID, agent.ID, nil)
	call("POST", "/internal/drive/read", teammate.ID, grant+"x", driveInput{ID: file.ID}, 403)
	w := call("POST", "/internal/drive/list", "", grant, driveInput{Area: "all", Query: "draft"}, 200)
	if !strings.Contains(w.Body.String(), file.ID) {
		t.Fatal("text search missed the file")
	}
	call("POST", "/internal/drive/read", "", grant, driveInput{ID: privateID}, 404)
	call("POST", "/internal/drive/list", "", grant, driveInput{Area: "artifacts", ParentID: privateTaskID}, 404)
	agentFolder := call("POST", "/internal/drive/list", "", grant, driveInput{Area: "artifacts", ParentID: publicTask.ID}, 200)
	if !strings.Contains(agentFolder.Body.String(), "/preview") {
		t.Fatal("agent could not list the task's artifacts")
	}
	found := call("POST", "/internal/drive/list", "", grant, driveInput{Area: "all", Query: "handoff"}, 200)
	if !strings.Contains(found.Body.String(), space.Tasks[0].ID+":result") {
		t.Fatal("search missed the written result")
	}
	updated := "New launch date"
	next := decodeItem(call("POST", "/internal/drive/edit", "", grant, driveInput{ID: file.ID, Revision: file.Revision, Text: &updated}, 200))
	call("POST", "/api/drive/edit", owner.ID, "", driveInput{ID: file.ID, Revision: file.Revision, Name: "Stale name"}, 409)
	now := call("GET", "/api/drive/read?id="+file.ID, teammate.ID, "", nil, 200)
	if !strings.Contains(now.Body.String(), updated) {
		t.Fatal("member could not read agent's edit")
	}

	current, err := load()
	if err != nil || !current.AgentConnectionThreads[space.ID][thread.ID] {
		t.Fatal("agent access did not protect the conversation from guest invitations")
	}
	call("POST", "/api/drive/delete", owner.ID, "", driveInput{ID: file.ID, Revision: next.Revision}, 200)
	call("POST", "/api/drive/delete", owner.ID, "", driveInput{ID: folder.ID, Revision: folder.Revision}, 200)
	w = call("GET", "/api/drive/activity", owner.ID, "", nil, 200)
	var log struct{ Events []driveActivity }
	if err := json.Unmarshal(w.Body.Bytes(), &log); err != nil {
		t.Fatal(err)
	}
	edits := 0
	for _, event := range log.Events {
		if event.ItemID == privateID || event.ItemID == privateTaskID {
			t.Fatal("access log exposed another member's artifact")
		}
		if event.Action == "edit" {
			edits++
			if event.ActorID != teammate.ID || event.Source != "chat" || event.AgentName == "" || event.ItemID != file.ID {
				t.Fatalf("agent edit was not attributed correctly: %+v", event)
			}
		}
	}
	if edits != 1 || strings.Contains(w.Body.String(), updated) {
		t.Fatal("access log should record successful changes without their contents")
	}
}

func TestDriveWorkerRejectsGuestAndExpiredTaskLease(t *testing.T) {
	owner := Account{ID: key(), Workspace: key()}
	thread := Thread{ID: key()}
	space := &Workspace{ID: owner.Workspace, Owner: owner.ID, Role: "Developer", Threads: []Thread{thread}}
	d := emptyDatabase()
	d.Accounts[owner.ID] = owner
	d.Workspaces[space.ID] = space
	d.GuestGrants = map[string]guestGrant{"guest": {WorkspaceID: space.ID, ThreadID: thread.ID, Expires: time.Now().Add(time.Hour)}}
	agent := space.threadAgent(thread.ID)
	issued := newDriveGrant(space, owner.ID, thread.ID, agent.ID, nil)
	grant, ok := parseDriveGrant(issued)
	if !ok {
		t.Fatal("could not parse a valid grant")
	}
	if _, _, ok := authorizeDriveWorker(d, grant); ok {
		t.Fatal("guest-accessible conversation received Drive access")
	}
	delete(d.GuestGrants, "guest")
	now := time.Now()
	task := Task{ID: key(), ThreadID: thread.ID, MemoryMemberID: owner.ID, Status: "Running", WorkflowStarted: &now}
	space.Tasks = []Task{task}
	grant, _ = parseDriveGrant(newDriveGrant(space, owner.ID, thread.ID, agent.ID, &task))
	if _, _, ok := authorizeDriveWorker(d, grant); !ok {
		t.Fatal("active task run could not access Drive")
	}
	newRun := now.Add(time.Minute)
	space.Tasks[0].WorkflowStarted = &newRun
	if _, _, ok := authorizeDriveWorker(d, grant); ok {
		t.Fatal("old task run retained Drive access")
	}
}
