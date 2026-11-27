package connections

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"golang.org/x/oauth2"
)

const intentCookie = "google_connection"

func (a *app) startGoogle(w http.ResponseWriter, r *http.Request, owner, session string) {
	if a.google == nil {
		http.Error(w, "Google OAuth is not configured.", http.StatusServiceUnavailable)
		return
	}
	state, binding, verifier := randomID(), randomID(), oauth2.GenerateVerifier()
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		http.Error(w, "Could not start Google connection", 500)
		return
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(r.Context(), `DELETE FROM google_intents WHERE expires_at <= now() OR (owner_id=$1 AND session_id=$2)`, owner, session)
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO google_intents(state,owner_id,session_id,browser_binding,verifier) VALUES ($1,$2,$3,$4,$5)`, state, owner, session, binding, verifier)
	}
	if err != nil || tx.Commit() != nil {
		http.Error(w, "Could not start Google connection", 500)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: intentCookie, Value: binding, Path: browserPrefix + "/google/callback", HttpOnly: true, Secure: strings.HasPrefix(a.origin, "https://"), SameSite: http.SameSiteLaxMode, MaxAge: 600})
	writeJSON(w, map[string]string{"url": a.google.AuthCodeURL(state, oauth2.AccessTypeOffline, oauth2.SetAuthURLParam("prompt", "consent select_account"), oauth2.S256ChallengeOption(verifier))})
}

func (a *app) finishGoogle(w http.ResponseWriter, r *http.Request) {
	if a.google == nil {
		http.Error(w, "Google OAuth is not configured.", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	status := "failed"
	defer func() {
		http.Redirect(w, r, a.origin+"/settings?section=agent-connection&google="+status, http.StatusSeeOther)
	}()
	cookie, err := r.Cookie(intentCookie)
	state := r.URL.Query().Get("state")
	if err != nil || state == "" {
		return
	}
	var owner, verifier string
	err = a.db.QueryRowContext(r.Context(), `DELETE FROM google_intents WHERE state=$1 AND browser_binding=$2 AND expires_at>now() RETURNING owner_id,verifier`, state, cookie.Value).Scan(&owner, &verifier)
	if err != nil || !a.testers[owner] {
		return
	}
	http.SetCookie(w, &http.Cookie{Name: intentCookie, Path: browserPrefix + "/google/callback", HttpOnly: true, Secure: strings.HasPrefix(a.origin, "https://"), SameSite: http.SameSiteLaxMode, MaxAge: -1})
	code := r.URL.Query().Get("code")
	if code == "" {
		return
	}
	ctx := context.WithValue(r.Context(), oauth2.HTTPClient, a.httpClient)
	token, err := a.google.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return
	}
	scope, _ := token.Extra("scope").(string)
	if !slices.Contains(strings.Fields(scope), gmailScope) {
		status = "scope"
		return
	}
	rawID, _ := token.Extra("id_token").(string)
	identity, err := a.googleIdentity.Verify(ctx, rawID)
	if err != nil || identity.Subject == "" {
		return
	}
	var profile struct {
		Email    string `json:"email"`
		Verified bool   `json:"email_verified"`
	}
	if identity.Claims(&profile) != nil || profile.Email == "" || !profile.Verified {
		return
	}
	digest := sha256.Sum256([]byte(owner + "\x00" + identity.Subject))
	id := base64.RawURLEncoding.EncodeToString(digest[:])
	if token.RefreshToken == "" {
		result, err := a.db.ExecContext(ctx, `UPDATE connections SET email=$3 WHERE owner_id=$1 AND id=$2`, owner, id, profile.Email)
		if err != nil || rowCount(result) != 1 {
			status = "offline"
			return
		}
	} else {
		_, err = a.db.ExecContext(ctx, `INSERT INTO connections(id,owner_id,google_subject,email,credential) VALUES ($1,$2,$3,$4,$5)
   ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, credential=EXCLUDED.credential`, id, owner, identity.Subject, profile.Email, a.sealCredential(owner, id, token.RefreshToken))
		if err != nil {
			return
		}
	}
	status = "connected"
}

func (a *app) revokeGoogle(ctx context.Context, token string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://oauth2.googleapis.com/revoke", strings.NewReader(url.Values{"token": {token}}.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := a.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("revocation failed")
	}
	return nil
}

func (a *app) readGmail(ctx context.Context, p principal, id, path string, query url.Values) (map[string]any, error) {
	if a.google == nil {
		return nil, errors.New("GMAIL_UNAVAILABLE")
	}
	if id == "" {
		return nil, errors.New("CONNECTION_REQUIRED")
	}
	var encrypted []byte
	err := a.db.QueryRowContext(ctx, `SELECT c.credential FROM connections c
  JOIN connection_access g ON g.owner_id=c.owner_id AND g.connection_id=c.id
  WHERE c.owner_id=$1 AND c.id=$2 AND g.client_id=$3 AND c.kind='gmail'`, p.owner, id, p.client).Scan(&encrypted)
	if err != nil {
		return nil, errors.New("CONNECTION_UNAVAILABLE")
	}
	refresh, err := a.openCredential(p.owner, id, encrypted)
	if err != nil {
		return nil, errors.New("CREDENTIAL_UNAVAILABLE")
	}
	ctx = context.WithValue(ctx, oauth2.HTTPClient, a.httpClient)
	token, err := a.google.TokenSource(ctx, &oauth2.Token{RefreshToken: refresh}).Token()
	if err != nil {
		var oauthErr *oauth2.RetrieveError
		if errors.As(err, &oauthErr) && oauthErr.ErrorCode == "invalid_grant" {
			return nil, errors.New("REAUTH_REQUIRED: reconnect the Google account")
		}
		return nil, errors.New("GOOGLE_TOKEN_UNAVAILABLE")
	}
	if token.RefreshToken != "" && token.RefreshToken != refresh {
		if _, err := a.db.ExecContext(ctx, `UPDATE connections SET credential=$3 WHERE owner_id=$1 AND id=$2 AND credential=$4`, p.owner, id, a.sealCredential(p.owner, id, token.RefreshToken), encrypted); err != nil {
			return nil, errors.New("CREDENTIAL_UNAVAILABLE")
		}
	}
	// Refresh can take several seconds. Check the same grant again before dispatch.
	var allowed bool
	err = a.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM connection_access WHERE owner_id=$1 AND connection_id=$2 AND client_id=$3)`, p.owner, id, p.client).Scan(&allowed)
	if err != nil || !allowed {
		return nil, errors.New("CONNECTION_UNAVAILABLE")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.gmailBase+path+"?"+query.Encode(), nil)
	if err != nil {
		return nil, errors.New("INVALID_REQUEST")
	}
	token.SetAuthHeader(req)
	response, err := a.httpClient.Do(req)
	if err != nil {
		return nil, errors.New("GMAIL_UNAVAILABLE")
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case 200:
	case 401:
		return nil, errors.New("REAUTH_REQUIRED: reconnect the Google account")
	case 403:
		return nil, gmailForbidden(response.Body)
	case 404:
		return nil, errors.New("MESSAGE_NOT_FOUND")
	case 429:
		return nil, errors.New("GMAIL_RATE_LIMITED")
	default:
		return nil, errors.New("GMAIL_UNAVAILABLE")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20+1))
	if err != nil || len(body) > 2<<20 {
		return nil, errors.New("GMAIL_RESPONSE_UNAVAILABLE")
	}
	var data map[string]any
	if json.Unmarshal(body, &data) != nil || data == nil {
		return nil, errors.New("INVALID_GMAIL_RESPONSE")
	}
	return data, nil
}

