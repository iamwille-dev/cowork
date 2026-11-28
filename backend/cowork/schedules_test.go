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

func TestNextDueTask(t *testing.T) {
	now := time.Date(2026, time.November, 24, 16, 0, 0, 0, time.UTC)
	future := now.Add(time.Minute)
	older := now.Add(-2 * time.Minute)
	recent := now.Add(-time.Minute)
	expired := now.Add(-taskRunLease)
	d := emptyDatabase()
	d.Workspaces["first"] = &Workspace{Tasks: []Task{
		{ID: "legacy", Status: "Running"},
		{ID: "future", Status: "Scheduled", ScheduledFor: &future},
		{ID: "complete", Status: "Ready for review", ScheduledFor: &older},
		{ID: "active", Status: "Running", ScheduledFor: &older, ScheduledStarted: &recent},
		{ID: "due", Status: "Scheduled", ScheduledFor: &now},
	}}
	d.Workspaces["second"] = &Workspace{Tasks: []Task{
		{ID: "interrupted", Status: "Running", ScheduledFor: &older, ScheduledStarted: &expired},
	}}

	space, task := nextTask(d, now)
	if space != d.Workspaces["second"] || task == nil || task.ID != "interrupted" {
		t.Fatalf("expected the oldest due task with an expired claim, got %+v", task)
	}
	task.Status = "Ready for review"
	space, task = nextTask(d, now)
	if space != d.Workspaces["first"] || task == nil || task.ID != "due" {
		t.Fatalf("expected the task due now, got %+v", task)
	}
	task.Status = "Failed"
	if _, task := nextTask(d, now); task != nil {
		t.Fatalf("expected no eligible tasks, got %+v", task)
	}
}

func TestNextOccurrence(t *testing.T) {
	for _, test := range []struct {
		name, recurrence, start, now, want string
	}{
		{"daily across spring change", "daily", "2026-03-07T09:00:00-06:00", "2026-03-07T09:00:00-06:00", "2026-03-08T09:00:00-05:00"},
		{"spring gap", "daily", "2026-03-07T02:30:00-06:00", "2026-03-07T02:30:00-06:00", "2026-03-08T03:30:00-05:00"},
		{"hour restored after spring gap", "daily", "2026-03-07T02:30:00-06:00", "2026-03-08T03:30:00-05:00", "2026-03-09T02:30:00-05:00"},
		{"weekly after downtime", "weekly", "2026-03-02T09:00:00-06:00", "2026-03-30T10:00:00-05:00", "2026-04-06T09:00:00-05:00"},
		{"weekly later today", "weekly", "2026-03-02T09:00:00-06:00", "2026-03-30T08:00:00-05:00", "2026-03-30T09:00:00-05:00"},
	} {
		t.Run(test.name, func(t *testing.T) {
			parse := func(value string) time.Time {
				instant, err := time.Parse(time.RFC3339, value)
				if err != nil {
					t.Fatal(err)
				}
				return instant
			}
			start := parse(test.start)
			task := Task{ScheduledFor: &start, RecurrenceStart: &start, Recurrence: test.recurrence, ScheduledTimeZone: "America/Chicago"}
			if got, want := nextOccurrence(task, parse(test.now)), parse(test.want); !got.Equal(want) {
				t.Fatalf("next run = %v, want %v", got, want)
			}
		})
	}
}

func TestRecurringScheduleCreatesSeparateRuns(t *testing.T) {
	useTestPostgres(t)
	allowTaskAssignments(t)
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	a := Account{ID: "owner", Name: "Owner", Workspace: "space"}
	space := &Workspace{ID: "space", Owner: a.ID, Role: "Product Manager"}
	d.Workspaces[space.ID] = space
	if err := save(d); err != nil {
		t.Fatal(err)
	}
	due := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	payload, err := json.Marshal(map[string]any{
		"Title": "Weekly draft", "Brief": "Draft a planning agenda.", "Due": due,
		"TimeZone": "America/Regina", "Recurrence": "weekly",
	})
	if err != nil {
		t.Fatal(err)
	}
	reply := httptest.NewRecorder()
	mutex.Lock()
	scheduleTask(reply, httptest.NewRequest("POST", "/api/task/schedule", strings.NewReader(string(payload))), d, a, space)
	mutex.Unlock()
	id := reply.Header().Get("X-Cowork-Record-Id")
	if reply.Code != http.StatusOK || id == "" {
		t.Fatalf("schedule response = %d %s", reply.Code, reply.Body.String())
	}
	lastRun := ""
	for _, at := range []time.Time{due, due.AddDate(0, 0, 7)} {
		dispatch, err := claimNextTask(at)
		run := dispatch.Task
		if err != nil || dispatch.WorkspaceID != space.ID || run.ID == "" || run.ID == id || run.ID == lastRun || run.Recurrence != "" || run.RunRecurrence != "weekly" {
			t.Fatalf("expected a separate run, got %+v, error %v", run, err)
		}
		if err := finishTaskRun(dispatch, workerResponse{Reply: "Agenda draft", Note: "Drafted the agenda."}, nil); err != nil {
			t.Fatal(err)
		}
		lastRun = run.ID
	}
	d, err = load()
	if err != nil {
		t.Fatal(err)
	}
	tasks := d.Workspaces[space.ID].Tasks
	if len(tasks) != 3 || tasks[0].Status != "Scheduled" || !tasks[0].ScheduledFor.Equal(due.AddDate(0, 0, 14)) ||
		tasks[1].Result != "Agenda draft" || tasks[2].Result != "Agenda draft" || len(tasks[0].Notes) != 0 ||
		len(tasks[1].Notes) != 1 || len(tasks[2].Notes) != 1 || tasks[2].Notes[0].Text != "Drafted the agenda." {
		t.Fatalf("expected two results and next week's schedule, got %+v", tasks)
	}
}

