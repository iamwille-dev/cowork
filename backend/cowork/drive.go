package cowork

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgconn"
)

type driveInput struct {
	ID, ParentID, Name, Kind, Query, Area string
	Page, Revision, Offset                int
	Content                               *[]byte
	Text                                  *string
}

type driveArtifact struct {
	ID, Name, TaskTitle, URL string
	Readable                 bool
	text, privateMember      string
	externalURL              string
}

type driveArtifactFolder struct {
	ID, Name string
	Count    int
}

func taskDriveArtifacts(task Task, query string) []driveArtifact {
	items := []driveArtifact{}
	prefix := "/api/artifact/" + task.ID + "/"
	for _, artifact := range task.Artifacts {
		entry := driveArtifact{Name: artifact.Name, TaskTitle: task.Title, privateMember: task.PrivateMemberID}
		file, local := strings.CutPrefix(artifact.URL, prefix)
		if local && file == path.Base(file) {
			entry.ID, entry.URL = task.ID+":"+file, artifact.URL
			entry.Readable = file == "plan.md" || file == "preview.html"
		} else {
			target, err := url.Parse(artifact.URL)
			if err != nil || target.Scheme != "https" || target.Hostname() == "" || target.User != nil {
				continue
			}
			entry.ID = task.ID + ":link-" + hashToken(artifact.URL)
			entry.URL = "/api/drive/open?id=" + entry.ID
			entry.externalURL = artifact.URL
		}
		if query == "" || strings.Contains(strings.ToLower(artifact.Name+" "+task.Title+" "+file), query) {
			items = append(items, entry)
		}
	}
	if task.Result != "" && (query == "" || strings.Contains(strings.ToLower(task.Title+" task result "+task.Result), query)) {
		id := task.ID + ":result"
		items = append(items, driveArtifact{
			ID: id, Name: "Task result", TaskTitle: task.Title, URL: "/api/drive/download?id=" + id,
			Readable: true, text: task.Result, privateMember: task.PrivateMemberID,
		})
	}
	return items
}

func artifactTask(space *Workspace, member, id string) (Task, bool) {
	for _, task := range space.Tasks {
		if task.ID == id && task.visibleTo(member) {
			return task, true
		}
	}
	return Task{}, false
}

func driveArtifacts(space *Workspace, member, query string) []driveArtifact {
	items := []driveArtifact{}
	query = strings.ToLower(query)
	for _, task := range space.Tasks {
		if task.visibleTo(member) {
			items = append(items, taskDriveArtifacts(task, query)...)
		}
	}
	sort.SliceStable(items, func(i, j int) bool { return strings.ToLower(items[i].TaskTitle) < strings.ToLower(items[j].TaskTitle) })
	return items
}

func driveArtifactFolders(space *Workspace, member string) []driveArtifactFolder {
	folders := []driveArtifactFolder{}
	for _, task := range space.Tasks {
		if !task.visibleTo(member) {
			continue
		}
		if count := len(taskDriveArtifacts(task, "")); count > 0 {
			folders = append(folders, driveArtifactFolder{ID: task.ID, Name: task.Title, Count: count})
		}
	}
	sort.SliceStable(folders, func(i, j int) bool { return strings.ToLower(folders[i].Name) < strings.ToLower(folders[j].Name) })
	return folders
}

func drivePage[T any](items []T) ([]T, bool) {
	return items[:min(len(items), drivePageSize)], len(items) > drivePageSize
}

func driveError(w http.ResponseWriter, err error) {
	var pgErr *pgconn.PgError
	switch {
	case errors.Is(err, sql.ErrNoRows):
		fail(w, 404, "Drive item not found.")
	case errors.Is(err, errDriveStale):
		fail(w, 409, "This item changed. Reopen it and try again.")
	case errors.Is(err, errDriveFolderNotEmpty):
		fail(w, 409, "Empty the folder before deleting it.")
	case errors.Is(err, errDriveBinary):
		fail(w, 415, "This file cannot be edited as text.")
	case errors.As(err, &pgErr) && pgErr.Code == "23505":
		fail(w, 409, "An item with this name already exists in the folder.")
	case errors.As(err, &pgErr) && pgErr.Code == "23503":
		fail(w, 404, "Drive folder not found.")
	default:
		log.Printf("Cowork drive operation failed: %T", err)
		fail(w, 500, "Cowork could not complete the drive operation.")
	}
}

func decodeDrive(w http.ResponseWriter, r *http.Request, input *driveInput, limit int64) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(input); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			fail(w, 413, "Drive request is too large.")
		} else {
			fail(w, 400, "Invalid drive request.")
		}
		return false
	}
	if decoder.Decode(new(json.RawMessage)) != io.EOF {
		fail(w, 400, "Invalid drive request.")
		return false
	}
	return true
}

