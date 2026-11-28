package cowork

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

const driveSchema = `
CREATE TABLE IF NOT EXISTS cowork_drive_items (
	workspace_id text NOT NULL,
	id text NOT NULL,
	parent_id text,
	name text NOT NULL,
	kind text NOT NULL CHECK (kind IN ('file', 'folder')),
	content bytea,
	text_content text,
	revision integer NOT NULL DEFAULT 1,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (workspace_id, id),
	FOREIGN KEY (workspace_id, parent_id) REFERENCES cowork_drive_items(workspace_id, id) ON DELETE RESTRICT,
	CHECK ((kind = 'file') = (content IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS cowork_drive_sibling_name
	ON cowork_drive_items(workspace_id, COALESCE(parent_id, ''), lower(name));
CREATE INDEX IF NOT EXISTS cowork_drive_parent ON cowork_drive_items(workspace_id, parent_id);
CREATE TABLE IF NOT EXISTS cowork_drive_access (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	workspace_id text NOT NULL,
	at timestamptz NOT NULL DEFAULT now(),
	actor_id text NOT NULL,
	actor_name text NOT NULL,
	agent_name text NOT NULL,
	source text NOT NULL,
	action text NOT NULL,
	item_id text NOT NULL,
	item_name text NOT NULL,
	private_member_id text NOT NULL
);
CREATE INDEX IF NOT EXISTS cowork_drive_access_recent ON cowork_drive_access(workspace_id, id DESC);
`

const (
	driveFileLimit = 5 << 20
	driveTextLimit = 256 << 10
	drivePageSize  = 40
)

type driveItem struct {
	ID, ParentID, Name, Kind string
	Size                     int
	Editable                 bool
	Revision                 int
	UpdatedAt                time.Time
}

type driveActivity struct {
	ID                                                              int64
	At                                                              time.Time
	ActorID, ActorName, AgentName, Source, Action, ItemID, ItemName string
}

type driveActor struct {
	Account
	AgentName, Source string
}

type driveDB interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

const driveMetadata = `id, COALESCE(parent_id, ''), name, kind, COALESCE(octet_length(content), 0),
	text_content IS NOT NULL, revision, updated_at`

func scanDriveItem(row interface{ Scan(...any) error }, item *driveItem) error {
	return row.Scan(&item.ID, &item.ParentID, &item.Name, &item.Kind, &item.Size, &item.Editable, &item.Revision, &item.UpdatedAt)
}

func driveText(bytes []byte) *string {
	if len(bytes) > driveTextLimit || !utf8.Valid(bytes) {
		return nil
	}
	for _, char := range string(bytes) {
		if (char < 32 && char != '\n' && char != '\r' && char != '\t') || char == 127 {
			return nil
		}
	}
	value := string(bytes)
	return &value
}

func validDriveName(name string) bool {
	return name != "" && name != "." && name != ".." && utf8.RuneCountInString(name) <= 180 &&
		!strings.ContainsAny(name, "/\\") && driveText([]byte(name)) != nil &&
		!strings.ContainsAny(name, "\r\n\t")
}

type driveFolderRef struct{ ID, Name string }