type scheduledWorkerTransport func(*http.Request) (*http.Response, error)

func (transport scheduledWorkerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestManageRecurringSchedule(t *testing.T) {
	useTestPostgres(t)
	allowTaskAssignments(t)
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	overdue := now.Add(-48 * time.Hour)
	d.Accounts["owner"] = Account{ID: "owner", Workspace: "space"}
	d.Sessions["session"] = "owner"
	d.Workspaces["space"] = &Workspace{ID: "space", Role: "Product Manager", Tasks: []Task{
		{ID: "recurring", Title: "Original", Status: "Scheduled", Recurrence: "daily", ScheduledFor: &overdue, RecurrenceStart: &overdue, ScheduledTimeZone: "America/Regina"},
		{ID: "one-time", Status: "Scheduled", ScheduledFor: &overdue},
		{ID: "one-time-cancel", Status: "Scheduled", ScheduledFor: &overdue},
	}}
	if err := save(d); err != nil {
		t.Fatal(err)
	}
	update := func(body string, status int) Task {
		t.Helper()
		req := httptest.NewRequest("POST", "/api/task/schedule/update", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "cowork_session", Value: "session"})
		res := httptest.NewRecorder()
		API(res, req)
		if res.Code != status {
			t.Fatalf("update %s returned %d: %s", body, res.Code, res.Body.String())
		}
		latest, err := load()
		if err != nil {
			t.Fatal(err)
		}
		return latest.Workspaces["space"].Tasks[0]
	}
	update(`{"ID":"one-time","Action":"pause"}`, http.StatusBadRequest)
	update(`{"ID":"one-time-cancel","Action":"cancel"}`, http.StatusOK)
	paused := update(`{"ID":"recurring","Action":"pause"}`, http.StatusOK)
	if paused.Status != "Paused" {
		t.Fatalf("expected paused schedule, got %+v", paused)
	}
	resumed := update(`{"ID":"recurring","Action":"resume"}`, http.StatusOK)
	if resumed.Status != "Scheduled" || !resumed.ScheduledFor.After(now) {
		t.Fatalf("expected resume to skip missed runs, got %+v", resumed)
	}
	update(`{"ID":"recurring","Action":"edit","Title":"Updated","Brief":"Updated brief","Recurrence":"weekly","LocalDue":"2000-01-01T09:00"}`, http.StatusBadRequest)
	location, err := time.LoadLocation("America/Regina")
	if err != nil {
		t.Fatal(err)
	}
	due := time.Now().In(location).Add(time.Hour).Truncate(time.Minute)
	edited := update(`{"ID":"recurring","Action":"edit","Title":"Updated","Brief":"Updated brief","Recurrence":"weekly","LocalDue":"`+
		due.Format("2006-01-02T15:04")+`"}`, http.StatusOK)
	if edited.Recurrence != "weekly" || edited.Title != "Updated" || edited.Brief != "Updated brief" || !edited.ScheduledFor.Equal(due) {
		t.Fatalf("expected updated schedule, got %+v", edited)
	}
	// The one-time task is older, so claim and finish it before testing the recurring run.
	for _, want := range []string{"one-time", "recurring"} {
		dispatch, err := claimNextTask(due)
		if err != nil || dispatch.WorkspaceID != "space" || dispatch.Task.ID == "" {
			t.Fatalf("expected a claim, got %+v, %v", dispatch, err)
		}
		if want == "recurring" {
			canceled := update(`{"ID":"recurring","Action":"cancel"}`, http.StatusOK)
			if canceled.Status != "Canceled" || dispatch.Task.Title != "Updated" || dispatch.Task.ID == canceled.ID {
				t.Fatalf("expected canceled schedule and independent run, got %+v and %+v", canceled, dispatch.Task)
			}
		} else if dispatch.Task.ID != want {
			t.Fatalf("expected one-time run, got %+v", dispatch)
		}
		if err := finishTaskRun(dispatch, workerResponse{Reply: "Finished"}, nil); err != nil {
			t.Fatal(err)
		}
	}
	update(`{"ID":"recurring","Action":"resume"}`, http.StatusConflict)
	if dispatch, err := claimNextTask(due.AddDate(0, 0, 14)); err != nil || dispatch.Task.ID != "" {
		t.Fatalf("canceled schedule dispatched again, workspace %q, error %v", dispatch.WorkspaceID, err)
	}
	latest, err := load()
	if err != nil {
		t.Fatal(err)
	}
	if tasks := latest.Workspaces["space"].Tasks; len(tasks) != 4 || tasks[2].Status != "Canceled" || tasks[3].Result != "Finished" {
		t.Fatalf("expected in-progress result to be saved, got %+v", tasks)
	}
}

