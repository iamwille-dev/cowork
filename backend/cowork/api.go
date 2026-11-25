package cowork

import (
	"bytes"
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type Account struct{ ID, Name, Email, Salt, Password, Workspace string }
type Message struct {
	Author, Text    string
	At              time.Time
	SenderID        string `json:",omitempty"`
	TelegramMessage string `json:",omitempty"`
}
type Artifact struct{ Name, URL string }
type Thread struct {
	ID, Title, Author string
	CreatedAt         time.Time
	Messages          []Message
	TelegramTopic     string `json:",omitempty"`
}
type Task struct {
	ID, Title, Brief, Repository, Author, Status, Error string
	ThreadID                                            string `json:",omitempty"`
	UI                                                  bool
	Steps                                               []string
	Artifacts                                           []Artifact
	ScheduledFor                                        *time.Time `json:",omitempty"`
	ScheduledStarted                                    *time.Time `json:",omitempty"`
	ScheduledTimeZone                                   string     `json:",omitempty"`
	Recurrence                                          string     `json:",omitempty"`
	RecurrenceStart                                     *time.Time `json:",omitempty"`
	Result                                              string     `json:",omitempty"`
}
type Reminder struct {
	ID, Text, Author string
	Due              time.Time
	Done             bool
}
type ThreadInvite struct {
	ID, ThreadID, From, RecipientID string
}
type memberInfo struct{ ID, Name, Email, Role string }
type Workspace struct {
	ID, Role, Owner, Invite string
	Messages                []Message
	Invitations             []ThreadInvite `json:",omitempty"`
	Threads                 []Thread       `json:",omitempty"`
	Tasks                   []Task
	Reminders               []Reminder
	Channels                map[string]string
	AgentConnectionEnabled  bool `json:",omitempty"`
}

var roles = map[string]bool{"Developer": true, "Product Manager": true, "Sales Lead": true, "Social Media": true}
var mutex sync.Mutex

func key() string { var b [24]byte; rand.Read(b[:]); return hex.EncodeToString(b[:]) }
func digest(password, salt string) string {
	value, _ := pbkdf2.Key(sha256.New, password, []byte(salt), 600000, 32)
	return hex.EncodeToString(value)
}
func jsonReply(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(value)
}
func fail(w http.ResponseWriter, code int, message string) {
	jsonReply(w, code, map[string]string{"error": message})
}
func decode(w http.ResponseWriter, r *http.Request, value any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(value); err != nil {
		fail(w, 400, "Invalid request.")
		return false
	}
	return true
}
func session(w http.ResponseWriter, token string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: "cowork_session", Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: maxAge, Secure: os.Getenv("COWORK_SECURE_COOKIE") == "1"})
}
func tokenFor(r *http.Request) string {
	cookie, err := r.Cookie("cowork_session")
	if err != nil {
		return ""
	}
	return cookie.Value
}
func view(w http.ResponseWriter, d *database, a Account) {
	space := *d.Workspaces[a.Workspace]
	members := []string{}
	directory := []memberInfo{}
	invitations := []ThreadInvite{}
	for _, invite := range space.Invitations {
		if invite.RecipientID == a.ID {
			invitations = append(invitations, invite)
		}
	}
	space.Invitations = nil
	for _, member := range d.Accounts {
		if member.Workspace == space.ID {
			members = append(members, member.Name)
			role := "Member"
			if member.ID == space.Owner {
				role = "Owner"
			}
			directory = append(directory, memberInfo{member.ID, member.Name, member.Email, role})
		}
	}
	sort.Slice(directory, func(i, j int) bool { return directory[i].Email < directory[j].Email })
	sort.Strings(members)
	isOwner := space.Owner == a.ID
	if !isOwner {
		space.Invite = ""
	}
	jsonReply(w, 200, map[string]any{"name": a.Name, "admin": isOwner, "workspace": space, "members": members, "directory": directory, "viewerId": a.ID, "threadInvitations": invitations, "gitTokenStatus": gitTokenStatus(d.GitTokens[space.ID]), "telegramBot": d.TelegramBots[space.ID].Username, "agentConnectionHasKey": isOwner && d.AgentConnectionKeys[space.ID] != ""})
}

