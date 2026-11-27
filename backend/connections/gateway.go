package connections

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"database/sql"

	"cowork/cowork"
	"github.com/coreos/go-oidc/v3/oidc"
	jose "github.com/go-jose/go-jose/v4"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

const gmailScope = "https://www.googleapis.com/auth/gmail.readonly"

type app struct {
	db                       *sql.DB
	key                      cipher.AEAD
	clerk                    *oidc.IDTokenVerifier
	google                   *oauth2.Config
	googleIdentity           *oidc.IDTokenVerifier
	github                   *oauth2.Config
	githubAppSlug            string
	origin, issuer, resource string
	testers                  map[string]bool
	httpClient               *http.Client
	gmailBase                string
}

type claims struct {
	OAuth   bool     `json:"-"`
	Session string   `json:"sid"`
	Origin  string   `json:"azp"`
	Client  string   `json:"client_id"`
	Scope   string   `json:"scope"`
	Scopes  []string `json:"scp"`
}

func configure() (*app, error) {
	ctx := context.Background()
	for _, name := range []string{"LOCAL_ENCRYPTION_KEY", "COWORK_PUBLIC_URL"} {
		if os.Getenv(name) == "" {
			return nil, fmt.Errorf("%s is required", name)
		}
	}
	key, err := base64.StdEncoding.DecodeString(os.Getenv("LOCAL_ENCRYPTION_KEY"))
	if err != nil || len(key) != 32 {
		return nil, errors.New("LOCAL_ENCRYPTION_KEY must be 32 base64-encoded bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	vault, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	issuer := strings.TrimSpace(os.Getenv("CLERK_ISSUER"))
	if issuer == "" {
		issuer = strings.TrimSpace(os.Getenv("COWORK_CLERK_ISSUER"))
	}
	if coworkIssuer := strings.TrimSpace(os.Getenv("COWORK_CLERK_ISSUER")); coworkIssuer != "" && coworkIssuer != issuer {
		return nil, errors.New("Agent Connections requires the same Clerk issuer as Cowork")
	}
	parsed, err := url.Parse(issuer)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("CLERK_ISSUER must be an HTTPS origin with no trailing slash")
	}

	origin := strings.TrimRight(os.Getenv("COWORK_PUBLIC_URL"), "/")
	appURL, err := url.Parse(origin)
	if err != nil || !validPublicURL(appURL, "") {
		return nil, errors.New("COWORK_PUBLIC_URL must be an HTTPS or loopback HTTP origin with no trailing slash")
	}

	a := &app{
		key: vault, issuer: issuer, origin: origin,
		resource: origin + "/mcp", testers: map[string]bool{},
		httpClient: &http.Client{Timeout: 15 * time.Second}, gmailBase: "https://gmail.googleapis.com/gmail/v1/users/me",
	}
	for _, id := range strings.Split(os.Getenv("TESTER_SUBJECTS"), ",") {
		if id = strings.TrimSpace(id); id != "" {
			a.testers[id] = true
		}
	}
	if resource := os.Getenv("MCP_RESOURCE_URL"); resource != "" {
		endpoint, err := url.Parse(resource)
		if err != nil || !validPublicURL(endpoint, "/mcp") {
			return nil, errors.New("MCP_RESOURCE_URL must be an HTTPS or loopback HTTP URL ending in /mcp")
		}
		a.resource = resource
	}
	ctx = oidc.ClientContext(ctx, a.httpClient)
	a.clerk = oidc.NewVerifier(issuer, oidc.NewRemoteKeySet(ctx, issuer+"/.well-known/jwks.json"), &oidc.Config{SkipClientIDCheck: true})
	if id, secret := os.Getenv("GOOGLE_CLIENT_ID"), os.Getenv("GOOGLE_CLIENT_SECRET"); id != "" && secret != "" {
		a.google = &oauth2.Config{ClientID: id, ClientSecret: secret,
			Endpoint: google.Endpoint, RedirectURL: a.origin + browserPrefix + "/google/callback", Scopes: []string{"openid", "email", gmailScope}}
		a.googleIdentity = oidc.NewVerifier("https://accounts.google.com", oidc.NewRemoteKeySet(ctx, "https://www.googleapis.com/oauth2/v3/certs"), &oidc.Config{ClientID: id})
	}
	a.githubAppSlug = os.Getenv("GITHUB_APP_SLUG")
	if a.githubAppSlug != "" && !githubAppSlugPattern.MatchString(a.githubAppSlug) {
		return nil, errors.New("GITHUB_APP_SLUG must be the slug from the GitHub App installation URL")
	}
	if id, secret := os.Getenv("GITHUB_CLIENT_ID"), os.Getenv("GITHUB_CLIENT_SECRET"); id != "" && secret != "" {
		a.github = &oauth2.Config{ClientID: id, ClientSecret: secret, RedirectURL: origin + githubCallback,
			Endpoint: oauth2.Endpoint{AuthURL: "https://github.com/login/oauth/authorize", TokenURL: "https://github.com/login/oauth/access_token", AuthStyle: oauth2.AuthStyleInParams}}
	}
	return a, nil
}

func validPublicURL(endpoint *url.URL, path string) bool {
	if endpoint.Hostname() == "" || endpoint.User != nil || endpoint.EscapedPath() != path ||
		endpoint.RawQuery != "" || endpoint.ForceQuery || endpoint.Fragment != "" {
		return false
	}
	if endpoint.Scheme == "https" {
		return true
	}
	host := endpoint.Hostname()
	return endpoint.Scheme == "http" && (host == "localhost" || host == "127.0.0.1")
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+browserPrefix+"/workspace/key", a.browser(a.workspaceKey))
	mux.HandleFunc("POST "+browserPrefix+"/workspace/key", a.browser(a.workspaceKey))
	mux.HandleFunc("DELETE "+browserPrefix+"/workspace/key", a.browser(a.workspaceKey))
	mux.HandleFunc("POST "+browserPrefix+"/github/start", a.browser(a.startGitHub))
	mux.HandleFunc("GET "+githubCallback, a.finishGitHub)
	mux.HandleFunc("GET "+githubSetup, a.setupGitHub)
	mux.HandleFunc("GET "+browserPrefix+"/activity", a.browser(a.listActivity))
	mux.HandleFunc("GET "+browserPrefix+"/connections", a.browser(a.listConnections))
	mux.HandleFunc("GET "+browserPrefix+"/providers", a.browser(a.providers))
	mux.HandleFunc("POST "+browserPrefix+"/connections/ssh", a.browser(a.createSSH))
	mux.HandleFunc("POST "+browserPrefix+"/google/start", a.browser(a.startGoogle))
	mux.HandleFunc("GET "+browserPrefix+"/google/callback", a.finishGoogle)
	mux.HandleFunc("DELETE "+browserPrefix+"/connections/{id}", a.browser(a.disconnect))
	mux.HandleFunc("POST "+browserPrefix+"/connections/{id}/agents", a.browser(a.createAgent))
	mux.HandleFunc("PUT "+browserPrefix+"/connections/{id}/grants/{client}", a.browser(a.grant))
	mux.HandleFunc("DELETE "+browserPrefix+"/connections/{id}/grants/{client}", a.browser(a.grant))
	a.mountMCP(mux)
	return mux
}