func driveBrowser(w http.ResponseWriter, r *http.Request, space *Workspace, account Account, action string) {
	var input driveInput
	switch r.Method {
	case http.MethodGet:
		query := r.URL.Query()
		input.ID, input.ParentID, input.Query, input.Area = query.Get("id"), query.Get("parent"), query.Get("q"), query.Get("area")
		if raw := query.Get("page"); raw != "" {
			page, err := strconv.Atoi(raw)
			if err != nil {
				fail(w, 400, "Invalid page.")
				return
			}
			input.Page = page
		}
		switch action {
		case "list", "read", "download", "open", "activity":
		default:
			fail(w, 405, "Use a JSON POST to change the drive.")
			return
		}
	case http.MethodPost:
		switch action {
		case "create", "edit", "delete":
		default:
			fail(w, 405, "Use GET to access the drive.")
			return
		}
		if !decodeDrive(w, r, &input, 8<<20) {
			return
		}
	}
	useDrive(w, r, space, driveActor{Account: account, Source: "member"}, action, input)
}

func useDrive(w http.ResponseWriter, r *http.Request, space *Workspace, actor driveActor, action string, input driveInput) {
	input.Query, input.Name = strings.TrimSpace(input.Query), strings.TrimSpace(input.Name)
	if input.Page < 0 || input.Page > 10000 || input.Offset < 0 || utf8.RuneCountInString(input.Query) > 240 || strings.ContainsRune(input.Query, 0) ||
		len(input.ID) > 120 || strings.ContainsRune(input.ID, 0) || (input.ParentID != "" && !channelWorkspaceID.MatchString(input.ParentID)) || (input.Area != "" && input.Area != "artifacts" && input.Area != "all") {
		fail(w, 400, "Invalid drive request.")
		return
	}
	ctx := r.Context()
	db, err := storage.connect(ctx)
	if err != nil {
		driveError(w, err)
		return
	}
	if action == "activity" {
		if space.Owner != actor.ID || actor.Source != "member" {
			fail(w, 403, "Workspace owner access required.")
			return
		}
		events, err := driveLog(ctx, db, actor, input.Page)
		if err != nil {
			driveError(w, err)
			return
		}
		page, more := drivePage(events)
		jsonReply(w, 200, map[string]any{"events": page, "more": more})
		return
	}
	if action == "list" {
		listDriveReply(w, ctx, db, space, actor, input)
		return
	}
	if action == "open" {
		readDriveArtifact(w, r, db, space, actor, action, input)
		return
	}
	if action == "read" || action == "download" {
		readDriveReply(w, r, db, space, actor, action, input)
		return
	}
	if action != "create" && action != "edit" && action != "delete" {
		fail(w, 404, "Unknown drive operation.")
		return
	}
	if (input.Name != "" && !validDriveName(input.Name)) ||
		(action == "create" && (!validDriveName(input.Name) ||
			(input.Kind != "folder" && input.Kind != "file") || ((input.Kind == "file") != (input.Content != nil)) || input.Text != nil)) ||
		(action != "create" && (input.ID == "" || input.Revision < 1)) ||
		(action == "edit" && (input.Name == "" && input.Text == nil && input.Content == nil || input.Text != nil && input.Content != nil)) {
		fail(w, 400, "Enter a valid file or folder name and change.")
		return
	}
	if (input.Content != nil && len(*input.Content) > driveFileLimit) || (input.Text != nil && driveText([]byte(*input.Text)) == nil) {
		fail(w, 400, "Files can be up to 5 MiB. Text edits require plain UTF-8 text up to 256 KiB.")
		return
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		driveError(w, err)
		return
	}
	defer tx.Rollback()
	item, err := changeDrive(ctx, tx, space.ID, action, input)
	if err == nil {
		err = logDrive(ctx, tx, actor, action, item.ID, item.Name, "")
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		driveError(w, err)
		return
	}
	jsonReply(w, 200, item)
}

func listDriveReply(w http.ResponseWriter, ctx context.Context, db *sql.DB, space *Workspace, actor driveActor, input driveInput) {
	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead})
	if err != nil {
		driveError(w, err)
		return
	}
	defer tx.Rollback()
	items, trail := []driveItem{}, []driveFolderRef{}
	folders, artifacts := []driveArtifactFolder{}, []driveArtifact{}
	privateMember := ""
	if input.Area != "artifacts" {
		if input.Query == "" {
			trail, err = driveFolder(ctx, tx, space.ID, input.ParentID)
		}
		if err == nil {
			items, err = listDrive(ctx, tx, space.ID, input)
		}
	}
	if err == nil && (input.Area == "artifacts" || input.Area == "all") {
		viewer := artifactViewer(actor)
		switch {
		case input.Query != "":
			artifacts = driveArtifacts(space, viewer, input.Query)
		case input.Area == "artifacts" && input.ParentID != "":
			if task, ok := artifactTask(space, viewer, input.ParentID); ok {
				artifacts = taskDriveArtifacts(task, "")
				trail = append(trail, driveFolderRef{ID: task.ID, Name: task.Title})
				privateMember = task.PrivateMemberID
			}
			if len(artifacts) == 0 {
				err = sql.ErrNoRows
			}
		default:
			folders = driveArtifactFolders(space, viewer)
		}
	}
	action, name, itemID := "list", "Shared drive", input.ParentID
	if input.Area == "artifacts" {
		name = "Task artifacts"
	}
	if input.Query != "" {
		action, itemID = "search", ""
	}
	if len(trail) > 0 {
		name = trail[len(trail)-1].Name
	}
	if err == nil {
		err = logDrive(ctx, tx, actor, action, itemID, name, privateMember)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		driveError(w, err)
		return
	}
	offset := input.Page * drivePageSize
	folders, moreFolders := drivePage(folders[min(offset, len(folders)):])
	artifacts, moreArtifacts := drivePage(artifacts[min(offset, len(artifacts)):])
	items, more := drivePage(items)
	jsonReply(w, 200, map[string]any{
		"items": items, "trail": trail, "artifactFolders": folders, "artifacts": artifacts, "more": more || moreFolders || moreArtifacts,
	})
}

