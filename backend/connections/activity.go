package connections

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"log/slog"
)

type activityEntry struct {
	ID              string    `json:"id"`
	ClientID        string    `json:"clientId"`
	AgentName       string    `json:"agentName"`
	ConnectionID    string    `json:"connectionId"`
	ConnectionLabel string    `json:"connectionLabel"`
	Operation       string    `json:"operation"`
	Succeeded       bool      `json:"succeeded"`
	DurationMS      int64     `json:"durationMs"`
	OccurredAt      time.Time `json:"occurredAt"`
}

func (a *app) startActivity(ctx context.Context, operation, connectionID string) func(bool) {
	p := ctx.Value(principalKey{}).(principal)
	started := time.Now()
	return func(succeeded bool) {
		duration := time.Since(started).Milliseconds()
		// Preserve the outcome even when the MCP client cancels its request.
		writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		_, err := a.db.ExecContext(writeCtx, `
			INSERT INTO activity_logs
				(owner_id, client_id, agent_name, connection_id, connection_label, operation, succeeded, duration_ms)
			SELECT $1, $2, $3, c.id, COALESCE(c.email, c.github_login, c.ssh_host), $5, $6, $7
			FROM (SELECT 1) AS event
			LEFT JOIN connections c ON c.owner_id=$1 AND c.id=$4`,
			p.owner, p.client, p.name, connectionID, operation, succeeded, duration)
		if err != nil {
			slog.Warn("Could not record MCP activity", "operation", operation)
		}
	}
}

func (a *app) listActivity(w http.ResponseWriter, r *http.Request, owner, _ string) {
	query := r.URL.Query()
	client, connection := query.Get("client"), query.Get("connection")
	var before int64
	if value := query.Get("before"); value != "" {
		var err error
		before, err = strconv.ParseInt(value, 10, 64)
		if err != nil || before <= 0 {
			http.Error(w, "Invalid activity cursor", http.StatusBadRequest)
			return
		}
	}

	const pageSize = 50
	rows, err := a.db.QueryContext(r.Context(), `
		SELECT id::text, client_id, agent_name, COALESCE(connection_id,''), COALESCE(connection_label,''),
			operation, succeeded, duration_ms, occurred_at
		FROM activity_logs
		WHERE owner_id=$1 AND ($2='' OR client_id=$2) AND ($3='' OR connection_id=$3)
			AND ($4::bigint=0 OR id < $4)
		ORDER BY id DESC LIMIT $5`, owner, client, connection, before, pageSize+1)
	if err != nil {
		http.Error(w, "Could not load activity", http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	result := struct {
		Entries []activityEntry `json:"entries"`
		Next    string          `json:"next,omitempty"`
	}{Entries: []activityEntry{}}
	for rows.Next() {
		var entry activityEntry
		if err := rows.Scan(&entry.ID, &entry.ClientID, &entry.AgentName, &entry.ConnectionID, &entry.ConnectionLabel,
			&entry.Operation, &entry.Succeeded, &entry.DurationMS, &entry.OccurredAt); err != nil {
			http.Error(w, "Could not load activity", http.StatusInternalServerError)
			return
		}
		if len(result.Entries) == pageSize {
			result.Next = result.Entries[pageSize-1].ID
			break
		}
		result.Entries = append(result.Entries, entry)
	}
	if rows.Err() != nil {
		http.Error(w, "Could not load activity", http.StatusInternalServerError)
		return
	}
	writeJSON(w, result)
}