func driveFolder(ctx context.Context, db driveDB, space, id string) ([]driveFolderRef, error) {
	trail := []driveFolderRef{}
	if id == "" {
		return trail, nil
	}
	rows, err := db.QueryContext(ctx, `
		WITH RECURSIVE ancestors AS (
			SELECT id, parent_id, name, 0 AS depth FROM cowork_drive_items
			WHERE workspace_id=$1 AND id=$2 AND kind='folder'
			UNION ALL
			SELECT item.id, item.parent_id, item.name, ancestors.depth + 1
			FROM cowork_drive_items item JOIN ancestors ON item.id=ancestors.parent_id
			WHERE item.workspace_id=$1
		)
		SELECT id, name FROM ancestors ORDER BY depth DESC
	`, space, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var item driveFolderRef
		if err := rows.Scan(&item.ID, &item.Name); err != nil {
			return nil, err
		}
		trail = append(trail, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(trail) == 0 {
		return nil, sql.ErrNoRows
	}
	return trail, nil
}

func listDrive(ctx context.Context, db driveDB, space string, input driveInput) ([]driveItem, error) {
	query := `SELECT ` + driveMetadata + ` FROM cowork_drive_items WHERE workspace_id=$1 AND `
	if input.Query == "" {
		query += `parent_id IS NOT DISTINCT FROM NULLIF($2, '')`
	} else {
		query += `(strpos(lower(name), lower($2)) > 0 OR strpos(lower(text_content), lower($2)) > 0)`
	}
	query += ` ORDER BY kind DESC, lower(name), id LIMIT $3 OFFSET $4`
	filter := input.ParentID
	if input.Query != "" {
		filter = input.Query
	}
	rows, err := db.QueryContext(ctx, query, space, filter, drivePageSize+1, input.Page*drivePageSize)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []driveItem{}
	for rows.Next() {
		var item driveItem
		if err := scanDriveItem(rows, &item); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func logDrive(ctx context.Context, db driveDB, actor driveActor, action, id, name, privateMember string) error {
	_, err := db.ExecContext(ctx, `
		INSERT INTO cowork_drive_access(workspace_id, actor_id, actor_name, agent_name, source, action, item_id, item_name, private_member_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
	`, actor.Workspace, actor.ID, actor.Name, actor.AgentName, actor.Source, action, id, name, privateMember)
	return err
}

func driveLog(ctx context.Context, db driveDB, actor driveActor, page int) ([]driveActivity, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT id, at, actor_id, actor_name, agent_name, source, action, item_id, item_name
		FROM cowork_drive_access WHERE workspace_id=$1 AND private_member_id IN ('', $2)
		ORDER BY id DESC LIMIT $3 OFFSET $4
	`, actor.Workspace, actor.ID, drivePageSize+1, page*drivePageSize)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	activity := []driveActivity{}
	for rows.Next() {
		var event driveActivity
		if err := rows.Scan(&event.ID, &event.At, &event.ActorID, &event.ActorName, &event.AgentName,
			&event.Source, &event.Action, &event.ItemID, &event.ItemName); err != nil {
			return nil, err
		}
		activity = append(activity, event)
	}
	return activity, rows.Err()
}

var errDriveStale = errors.New("drive item changed")
var errDriveBinary = errors.New("file cannot be edited as text")
var errDriveFolderNotEmpty = errors.New("folder is not empty")

func changeDrive(ctx context.Context, tx *sql.Tx, space, action string, input driveInput) (driveItem, error) {
	var item driveItem
	if action == "create" {
		if _, err := driveFolder(ctx, tx, space, input.ParentID); err != nil {
			return item, err
		}
		var content []byte
		var searchable *string
		if input.Kind == "file" {
			content = *input.Content
			searchable = driveText(content)
		}
		err := scanDriveItem(tx.QueryRowContext(ctx, `
			INSERT INTO cowork_drive_items(workspace_id,id,parent_id,name,kind,content,text_content)
			VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7) RETURNING `+driveMetadata,
			space, key(), input.ParentID, input.Name, input.Kind, content, searchable), &item)
		return item, err
	}
	err := scanDriveItem(tx.QueryRowContext(ctx, `
		SELECT `+driveMetadata+` FROM cowork_drive_items WHERE workspace_id=$1 AND id=$2 FOR UPDATE
	`, space, input.ID), &item)
	if err != nil {
		return item, err
	}
	if input.Revision != item.Revision {
		return item, errDriveStale
	}

	if action == "delete" {
		// The row lock prevents a new child from taking the FK key-share lock
		// between the emptiness check and deletion.
		var hasChildren bool
		if err := tx.QueryRowContext(ctx, `
			SELECT EXISTS(SELECT 1 FROM cowork_drive_items WHERE workspace_id=$1 AND parent_id=$2)
		`, space, item.ID).Scan(&hasChildren); err != nil {
			return item, err
		}
		if hasChildren {
			return item, errDriveFolderNotEmpty
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM cowork_drive_items WHERE workspace_id=$1 AND id=$2`, space, item.ID)
		return item, err
	}

	var replacement *[]byte
	if input.Text != nil {
		if !item.Editable {
			return item, errDriveBinary
		}
		bytes := []byte(*input.Text)
		replacement = &bytes
	} else if input.Content != nil {
		if item.Kind != "file" {
			return item, errDriveBinary
		}
		replacement = input.Content
	}
	var bytes []byte
	var searchable *string
	if replacement != nil {
		bytes = *replacement
		searchable = driveText(bytes)
	}
	err = scanDriveItem(tx.QueryRowContext(ctx, `
		UPDATE cowork_drive_items SET name=COALESCE(NULLIF($3,''), name),
			content=CASE WHEN $4 THEN $5 ELSE content END,
			text_content=CASE WHEN $4 THEN $6 ELSE text_content END,
			revision=revision+1, updated_at=now()
		WHERE workspace_id=$1 AND id=$2 RETURNING `+driveMetadata,
		space, item.ID, input.Name, replacement != nil, bytes, searchable), &item)
	return item, err
}