func (a *app) browser(next func(http.ResponseWriter, *http.Request, string, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		subject, session, status := cowork.AgentConnectionsIdentity(w, r)
		if status != http.StatusOK {
			http.Error(w, "Cowork workspace owner access required.", status)
			return
		}
		if r.Method != http.MethodGet && !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "Use a JSON request.", http.StatusUnsupportedMediaType)
			return
		}
		next(w, r, subject, session)
	}
}

var (
	errBearerRequired     = errors.New("bearer required")
	errTesterRequired     = errors.New("tester access required")
	errInvalidSignedToken = errors.New("invalid signed token")
)

func (a *app) verify(r *http.Request) (*oidc.IDToken, claims, error) {
	var c claims
	scheme, bearer, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	if !strings.EqualFold(scheme, "Bearer") || bearer == "" {
		return nil, c, errBearerRequired
	}
	signed, err := jose.ParseSigned(bearer, []jose.SignatureAlgorithm{jose.RS256})
	if err != nil || len(signed.Signatures) != 1 {
		return nil, c, errInvalidSignedToken
	}
	typ := signed.Signatures[0].Header.ExtraHeaders[jose.HeaderType]
	tok, err := a.clerk.Verify(r.Context(), bearer)
	if err != nil {
		return nil, c, err
	}
	if tok.Subject == "" || !a.canUseOwner(tok.Subject) {
		return nil, c, errTesterRequired
	}
	err = tok.Claims(&c)
	c.OAuth = typ == "at+jwt" || typ == "application/at+jwt"
	return tok, c, err
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(value)
}

func randomID() string {
	return base64.RawURLEncoding.EncodeToString(randBytes(32))
}

func randBytes(size int) []byte {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		panic("random source unavailable")
	}
	return value
}

func (a *app) providers(w http.ResponseWriter, _ *http.Request, _, _ string) {
	writeJSON(w, map[string]bool{"github": a.github != nil, "gmail": a.google != nil})
}

func (a *app) canUseOwner(owner string) bool {
	return a.testers[owner] || cowork.AgentConnectionsOwnerExists(owner)
}