type credentials struct{ Name, Email, Password, Role, Invite string }

func authenticate(w http.ResponseWriter, r *http.Request, d *database, action string) {
	var input credentials
	if !decode(w, r, &input) {
		return
	}
	email := strings.ToLower(strings.TrimSpace(input.Email))
	account, exists := d.Accounts[email]
	if action == "signup" {
		input.Name = strings.TrimSpace(input.Name)
		if exists || !strings.Contains(email, "@") || len(email) > 254 || len(input.Name) < 1 || len(input.Name) > 80 || len(input.Password) < 8 || len(input.Password) > 128 {
			fail(w, 400, "Enter a new email, a name, and a password of 8–128 characters.")
			return
		}
		account = Account{ID: key(), Name: input.Name, Email: email, Salt: key()}
		account.Password = digest(input.Password, account.Salt)
		if input.Invite != "" {
			for _, space := range d.Workspaces {
				if space.Invite == strings.TrimSpace(input.Invite) {
					account.Workspace = space.ID
					break
				}
			}
			if account.Workspace == "" {
				fail(w, 400, "That workspace invite is invalid.")
				return
			}
		} else {
			if !roles[input.Role] {
				fail(w, 400, "Choose an agent role.")
				return
			}
			account.Workspace = key()
			d.Workspaces[account.Workspace] = &Workspace{ID: account.Workspace, Role: input.Role, Owner: account.ID, Invite: key(), Channels: map[string]string{}}
		}
		d.Accounts[email] = account
	} else if len(input.Password) > 128 || !exists || subtle.ConstantTimeCompare([]byte(account.Password), []byte(digest(input.Password, account.Salt))) != 1 {
		fail(w, 401, "Email or password is incorrect.")
		return
	}
	token := key()
	delete(d.Sessions, tokenFor(r))
	d.Sessions[token] = email
	if err := save(d); err != nil {
		fail(w, 500, "Could not save the account.")
		return
	}
	session(w, token, 0)
	view(w, d, account)
}

type workerRequest struct {
	GitTokens                map[string]string `json:",omitempty"`
	Guest                    bool              `json:",omitempty"`
	AgentConnectionWorkspace string            `json:",omitempty"`
	AgentConnectionKey       string            `json:",omitempty"`
	UseWorkspaceMemory       bool              `json:",omitempty"`
	WorkspaceID              string            `json:",omitempty"`
	ThreadID                 string            `json:",omitempty"`
	Task                     Task
	Role                     string
	TimeZone                 string
	Messages                 []Message
}
type workerResponse struct {
	Reply     string
	Steps     []string
	Artifacts []Artifact
	Error     string
}

var workerClient = &http.Client{Timeout: 90 * time.Second}

func worker(ctx context.Context, path string, input workerRequest, session string) (workerResponse, error) {
	var output workerResponse
	body, err := json.Marshal(input)
	if err != nil {
		return output, err
	}
	request, err := http.NewRequestWithContext(ctx, "POST", "http://127.0.0.1:4401/"+path, bytes.NewReader(body))
	if err != nil {
		return output, err
	}
	request.Header.Set("Content-Type", "application/json")
	client := workerClient
	if path == "chat" {
		request.Header.Set("X-Cowork-Session", session)
		client = &http.Client{Timeout: 125 * time.Second}
	}
	res, err := client.Do(request)
	if err != nil {
		return output, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return output, errors.New("agent request failed")
	}
	return output, json.NewDecoder(io.LimitReader(res.Body, 2<<20)).Decode(&output)
}

