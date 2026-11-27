package connections

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"database/sql"
)

const agentPrefix = "ellie_agent_"

type agentIdentity struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (a *app) createAgent(w http.ResponseWriter, r *http.Request, owner, _ string) {
	var input struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&input); err != nil {
		http.Error(w, "Invalid agent name", http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(input.Name)
	if name == "" || len(name) > 100 {
		http.Error(w, "Agent name must be 1 to 100 bytes", http.StatusBadRequest)
		return
	}
	connectionID := r.PathValue("id")
	clientID := agentPrefix + randomID()
	credential := agentPrefix + randomID()
	hash := sha256.Sum256([]byte(credential))

	result, err := a.db.ExecContext(r.Context(), `
		WITH grant_row AS (
			INSERT INTO agent_grants (owner_id, connection_id, client_id)
			SELECT owner_id, id, $3 FROM connections WHERE owner_id=$1 AND id=$2
			RETURNING owner_id, connection_id, client_id
		)
		INSERT INTO agent_credentials (owner_id, connection_id, client_id, name, credential_hash)
		SELECT owner_id, connection_id, client_id, $4, $5 FROM grant_row`,
		owner, connectionID, clientID, name, hash[:])
	if err != nil {
		http.Error(w, "Could not create agent", http.StatusInternalServerError)
		return
	}
	if rowCount(result) == 0 {
		http.Error(w, "Connection not found", http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]string{"id": clientID, "name": name, "credential": credential})
}

func (a *app) authenticateAgent(ctx context.Context, credential string) (principal, error) {
	hash := sha256.Sum256([]byte(credential))
	var p principal
	err := a.db.QueryRowContext(ctx, `
		SELECT owner_id, client_id, name FROM workspace_credentials WHERE credential_hash=$1
        UNION ALL SELECT owner_id, client_id, name FROM agent_credentials WHERE credential_hash=$1`, hash[:]).Scan(&p.owner, &p.client, &p.name)
	if err == nil && !a.canUseOwner(p.owner) {
		return principal{}, errTesterRequired
	}
	return p, err
}

func (a *app) workspaceKey(w http.ResponseWriter, r *http.Request, owner, _ string) {
	ctx := r.Context()
	switch r.Method {
	case http.MethodGet:
		var key agentIdentity
		err := a.db.QueryRowContext(ctx, `SELECT client_id,name FROM workspace_credentials WHERE owner_id=$1`, owner).Scan(&key.ID, &key.Name)
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, nil)
			return
		}
		if err == nil {
			writeJSON(w, key)
			return
		}
	case http.MethodPost:
		credential := agentPrefix + randomID()
		hash := sha256.Sum256([]byte(credential))
		id := agentPrefix + randomID()
		const name = "Workspace key"
		result, err := a.db.ExecContext(ctx, `INSERT INTO workspace_credentials(owner_id,client_id,name,credential_hash)
  VALUES ($1,$2,$3,$4) ON CONFLICT (owner_id) DO NOTHING`, owner, id, name, hash[:])
		if err == nil {
			if rowCount(result) == 0 {
				http.Error(w, "A workspace key already exists. Revoke it before generating another.", http.StatusConflict)
				return
			}
			writeJSON(w, map[string]string{"id": id, "name": name, "credential": credential})
			return
		}
	case http.MethodDelete:
		if _, err := a.db.ExecContext(ctx, `DELETE FROM workspace_credentials WHERE owner_id=$1 AND client_id=$2`, owner, r.URL.Query().Get("id")); err == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	http.Error(w, "Could not manage workspace key", http.StatusInternalServerError)
}
