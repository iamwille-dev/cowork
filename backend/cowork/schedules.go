package cowork

import (
	"context"
	"net/http"
	"strings"
	"time"
)

type taskSchedule struct {
	Title, Brief, ThreadID, TimeZone, Recurrence, Assignee string
	Due                                                    *time.Time
	DelaySeconds                                           int64
}

func scheduleTask(w http.ResponseWriter, r *http.Request, d *database, a Account, space *Workspace) {
	var input taskSchedule
	if !decode(w, r, &input) {
		return
	}
	saveTaskSchedule(r.Context(), w, d, a, space, input, space.threadAgent(input.ThreadID))
}

func saveTaskSchedule(ctx context.Context, w http.ResponseWriter, d *database, a Account, space *Workspace, input taskSchedule, fallback workspaceAgent) {
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
	if input.Assignee == "" && space.threadHasRemovedAgent(input.ThreadID) {
		fail(w, http.StatusBadRequest, "Select an active agent for the scheduled run.")
		return
	}
	agent, member, ok := taskAssignee(d, space, input.Assignee, fallback)
	if !ok || member != "" {
		fail(w, 400, "Select an agent in this workspace for the scheduled run.")
		return
	}
	task := Task{
		ID: key(), Title: title, Brief: brief, Author: a.Name, Status: "Scheduled",
		MemoryMemberID: a.ID,
		ThreadID:       input.ThreadID, AgentID: agent.ID, AgentRole: agent.Role, ScheduledFor: &due, ScheduledTimeZone: location.String(),
	}
	if input.Recurrence != "" {
		task.Recurrence, task.RecurrenceStart = input.Recurrence, &due
	}
	if !validateTaskAssignment(ctx, w, agent.Role, task) {
		return
	}
	space.Tasks = append(space.Tasks, task)
	if !saveTaskChange(w, d, "Could not save scheduled task.") {
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
		if task.ID != input.ID || task.ScheduledFor == nil || task.RunRecurrence != "" {
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
			if task.RecurrenceStart == nil {
				fail(w, 400, "Only recurring schedules can be paused.")
				return
			}
			task.Status = "Paused"
		case "resume":
			if task.RecurrenceStart == nil {
				fail(w, 400, "Only recurring schedules can be resumed.")
				return
			}
			if task.Status == "Paused" && !task.ScheduledFor.After(now) {
				next := nextOccurrence(*task, now)
				task.ScheduledFor = &next
			}
			task.Status = "Scheduled"
		case "cancel":
			task.Status = "Canceled"
		case "edit":
			title, brief := strings.TrimSpace(input.Title), strings.TrimSpace(input.Brief)
			if title == "" || len(title) > 120 || brief == "" || len(brief) > 6000 || (input.Recurrence != "" && recurrenceDays(input.Recurrence) == 0) {
				fail(w, 400, "Enter a title, a task brief, and a valid frequency.")
				return
			}
			updated := *task
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
				updated.ScheduledFor = &due
			}
			if input.Recurrence == "" {
				updated.RecurrenceStart = nil
			} else if input.LocalDue != "" || task.Recurrence != input.Recurrence {
				updated.RecurrenceStart = updated.ScheduledFor
			}
			updated.Title, updated.Brief, updated.Recurrence = title, brief, input.Recurrence
			if (title != task.Title || brief != task.Brief) && !validateTaskAssignment(r.Context(), w, assignedTaskRole(space, updated), updated) {
				return
			}
			updated.MemoryMemberID = a.ID
			*task = updated
		default:
			fail(w, 400, "Choose a schedule action.")
			return
		}
		if !saveTaskChange(w, d, "Could not save schedule changes.") {
			return
		}
		view(w, d, a)
		return
	}
	fail(w, 404, "Schedule not found.")
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
