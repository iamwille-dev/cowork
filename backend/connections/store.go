package connections

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"regexp"
	"strings"
)

type connection struct {
	ID      string          `json:"id"`
	Kind    string          `json:"kind"`
	Login   string          `json:"login,omitempty"`
	Email   string          `json:"email,omitempty"`
	Host    string          `json:"host,omitempty"`
	Port    int             `json:"port,omitempty"`
	User    string          `json:"user,omitempty"`
	Clients []string        `json:"clients,omitempty"`
	Agents  []agentIdentity `json:"agents,omitempty"`
}

func (a *app) connections(ctx context.Context, owner, client string) ([]connection, error) {
	rows, err := a.db.QueryContext(ctx, `
  SELECT c.id,c.kind,COALESCE(c.email,''),COALESCE(c.github_login,''),COALESCE(c.ssh_host,''),
   COALESCE(c.ssh_port,0),COALESCE(c.ssh_user,''),g.client_id,ac.name FROM connections c
  LEFT JOIN agent_grants g ON $2='' AND g.owner_id=c.owner_id AND g.connection_id=c.id
  LEFT JOIN agent_credentials ac ON ac.owner_id=g.owner_id AND ac.connection_id=g.connection_id AND ac.client_id=g.client_id
  WHERE c.owner_id=$1 AND ($2='' OR EXISTS (SELECT 1 FROM connection_access ca WHERE ca.owner_id=c.owner_id AND ca.connection_id=c.id AND ca.client_id=$2))
  ORDER BY c.email,c.id,g.client_id`, owner, client)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []connection{}
	for rows.Next() {
		var entry connection
		var clientID, agentName sql.NullString
		if err := rows.Scan(&entry.ID, &entry.Kind, &entry.Email, &entry.Login, &entry.Host, &entry.Port, &entry.User, &clientID, &agentName); err != nil {
			return nil, err
		}
		if len(result) == 0 || result[len(result)-1].ID != entry.ID {
			result = append(result, entry)
		}
		if client == "" && clientID.Valid {
			last := &result[len(result)-1]
			if agentName.Valid {
				last.Agents = append(last.Agents, agentIdentity{ID: clientID.String, Name: agentName.String})
			} else {
				last.Clients = append(last.Clients, clientID.String)
			}
		}
	}
	return result, rows.Err()
}

func (a *app) listConnections(w http.ResponseWriter, r *http.Request, owner, _ string) {
	rows, err := a.connections(r.Context(), owner, "")
	if err != nil {
		http.Error(w, "Could not list connections", 500)
		return
	}
	writeJSON(w, rows)
}

var clientPattern = regexp.MustCompile(`^[A-Za-z0-9_.:/-]{1,500}$`)

func (a *app) grant(w http.ResponseWriter, r *http.Request, owner, _ string) {
	id, client := r.PathValue("id"), r.PathValue("client")
	if !clientPattern.MatchString(client) || (r.Method != http.MethodDelete && strings.HasPrefix(client, agentPrefix)) {
		http.Error(w, "Invalid OAuth client ID", 400)
		return
	}
	query := `INSERT INTO agent_grants(owner_id,connection_id,client_id)
 SELECT owner_id,id,$3 FROM connections WHERE owner_id=$1 AND id=$2 ON CONFLICT DO NOTHING`
	if r.Method == http.MethodDelete {
		query = `DELETE FROM agent_grants WHERE owner_id=$1 AND connection_id=$2 AND client_id=$3`
	}
	if _, err := a.db.ExecContext(r.Context(), query, owner, id, client); err != nil {
		http.Error(w, "Could not update access", 500)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) disconnect(w http.ResponseWriter, r *http.Request, owner, _ string) {
	id := r.PathValue("id")
	var encrypted []byte
	var kind string
	err := a.db.QueryRowContext(r.Context(), `DELETE FROM connections WHERE owner_id=$1 AND id=$2 RETURNING kind, credential`, owner, id).Scan(&kind, &encrypted)
	if errors.Is(err, sql.ErrNoRows) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		http.Error(w, "Could not disconnect", 500)
		return
	}
	if kind != "gmail" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if token, err := a.openCredential(owner, id, encrypted); err == nil {
		if a.google == nil || a.revokeGoogle(r.Context(), token) != nil {
			writeJSON(w, map[string]string{"warning": "Disconnected locally. Google revocation could not be confirmed. Remove access in your Google Account settings."})
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) sealCredential(owner, id, token string) []byte {
	nonce := randBytes(a.key.NonceSize())
	return a.key.Seal(nonce, nonce, []byte(token), []byte(owner+"\x00"+id))
}

func (a *app) openCredential(owner, id string, credential []byte) (string, error) {
	n := a.key.NonceSize()
	if len(credential) < n {
		return "", errors.New("invalid credential")
	}
	value, err := a.key.Open(nil, credential[:n], credential[n:], []byte(owner+"\x00"+id))
	return string(value), err
}