//encore:api public raw method=GET,POST path=/api/*route
func API(w http.ResponseWriter, r *http.Request) {
	route := strings.TrimPrefix(r.URL.Path, "/api/")
	if r.Method != "GET" && (r.Method != "POST" || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json")) {
		fail(w, 405, "Use GET or a JSON POST.")
		return
	}
	if r.Method == "GET" && route == "health" {
		ctx, cancel := context.WithTimeout(r.Context(), 1500*time.Millisecond)
		defer cancel()
		if err := storage.ready(ctx); err != nil {
			fail(w, 503, "Workspace database unavailable.")
			return
		}
		jsonReply(w, 200, map[string]string{"status": "ok"})
		return
	}
	mutex.Lock()
	defer mutex.Unlock()
	d, err := load()
	if err != nil {
		fail(w, 500, "Could not load workspace.")
		return
	}
	if r.Method == "POST" && (route == "signup" || route == "login") {
		authenticate(w, r, d, route)
		return
	}
	if strings.HasPrefix(route, "guest/") {
		guestSession(w, r, d, route)
		return
	}
	account, ok := d.Accounts[d.Sessions[tokenFor(r)]]
	if !ok {
		fail(w, 401, "Sign in to continue.")
		return
	}
	space := d.Workspaces[account.Workspace]
	if r.Method == "GET" {
		if route == "chat-session" {
			jsonReply(w, 200, map[string]string{"id": account.ID, "name": account.Name})
			return
		}
		if route == "workspace" {
			view(w, d, account)
			return
		}
		serveArtifact(w, r, space, route)
		return
	}
	if route == "logout" {
		delete(d.Sessions, tokenFor(r))
		if save(d) != nil {
			fail(w, 500, "Could not sign out.")
			return
		}
		session(w, "", -1)
		jsonReply(w, 200, map[string]bool{"ok": true})
		return
	}
	if route == "task/schedule" {
		scheduleTask(w, r, d, account, space)
		return
	}
	if route == "task/schedule/update" {
		updateSchedule(w, r, d, account, space)
		return
	}
	if route == "task" || route == "chat" {
		runAgent(w, r, d, account, space, route)
		return
	}
	if route == "agent-connection" {
		updateAgentConnection(w, r, d, account, space)
		return
	}
	if route == "telegram" {
		updateTelegramBot(w, r, d, account, space)
		return
	}
	if route == "git-token" {
		updateGitToken(w, r, d, account, space)
		return
	}
	var input struct {
		Text, ID, Channel, Destination, ThreadID, MemberID, Email string
		Due                                                       time.Time
	}
	if !decode(w, r, &input) {
		return
	}
	switch route {
	case "thread/invite/email/revoke":
		revokeGuestInvite(w, d, account, input.Text)
		return
	case "thread/invite/email":
		makeGuestInvite(w, d, space, account.ID, input.ThreadID, input.Email)
		return
	case "thread/invite":
		if threadMessages(space, input.ThreadID) == nil {
			fail(w, 404, "Conversation not found.")
			return
		}
		found := false
		for _, member := range d.Accounts {
			if member.ID == input.MemberID && member.ID != account.ID && member.Workspace == space.ID {
				found = true
				break
			}
		}
		if !found {
			fail(w, 404, "Choose a teammate from this workspace.")
			return
		}
		for _, invite := range space.Invitations {
			if invite.ThreadID == input.ThreadID && invite.RecipientID == input.MemberID {
				view(w, d, account)
				return
			}
		}
		space.Invitations = append(space.Invitations, ThreadInvite{key(), input.ThreadID, account.Name, input.MemberID})
	case "thread/invite/accept":
		found := false
		for i, invite := range space.Invitations {
			if invite.ID == input.ID && invite.RecipientID == account.ID {
				space.Invitations = append(space.Invitations[:i], space.Invitations[i+1:]...)
				found = true
				break
			}
		}
		if !found {
			fail(w, 404, "Invitation not found.")
			return
		}
	case "thread":
		title := strings.TrimSpace(input.Text)
		if title == "" || utf8.RuneCountInString(title) > 200 {
			fail(w, 400, "Enter a conversation title of up to 200 characters.")
			return
		}
		space.Threads = append(space.Threads, Thread{ID: key(), Title: title, Author: account.Name, CreatedAt: time.Now()})
	case "reminder":
		if strings.TrimSpace(input.Text) == "" || input.Due.IsZero() {
			fail(w, 400, "Enter a reminder and a due time.")
			return
		}
		reminder := Reminder{key(), strings.TrimSpace(input.Text), account.Name, input.Due, false}
		space.Reminders = append(space.Reminders, reminder)
		w.Header().Set("X-Cowork-Record-Id", reminder.ID)
	case "reminder/done":
		found := false
		for i := range space.Reminders {
			if space.Reminders[i].ID == input.ID {
				space.Reminders[i].Done = true
				found = true
				break
			}
		}
		if !found {
			fail(w, 404, "Reminder not found.")
			return
		}
	case "integration":
		if account.ID != space.Owner {
			fail(w, 403, "Workspace owner access required.")
			return
		}
		if input.Channel != "Slack" && input.Channel != "WhatsApp" {
			fail(w, 400, "Unknown messaging channel.")
			return
		}
		destination := strings.TrimSpace(input.Destination)
		if space.Channels == nil {
			space.Channels = make(map[string]string)
		}
		space.Channels[input.Channel] = destination
	default:
		fail(w, 404, "Unknown endpoint.")
		return
	}
	if save(d) != nil {
		fail(w, 500, "Could not save changes.")
		return
	}
	view(w, d, account)
}

