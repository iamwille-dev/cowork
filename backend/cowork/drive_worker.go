package cowork

import (
	"crypto/hmac"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

type driveGrant struct {
	WorkspaceID, MemberID, ThreadID, TaskID, AgentID string
	Started, Expires                                 int64
}

func newDriveGrant(space *Workspace, member, thread, agent string, task *Task) string {
	grant := driveGrant{WorkspaceID: space.ID, MemberID: member, ThreadID: thread, AgentID: agent, Expires: time.Now().Add(3 * time.Minute).Unix()}
	if task != nil {
		grant.TaskID, grant.Started = task.ID, taskRunStarted(*task).UnixNano()
	}
	raw, _ := json.Marshal(grant)
	payload := base64.RawURLEncoding.EncodeToString(raw)
	return payload + "." + hex.EncodeToString(signWorkerSession("drive:"+payload))
}

func parseDriveGrant(token string) (driveGrant, bool) {
	var grant driveGrant
	if len(token) > 2048 {
		return grant, false
	}
	payload, signature, ok := strings.Cut(token, ".")
	signed, err := hex.DecodeString(signature)
	if !ok || err != nil || !hmac.Equal(signed, signWorkerSession("drive:"+payload)) {
		return grant, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	return grant, err == nil && json.Unmarshal(raw, &grant) == nil && grant.Expires >= time.Now().Unix()
}

func driveMember(d *database, workspaceID, memberID string) (Account, bool) {
	for _, account := range d.Accounts {
		if account.ID == memberID && account.Workspace == workspaceID {
			return account, true
		}
	}
	return Account{}, false
}

func authorizeDriveWorker(d *database, grant driveGrant) (*Workspace, driveActor, bool) {
	space := d.Workspaces[grant.WorkspaceID]
	account, ok := driveMember(d, grant.WorkspaceID, grant.MemberID)
	if !ok || space == nil || hasActiveGuestGrant(d, space.ID, grant.ThreadID) ||
		telegramThread(space, grant.ThreadID) || slackLinked(space, grant.ThreadID) {
		return nil, driveActor{}, false
	}
	if grant.TaskID != "" {
		for _, task := range space.Tasks {
			if task.ID != grant.TaskID || task.Status != "Running" || task.ThreadID != grant.ThreadID ||
				task.MemoryMemberID != account.ID || task.AgentID != grant.AgentID {
				continue
			}
			started := taskRunStarted(task)
			if started == nil || started.UnixNano() != grant.Started {
				break
			}
			agent, active := taskAgent(space, task)
			return space, driveActor{Account: account, AgentName: agent.Name, Source: "task"}, active
		}
		return nil, driveActor{}, false
	}
	agent := space.threadAgent(grant.ThreadID)
	ok = threadMessages(space, grant.ThreadID) != nil && !space.threadHasRemovedAgent(grant.ThreadID) && agent.ID == grant.AgentID
	return space, driveActor{Account: account, AgentName: agent.Name, Source: "chat"}, ok
}

func driveWorkerActor(grant driveGrant) (*Workspace, driveActor, error) {
	mutex.Lock()
	defer mutex.Unlock()
	d, err := load()
	if err != nil {
		return nil, driveActor{}, err
	}
	space, actor, ok := authorizeDriveWorker(d, grant)
	if !ok {
		return nil, driveActor{}, nil
	}
	if (grant.TaskID == "" || grant.ThreadID != "") && !d.AgentConnectionThreads[space.ID][grant.ThreadID] {
		// The first drive access makes the thread ineligible for guest sharing.
		// Saving under the same lock as invitations prevents a sharing race.
		protectCredentialThread(d, space.ID, grant.ThreadID)
		if err := save(d); err != nil {
			return nil, driveActor{}, err
		}
	}
	return space, actor, nil
}

//encore:api public raw method=POST path=/internal/drive/*action
func DriveWorker(w http.ResponseWriter, r *http.Request) {
	grant, ok := parseDriveGrant(r.Header.Get("X-Cowork-Drive"))
	if !ok {
		fail(w, 403, "Drive access requires a workspace member.")
		return
	}
	action := strings.TrimPrefix(r.URL.Path, "/internal/drive/")
	if action != "list" && action != "read" && action != "edit" {
		fail(w, 404, "Unknown drive tool.")
		return
	}
	var input driveInput
	if !decodeDrive(w, r, &input, 2<<20) {
		return
	}
	if action == "edit" && (input.Text == nil || input.Content != nil || input.Name != "") {
		fail(w, 400, "Agents can edit the text of an existing file.")
		return
	}
	space, actor, err := driveWorkerActor(grant)
	if err != nil {
		driveError(w, err)
		return
	}
	if space == nil {
		fail(w, 403, "Drive access is unavailable in this conversation or task.")
		return
	}
	useDrive(w, r, space, actor, action, input)
}