func artifactViewer(actor driveActor) string {
	if actor.Source == "member" {
		return actor.ID
	}
	// A tool result can be shared in a conversation or published to the task board.
	return ""
}

func readDriveReply(w http.ResponseWriter, r *http.Request, db *sql.DB, space *Workspace, actor driveActor, action string, input driveInput) {
	ctx := r.Context()
	if strings.Contains(input.ID, ":") {
		readDriveArtifact(w, r, db, space, actor, action, input)
		return
	}
	var item driveItem
	var content []byte
	var plain sql.NullString
	err := db.QueryRowContext(ctx, `
		SELECT `+driveMetadata+`, CASE WHEN $3 THEN content END, CASE WHEN NOT $3 THEN text_content END
		FROM cowork_drive_items WHERE workspace_id=$1 AND id=$2 AND kind='file'
	`, space.ID, input.ID, action == "download").Scan(&item.ID, &item.ParentID, &item.Name, &item.Kind,
		&item.Size, &item.Editable, &item.Revision, &item.UpdatedAt, &content, &plain)
	if err != nil {
		driveError(w, err)
		return
	}
	if action == "read" && !plain.Valid {
		driveError(w, errDriveBinary)
		return
	}
	if err := logDrive(ctx, db, actor, action, item.ID, item.Name, ""); err != nil {
		driveError(w, err)
		return
	}
	if action == "download" {
		driveDownload(w, item.Name, content)
	} else {
		driveTextReply(w, actor, input.Offset, item, plain.String)
	}
}

func readDriveArtifact(w http.ResponseWriter, r *http.Request, db *sql.DB, space *Workspace, actor driveActor, action string, input driveInput) {
	taskID, _, _ := strings.Cut(input.ID, ":")
	task, ok := artifactTask(space, artifactViewer(actor), taskID)
	if !ok {
		driveError(w, sql.ErrNoRows)
		return
	}
	for _, artifact := range taskDriveArtifacts(task, "") {
		if artifact.ID != input.ID {
			continue
		}
		if action == "open" {
			if artifact.externalURL == "" {
				break
			}
			if err := logDrive(r.Context(), db, actor, action, artifact.ID, artifact.Name, artifact.privateMember); err != nil {
				driveError(w, err)
				return
			}
			w.Header().Set("Cache-Control", "private, no-store")
			w.Header().Set("Referrer-Policy", "no-referrer")
			http.Redirect(w, r, artifact.externalURL, http.StatusTemporaryRedirect)
			return
		}
		if action == "download" && artifact.text == "" {
			break
		}
		if !artifact.Readable {
			driveError(w, errDriveBinary)
			return
		}
		body := artifact.text
		if body == "" {
			response, err := fetchTaskArtifact(r.Context(), strings.TrimPrefix(artifact.URL, "/api/"))
			if err != nil {
				fail(w, 502, "Artifact service unavailable.")
				return
			}
			defer response.Body.Close()
			if response.StatusCode != 200 {
				fail(w, 404, "Artifact not available.")
				return
			}
			bytes, err := io.ReadAll(io.LimitReader(response.Body, driveTextLimit+1))
			if err != nil {
				fail(w, 502, "Artifact service unavailable.")
				return
			}
			if driveText(bytes) == nil {
				driveError(w, errDriveBinary)
				return
			}
			body = string(bytes)
		}
		if err := logDrive(r.Context(), db, actor, action, artifact.ID, artifact.Name, artifact.privateMember); err != nil {
			driveError(w, err)
			return
		}
		if action == "download" {
			driveDownload(w, "task-result.txt", []byte(body))
		} else {
			driveTextReply(w, actor, input.Offset, artifact, body)
		}
		return
	}
	driveError(w, sql.ErrNoRows)
}

func driveTextReply(w http.ResponseWriter, actor driveActor, offset int, item any, value string) {
	if actor.Source != "member" {
		chars := []rune(value)
		offset = min(offset, len(chars))
		end := min(offset+8000, len(chars))
		result := map[string]any{"item": item, "text": string(chars[offset:end])}
		if end < len(chars) {
			result["nextOffset"] = end
		}
		jsonReply(w, 200, result)
		return
	}
	jsonReply(w, 200, map[string]any{"item": item, "text": value})
}

func driveDownload(w http.ResponseWriter, name string, bytes []byte) {
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Write(bytes)
}
