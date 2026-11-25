package cowork

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

const scheduledRunLease = 3 * time.Minute

func scheduleTask(w http.ResponseWriter, r *http.Request, d *database, a Account, space *Workspace) {
	var input struct {
		Title, Brief, ThreadID, TimeZone, Recurrence string
		Due                                          *time.Time
		DelaySeconds                                 int64
	}
	if !decode(w, r, &input) {
		return
	}
	if threadMessages(space, input.ThreadID) == nil {
		fail(w, 404, "Conversation not found.")
		return
	}
	title, brief := strings.TrimSpace(input.Title), strings.TrimSpace(input.Brief)
	if title == "" || len(title) > 120 || brief == "" || len(brief) > 6000 {
		fail(w, 400, "Enter a title and a task brief within the displayed limits.")
		return
	}
	if input.Recurrence != "" && (recurrenceDays(input.Recurrence) == 0 || input.Due == nil || input.DelaySeconds != 0) {
		fail(w, 400, "Choose a first run date and time for a daily or weekly schedule.")
		return
	}
	now := time.Now()
	var due time.Time
	switch {
	case input.Due != nil && input.DelaySeconds == 0:
		due = input.Due.UTC()
	case input.Due == nil && input.DelaySeconds > 0 && input.DelaySeconds <= 31536000:
		due = now.Add(time.Duration(input.DelaySeconds) * time.Second).UTC()
	}
	if !due.After(now) {
		fail(w, 400, "Choose a future date or a timer of up to one year.")
		return
	}
	location, err := time.LoadLocation(input.TimeZone)
	if err != nil || input.TimeZone == "Local" {
		location = time.UTC
	}
	task := Task{
		ID: key(), Title: title, Brief: brief, Author: a.Name, Status: "Scheduled",
		ThreadID: input.ThreadID, ScheduledFor: &due, ScheduledTimeZone: location.String(),
	}
	if input.Recurrence != "" {
		task.Recurrence, task.RecurrenceStart = input.Recurrence, &due
	}
	space.Tasks = append(space.Tasks, task)
	if err := save(d); err != nil {
		fail(w, 500, "Could not save scheduled task.")
		return
	}
	w.Header().Set("X-Cowork-Record-Id", task.ID)
	view(w, d, a)
}

func recurrenceDays(recurrence string) int {
	switch recurrence {
	case "daily":
		return 1
	case "weekly":
		return 7
	default:
		return 0
	}
}

func updateSchedule(w http.ResponseWriter, r *http.Request, d *database, a Account, space *Workspace) {
	var input struct {
		ID, Action, Title, Brief, Recurrence, LocalDue string
	}
	if !decode(w, r, &input) {
		return
	}
	for index := range space.Tasks {
		task := &space.Tasks[index]
		if task.ID != input.ID || task.RecurrenceStart == nil || task.ScheduledFor == nil || recurrenceDays(task.Recurrence) == 0 {
			continue
		}
		if task.Status == "Canceled" && input.Action == "cancel" {
			view(w, d, a)
			return
		}
		if task.Status != "Scheduled" && task.Status != "Paused" {
			fail(w, 409, "This schedule is no longer active.")
			return
		}
		now := time.Now()
		switch input.Action {
		case "pause":
			task.Status = "Paused"
		case "resume":
			if task.Status == "Paused" && !task.ScheduledFor.After(now) {
				next := nextOccurrence(*task, now)
				task.ScheduledFor = &next
			}
			task.Status = "Scheduled"
		case "cancel":
			task.Status = "Canceled"
		case "edit":
			title, brief := strings.TrimSpace(input.Title), strings.TrimSpace(input.Brief)
			if title == "" || len(title) > 120 || brief == "" || len(brief) > 6000 || recurrenceDays(input.Recurrence) == 0 {
				fail(w, 400, "Enter a title, a task brief, and a daily or weekly frequency.")
				return
			}
			if input.LocalDue != "" {
				const localFormat = "2006-01-02T15:04"
				location, err := time.LoadLocation(task.ScheduledTimeZone)
				if err != nil {
					fail(w, 400, "This schedule has an invalid time zone.")
					return
				}
				due, err := time.ParseInLocation(localFormat, input.LocalDue, location)
				if err != nil || due.Format(localFormat) != input.LocalDue || !due.After(now) {
					fail(w, 400, "Choose a valid future date and time in the schedule’s time zone.")
					return
				}
				due = due.UTC()
				task.ScheduledFor, task.RecurrenceStart = &due, &due
			} else if task.Recurrence != input.Recurrence {
				task.RecurrenceStart = task.ScheduledFor
			}
			task.Title, task.Brief, task.Recurrence = title, brief, input.Recurrence
		default:
			fail(w, 400, "Choose a schedule action.")
			return
		}
		if err := save(d); err != nil {
			if errors.Is(err, errStaleWorkspace) {
				fail(w, 409, "The workspace changed. Try again.")
			} else {
				fail(w, 500, "Could not save schedule changes.")
			}
			return
		}
		view(w, d, a)
		return
	}
	fail(w, 404, "Recurring schedule not found.")
}