func TestScheduledTaskPersistsAndRunsWithoutSession(t *testing.T) {
	useTestPostgres(t)
	allowTaskAssignments(t)
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	d.Accounts["owner"] = Account{ID: "owner", Name: "Owner", Workspace: "space"}
	d.Sessions["session"] = "owner"
	d.Workspaces["space"] = &Workspace{ID: "space", Owner: "owner", Role: "Product Manager"}
	if err := save(d); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", "/api/task/schedule", strings.NewReader(
		`{"Title":"Launch draft","Brief":"Write a launch announcement.","DelaySeconds":60,"TimeZone":"America/Regina"}`,
	))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(&http.Cookie{Name: "cowork_session", Value: "session"})
	reply := httptest.NewRecorder()
	API(reply, request)
	id := reply.Header().Get("X-Cowork-Record-Id")
	if reply.Code != http.StatusOK || id == "" {
		t.Fatalf("schedule response = %d %s", reply.Code, reply.Body.String())
	}
	d, err = load()
	if err != nil {
		t.Fatal(err)
	}
	task := d.Workspaces["space"].Tasks[0]
	if task.ID != id || task.Status != "Scheduled" || task.ScheduledFor == nil {
		t.Fatalf("expected a persisted timer, got %+v", task)
	}
	delete(d.Sessions, "session")
	if err := save(d); err != nil {
		t.Fatal(err)
	}

	dispatch, err := claimNextTask(*task.ScheduledFor)
	if err != nil || dispatch.WorkspaceID != "space" || dispatch.Task.ID != id {
		t.Fatalf("claim got workspace %q, task %q, error %v", dispatch.WorkspaceID, dispatch.Task.ID, err)
	}
	if duplicate, err := claimNextTask(*task.ScheduledFor); duplicate.Task.ID != "" || err != nil {
		t.Fatalf("duplicate claim got workspace %q, error %v", duplicate.Task.ID, err)
	}
	// Simulate an interrupted run so the scheduler can recover it on its next pass.
	d, err = load()
	if err != nil {
		t.Fatal(err)
	}
	expired := time.Now().Add(-taskRunLease - time.Minute)
	stored := &d.Workspaces["space"].Tasks[0]
	stored.ScheduledFor, stored.ScheduledStarted = &expired, &expired
	if err := save(d); err != nil {
		t.Fatal(err)
	}
	previous := workerClient
	t.Cleanup(func() { workerClient = previous })
	calls := 0
	workerClient = &http.Client{Transport: scheduledWorkerTransport(func(request *http.Request) (*http.Response, error) {
		calls++
		var input workerRequest
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			return nil, err
		}
		if request.URL.Path != "/scheduled-task" || request.Header.Get("X-Cowork-Session") != "" ||
			input.Role != "Product Manager" || input.TimeZone != "America/Regina" || input.Task.Brief != task.Brief {
			t.Errorf("unexpected scheduled worker request: %+v", input)
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"Reply":"The launch is here."}`))}, nil
	})}
	for range 2 {
		dispatch, err := claimNextTask(time.Now().UTC())
		if err != nil {
			t.Fatal(err)
		}
		if dispatch.Task.ID != "" {
			if err := executeTaskRun(dispatch, false); err != nil {
				t.Fatal(err)
			}
		}
	}
	d, err = load()
	if err != nil {
		t.Fatal(err)
	}
	task = d.Workspaces["space"].Tasks[0]
	if calls != 1 || task.Status != "Ready for review" || task.Result != "The launch is here." {
		t.Fatalf("expected one dispatch and a saved result, got %d calls and %+v", calls, task)
	}
}