// Empty IDs preserve the original shared workspace conversation.
func threadMessages(space *Workspace, id string) *[]Message {
	if id == "" {
		return &space.Messages
	}
	for i := range space.Threads {
		if space.Threads[i].ID == id {
			return &space.Threads[i].Messages
		}
	}
	return nil
}

func runAgent(w http.ResponseWriter, r *http.Request, d *database, a Account, space *Workspace, route string) {
	var input struct {
		Title, Brief, Repository, Text, TimeZone, ThreadID string
		UI                                                 bool
	}
	if !decode(w, r, &input) {
		return
	}
	messages := threadMessages(space, input.ThreadID)
	if messages == nil {
		fail(w, 404, "Conversation not found.")
		return
	}
	request := workerRequest{Role: space.Role, WorkspaceID: space.ID, ThreadID: input.ThreadID}
	if route == "chat" {
		if telegramThread(space, input.ThreadID) {
			fail(w, 403, "Reply to this conversation in Telegram.")
			return
		}
		input.Text = strings.TrimSpace(input.Text)
		if input.Text == "" || len(input.Text) > 4000 {
			fail(w, 400, "Enter a message of up to 4,000 characters.")
			return
		}
		location, err := time.LoadLocation(input.TimeZone)
		if err != nil || input.TimeZone == "Local" {
			location = time.UTC
		}
		request.TimeZone = location.String()
		request.UseWorkspaceMemory = !hasActiveGuestGrant(d, space.ID, input.ThreadID)
		*messages = append(*messages, Message{Author: a.Name, Text: input.Text, At: time.Now(), SenderID: a.ID})
		request.Messages = (*messages)[max(0, len(*messages)-24):]
	} else {
		input.Title = strings.TrimSpace(input.Title)
		input.Brief = strings.TrimSpace(input.Brief)
		if input.Title == "" || len(input.Title) > 120 || input.Brief == "" || len(input.Brief) > 6000 || len(input.Repository) > 500 {
			fail(w, 400, "Enter a title and a task brief within the displayed limits.")
			return
		}
		request.Task = Task{ID: key(), Title: input.Title, Brief: input.Brief, Repository: strings.TrimSpace(input.Repository), Author: a.Name, Status: "Running", UI: input.UI, ThreadID: input.ThreadID}
		if space.Role != "Developer" {
			request.Task.Status = "Assigned"
		}
		space.Tasks = append(space.Tasks, request.Task)
		w.Header().Set("X-Cowork-Record-Id", request.Task.ID)
		if space.Role != "Developer" {
			if save(d) != nil {
				fail(w, 500, "Could not save task.")
				return
			}
			view(w, d, a)
			return
		}
	}

	if route == "chat" && space.AgentConnectionEnabled && protectCredentialThread(d, space.ID, input.ThreadID) {
		request.AgentConnectionWorkspace = space.ID
		if stored := d.AgentConnectionKeys[space.ID]; stored != "" {
			aead, err := agentConnectionCipher(false)
			if err == nil {
				request.AgentConnectionKey, err = openAgentConnectionKey(aead, space.ID, stored)
			}
			if err != nil {
				fail(w, 500, "Could not unlock the saved Agent Connection key.")
				return
			}
		}
	}

	if route == "chat" && len(d.GitTokens[space.ID]) > 0 && protectCredentialThread(d, space.ID, input.ThreadID) {
		tokens, err := unlockGitTokens(space.ID, d.GitTokens[space.ID])
		if err != nil {
			fail(w, 500, "Could not unlock the saved Git tokens.")
			return
		}
		request.GitTokens = tokens
	}

	if save(d) != nil {
		fail(w, 500, "Could not save request.")
		return
	}
	mutex.Unlock()
	result, err := worker(r.Context(), route, request, tokenFor(r))
	mutex.Lock()
	latest, loadErr := load()
	if loadErr != nil {
		fail(w, 500, "Could not reload workspace.")
		return
	}
	space = latest.Workspaces[a.Workspace]
	if route == "task" {
		for i := range space.Tasks {
			task := &space.Tasks[i]
			if task.ID != request.Task.ID {
				continue
			}
			task.Steps, task.Artifacts = result.Steps, result.Artifacts
			task.Error = result.Error
			switch {
			case err != nil:
				task.Status = "Failed"
				task.Error = "The agent service was unavailable."
			case result.Error != "":
				task.Status = "Blocked"
			default:
				task.Status = "Ready for review"
			}
			break
		}
	} else if err == nil {
		if request.UseWorkspaceMemory && hasActiveGuestGrant(latest, space.ID, input.ThreadID) {
			fail(w, 409, "Message saved. Guest access changed while the agent was replying.")
			return
		}
		messages = threadMessages(space, input.ThreadID)
		if messages == nil {
			fail(w, 404, "Conversation not found.")
			return
		}
		*messages = append(*messages, Message{Author: space.Role + " agent", Text: result.Reply, At: time.Now()})
	}
	if save(latest) != nil {
		fail(w, 500, "Could not save result.")
		return
	}
	if route == "chat" && err != nil {
		fail(w, 502, "Message saved. The agent service was unavailable.")
		return
	}
	view(w, latest, a)
}

func serveArtifact(w http.ResponseWriter, r *http.Request, space *Workspace, route string) {
	if !strings.HasPrefix(route, "artifact/") {
		fail(w, 404, "Unknown endpoint.")
		return
	}
	for _, task := range space.Tasks {
		for _, artifact := range task.Artifacts {
			if artifact.URL != r.URL.Path {
				continue
			}
			res, err := workerClient.Get("http://127.0.0.1:4401/" + route)
			if err != nil {
				fail(w, 502, "Artifact service unavailable.")
				return
			}
			defer res.Body.Close()
			for _, header := range []string{"Content-Type", "Content-Security-Policy", "Content-Disposition"} {
				if value := res.Header.Get(header); value != "" {
					w.Header().Set(header, value)
				}
			}
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Cache-Control", "private, no-store")
			w.WriteHeader(res.StatusCode)
			io.Copy(w, res.Body)
			return
		}
	}
	fail(w, 404, "Artifact not found.")
}