// Use calendar dates in the schedule's time zone so offsets can change without drifting the scheduled hour.
func nextOccurrence(task Task, now time.Time) time.Time {
	location, err := time.LoadLocation(task.ScheduledTimeZone)
	if err != nil {
		location = time.UTC
	}
	start := task.RecurrenceStart.In(location)
	date := func(instant time.Time) time.Time {
		year, month, day := instant.In(location).Date()
		return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
	}
	firstDay, today, claimedDay := date(start), date(now), date(*task.ScheduledFor)
	interval := recurrenceDays(task.Recurrence)
	days := int((today.Unix() - firstDay.Unix()) / 86400)
	nextDay := today.AddDate(0, 0, -(days % interval))
	if !nextDay.After(claimedDay) {
		nextDay = claimedDay.AddDate(0, 0, interval)
	}
	atLocalTime := func(day time.Time) time.Time {
		year, month, dayOfMonth := day.Date()
		hour, minute, second := start.Clock()
		candidate := time.Date(year, month, dayOfMonth, hour, minute, second, start.Nanosecond(), location)
		// During a spring-forward gap, move forward by the gap if time.Date chose the earlier side.
		actualHour, actualMinute, actualSecond := candidate.Clock()
		wallDifference := (hour-actualHour)*3600 + (minute-actualMinute)*60 + second - actualSecond
		if date(candidate).Equal(day) && wallDifference > 0 {
			candidate = candidate.Add(time.Duration(wallDifference) * time.Second)
		}
		return candidate.UTC()
	}
	next := atLocalTime(nextDay)
	if !next.After(now) {
		next = atLocalTime(nextDay.AddDate(0, 0, interval))
	}
	return next
}

func init() {
	if strings.TrimSpace(os.Getenv("DATABASE_URL")) == "" {
		return
	}
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if err := runScheduledTask(); err != nil && !errors.Is(err, errStaleWorkspace) {
				log.Printf("Cowork scheduler: %v", err)
			}
		}
	}()
}

func nextScheduledTask(d *database, now time.Time) (*Workspace, *Task) {
	var selected *Task
	var workspace *Workspace
	for _, space := range d.Workspaces {
		for index := range space.Tasks {
			task := &space.Tasks[index]
			if task.ScheduledFor == nil || task.ScheduledFor.After(now) {
				continue
			}
			expired := task.Status == "Running" && task.ScheduledStarted != nil &&
				!task.ScheduledStarted.Add(scheduledRunLease).After(now)
			if (task.Status == "Scheduled" || expired) &&
				(selected == nil || task.ScheduledFor.Before(*selected.ScheduledFor)) {
				workspace, selected = space, task
			}
		}
	}
	return workspace, selected
}

func claimScheduledTask(now time.Time) (string, workerRequest, error) {
	mutex.Lock()
	defer mutex.Unlock()
	d, err := load()
	if err != nil {
		return "", workerRequest{}, err
	}
	space, task := nextScheduledTask(d, now)
	if task == nil {
		return "", workerRequest{}, nil
	}
	run := *task
	run.Status = "Running"
	run.ScheduledStarted = &now
	if task.RecurrenceStart != nil && recurrenceDays(task.Recurrence) > 0 {
		// Commit the next wake-up and the current run together so recovery cannot create another copy.
		next := nextOccurrence(*task, now)
		task.ScheduledFor = &next
		run.ID = key()
		run.Recurrence, run.RecurrenceStart = "", nil
		space.Tasks = append(space.Tasks, run)
	} else {
		*task = run
	}
	if err := save(d); err != nil {
		return "", workerRequest{}, err
	}
	return space.ID, workerRequest{Task: run, Role: space.Role, TimeZone: run.ScheduledTimeZone}, nil
}

func runScheduledTask() error {
	workspace, request, err := claimScheduledTask(time.Now().UTC())
	if err != nil || workspace == "" {
		return err
	}
	result, runErr := worker(context.Background(), "scheduled-task", request, "")
	if runErr != nil {
		result.Error = "The agent service was unavailable."
	}
	for range 3 {
		err = finishScheduledTask(workspace, request.Task, result)
		if !errors.Is(err, errStaleWorkspace) {
			break
		}
	}
	return err
}

func finishScheduledTask(workspace string, claim Task, result workerResponse) error {
	mutex.Lock()
	defer mutex.Unlock()
	d, err := load()
	if err != nil {
		return err
	}
	space := d.Workspaces[workspace]
	if space == nil {
		return nil
	}
	for index := range space.Tasks {
		task := &space.Tasks[index]
		if task.ID != claim.ID || task.Status != "Running" || task.ScheduledStarted == nil ||
			!task.ScheduledStarted.Equal(*claim.ScheduledStarted) {
			continue
		}
		task.ScheduledStarted = nil
		task.Status = "Ready for review"
		task.Result, task.Error = result.Reply, result.Error
		if result.Error != "" {
			task.Status = "Failed"
		}
		return save(d)
	}
	return nil
}