// gmailForbidden returns only known diagnostics. Google error messages may contain user or project data.
func gmailForbidden(body io.Reader) error {
	type reason struct {
		Reason string `json:"reason"`
	}
	var response struct {
		Error struct {
			Errors  []reason `json:"errors"`
			Details []reason `json:"details"`
		} `json:"error"`
	}
	if json.NewDecoder(io.LimitReader(body, 32<<10)).Decode(&response) == nil {
		for _, item := range append(response.Error.Details, response.Error.Errors...) {
			switch item.Reason {
			case "SERVICE_DISABLED", "accessNotConfigured":
				return errors.New("GMAIL_API_NOT_CONFIGURED: check that the Gmail API is enabled in the Google Cloud project for this OAuth client")
			case "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientPermissions":
				return errors.New("GMAIL_SCOPE_INSUFFICIENT: reconnect the mailbox and grant Gmail read access")
			case "domainPolicy":
				return errors.New("GMAIL_DOMAIN_POLICY: ask your Google Workspace administrator to allow this app")
			case "rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "RATE_LIMIT_EXCEEDED", "QUOTA_EXCEEDED":
				return errors.New("GMAIL_RATE_LIMITED")
			}
		}
	}
	return errors.New("GMAIL_ACCESS_DENIED: Google returned no recognized reason")
}

// gmailMessage projects the provider response to the fields an agent needs.
func gmailMessage(data map[string]any) map[string]any {
	payload, _ := data["payload"].(map[string]any)
	headers := map[string]string{}
	fields, _ := payload["headers"].([]any)
	for _, value := range fields {
		header, _ := value.(map[string]any)
		name, _ := header["name"].(string)
		text, _ := header["value"].(string)
		switch name = strings.ToLower(name); name {
		case "from", "to", "subject", "date":
			headers[name] = text
		}
	}
	var body strings.Builder
	appendPlainText(&body, payload)
	return map[string]any{
		"id": data["id"], "threadId": data["threadId"], "snippet": data["snippet"],
		"headers": headers, "text": body.String(),
	}
}

func appendPlainText(result *strings.Builder, part map[string]any) {
	if part["mimeType"] == "text/plain" {
		body, _ := part["body"].(map[string]any)
		encoded, _ := body["data"].(string)
		decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(encoded, "="))
		if err == nil && len(decoded) > 0 {
			if result.Len() > 0 {
				result.WriteByte('\n')
			}
			result.WriteString(string(decoded))
		}
	}
	children, _ := part["parts"].([]any)
	for _, value := range children {
		child, _ := value.(map[string]any)
		appendPlainText(result, child)
	}
}
