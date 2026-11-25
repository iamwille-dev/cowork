package cowork

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/mail"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

type guestGrant struct {
	WorkspaceID, ThreadID, Email, Name, SessionHash, GuestID, IssuerID string
	Expires                                                            time.Time
}

func hashToken(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func makeGuestInvite(w http.ResponseWriter, d *database, space *Workspace, issuerID, threadID, email string) {
	email = strings.ToLower(strings.TrimSpace(email))
	address, err := mail.ParseAddress(email)
	if err != nil || address.Address != email || len(email) > 254 {
		fail(w, 400, "Enter a valid email address.")
		return
	}
	if threadMessages(space, threadID) == nil {
		fail(w, 404, "Conversation not found.")
		return
	}
	if telegramThread(space, threadID) {
		fail(w, 403, "Invite participants through Telegram.")
		return
	}
	if d.AgentConnectionThreads[space.ID][threadID] {
		fail(w, 409, "This conversation can contain private workspace data. Choose another conversation for guest access.")
		return
	}
	if d.GuestGrants == nil {
		d.GuestGrants = make(map[string]guestGrant)
	}
	token := key()
	grant := guestGrant{WorkspaceID: space.ID, ThreadID: threadID, Email: email, IssuerID: issuerID, Expires: time.Now().Add(7 * 24 * time.Hour)}
	d.GuestGrants[hashToken(token)] = grant
	if save(d) != nil {
		fail(w, 500, "Could not create the invitation.")
		return
	}
	jsonReply(w, 200, map[string]any{"token": token, "email": email, "expires": grant.Expires, "title": guestThreadTitle(space, threadID)})
}

func revokeGuestInvite(w http.ResponseWriter, d *database, account Account, token string) {
	id := hashToken(token)
	grant, ok := d.GuestGrants[id]
	if !ok || grant.IssuerID != account.ID || grant.WorkspaceID != account.Workspace || grant.SessionHash != "" {
		fail(w, 404, "Invitation not found.")
		return
	}
	delete(d.GuestGrants, id)
	if save(d) != nil {
		fail(w, 500, "Could not revoke the invitation.")
		return
	}
	jsonReply(w, 200, map[string]bool{"ok": true})
}

func guestThreadTitle(space *Workspace, threadID string) string {
	for _, thread := range space.Threads {
		if thread.ID == threadID {
			return thread.Title
		}
	}
	return "Workspace conversation"
}

func guestView(w http.ResponseWriter, space *Workspace, grant guestGrant, messages []Message) {
	jsonReply(w, 200, map[string]any{"name": grant.Name, "role": space.Role, "title": guestThreadTitle(space, grant.ThreadID), "messages": messages})
}

func guestSession(w http.ResponseWriter, r *http.Request, d *database, route string) {
	if route == "guest/join" && r.Method == "POST" {
		var input struct{ Token, Name string }
		if !decode(w, r, &input) {
			return
		}
		input.Name = strings.TrimSpace(input.Name)
		if input.Name == "" || utf8.RuneCountInString(input.Name) > 80 || len(input.Token) != 48 {
			fail(w, 400, "Enter your name and use a valid invitation link.")
			return
		}
		id := hashToken(input.Token)
		grant, ok := d.GuestGrants[id]
		if !ok || grant.SessionHash != "" || !grant.Expires.After(time.Now()) {
			fail(w, 403, "This invitation has expired or was already used.")
			return
		}
		space := d.Workspaces[grant.WorkspaceID]
		if space == nil || threadMessages(space, grant.ThreadID) == nil {
			fail(w, 404, "Conversation not found.")
			return
		}
		sessionToken := key()
		grant.Name, grant.SessionHash, grant.GuestID = input.Name, hashToken(sessionToken), key()
		d.GuestGrants[id] = grant
		if save(d) != nil {
			fail(w, 500, "Could not join the conversation.")
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "cowork_guest", Value: sessionToken, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: os.Getenv("COWORK_SECURE_COOKIE") == "1", Expires: grant.Expires})
		guestView(w, space, grant, *threadMessages(space, grant.ThreadID))
		return
	}
	cookie, err := r.Cookie("cowork_guest")
	if err != nil || len(cookie.Value) != 48 {
		fail(w, 401, "Open your invitation link to join this conversation.")
		return
	}
	sessionHash := hashToken(cookie.Value)
	var grant guestGrant
	for _, candidate := range d.GuestGrants {
		if candidate.SessionHash == sessionHash && candidate.Expires.After(time.Now()) {
			grant = candidate
			break
		}
	}
	space := d.Workspaces[grant.WorkspaceID]
	if space == nil {
		fail(w, 401, "This guest session has expired.")
		return
	}
	messages := threadMessages(space, grant.ThreadID)
	if messages == nil {
		fail(w, 404, "Conversation not found.")
		return
	}
	switch {
	case route == "guest/session" && r.Method == "GET":
		jsonReply(w, 200, map[string]string{"id": grant.GuestID, "name": grant.Name})
	case route == "guest/conversation" && r.Method == "GET":
		guestView(w, space, grant, *messages)
	case route == "guest/chat" && r.Method == "POST":
		guestChat(w, r, d, grant, space, messages)
	default:
		fail(w, 404, "Unknown endpoint.")
	}
}

func guestChat(w http.ResponseWriter, r *http.Request, d *database, grant guestGrant, space *Workspace, messages *[]Message) {
	var input struct{ Text, TimeZone string }
	if !decode(w, r, &input) {
		return
	}
	text := strings.TrimSpace(input.Text)
	if text == "" || len(text) > 4000 {
		fail(w, 400, "Enter a message of up to 4,000 characters.")
		return
	}
	location, err := time.LoadLocation(input.TimeZone)
	if err != nil || input.TimeZone == "Local" {
		location = time.UTC
	}
	*messages = append(*messages, Message{Author: grant.Name, Text: text, At: time.Now(), SenderID: grant.GuestID})
	request := workerRequest{Role: space.Role, WorkspaceID: space.ID, ThreadID: grant.ThreadID, TimeZone: location.String(), Messages: (*messages)[max(0, len(*messages)-24):], Guest: true}
	if save(d) != nil {
		fail(w, 500, "Could not save the message.")
		return
	}
	mutex.Unlock()
	result, err := worker(r.Context(), "chat", request, "")
	mutex.Lock()
	if err != nil {
		fail(w, 502, "Message saved. The agent service was unavailable.")
		return
	}
	latest, err := load()
	if err != nil {
		fail(w, 500, "Could not reload the conversation.")
		return
	}
	space = latest.Workspaces[grant.WorkspaceID]
	messages = threadMessages(space, grant.ThreadID)
	*messages = append(*messages, Message{Author: space.Role + " agent", Text: result.Reply, At: time.Now()})
	if save(latest) != nil {
		fail(w, 500, "Could not save the reply.")
		return
	}
	guestView(w, space, grant, *messages)
}
