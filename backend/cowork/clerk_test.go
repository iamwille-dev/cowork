package cowork

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/clerk/clerk-sdk-go/v2"
	"github.com/clerk/clerk-sdk-go/v2/jwks"
	"github.com/clerk/clerk-sdk-go/v2/user"
	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

func TestClerkOnboarding(t *testing.T) {
	useTestPostgres(t)
	const issuer, origin = "https://clerk.cowork.test", "https://cowork.test"
	t.Setenv("COWORK_AUTH", "clerk")
	t.Setenv("COWORK_PUBLIC_URL", origin)
	t.Setenv("COWORK_CLERK_ISSUER", issuer)
	t.Setenv("CLERK_SECRET_KEY", "test")
	t.Setenv("CLERK_PUBLISHABLE_KEY", "fixture-public-key")
	cookieDigest := sha1.Sum([]byte("fixture-public-key"))
	cookieName := "__session_" + base64.RawURLEncoding.EncodeToString(cookieDigest[:6])
	private, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	verificationKey := jose.JSONWebKey{Key: &private.PublicKey, KeyID: "cowork-clerk-test", Algorithm: "RS256", Use: "sig"}
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/jwks":
			json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{verificationKey}})
		case "/users/user_new":
			w.Write([]byte(`{"id":"user_new","first_name":"Nora","primary_email_address_id":"ev1","email_addresses":[{"id":"ev1","email_address":"nora@example.test","verification":{"status":"verified"}}]}`))
		case "/users/user_existing":
			w.Write([]byte(`{"id":"user_existing","first_name":"Kim","primary_email_address_id":"ev2","email_addresses":[{"id":"ev2","email_address":"kim@example.test","verification":{"status":"verified"}}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(mock.Close)
	config := &clerk.ClientConfig{BackendConfig: clerk.BackendConfig{URL: &mock.URL, HTTPClient: mock.Client()}}
	previous := clerkBackend
	clerkBackend = func() clerkClients { return clerkClients{jwks.NewClient(config), user.NewClient(config)} }
	t.Cleanup(func() { clerkBackend = previous })
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: private}, (&jose.SignerOptions{}).WithHeader(jose.HeaderKey("kid"), verificationKey.KeyID))
	if err != nil {
		t.Fatal(err)
	}
	token := func(subject, party string) string {
		t.Helper()
		now := time.Now()
		value, err := jwt.Signed(signer).Claims(map[string]any{
			"sub": subject, "iss": issuer, "sid": "sess_fixture", "azp": party,
			"exp": now.Add(time.Minute).Unix(), "nbf": now.Add(-time.Second).Unix(),
		}).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	request := func(method, path, body, session string, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: cookieName, Value: session})
		result := httptest.NewRecorder()
		API(result, r)
		if result.Code != want {
			t.Fatalf("%s %s returned %d, want %d: %s", method, path, result.Code, want, result.Body.String())
		}
		return result
	}
	session := token("user_new", origin)
	request("GET", "/api/workspace", "", token("user_new", "https://wrong.test"), http.StatusUnauthorized)
	request("GET", "/api/workspace", "", session, http.StatusPreconditionRequired)
	request("GET", "/api/onboarding", "", session, http.StatusOK)
	request("POST", "/api/onboarding", `{"Agents":[{"ID":"not-an-agent"}]}`, session, http.StatusBadRequest)
	created := request("POST", "/api/onboarding", `{"Agents":[{"ID":"developer","Role":"invalid","Name":"Sammy"},{"ID":"sales-lead","Name":"Taylor"}]}`, session, http.StatusOK)
	if !strings.Contains(created.Body.String(), `"OnboardingStep":"tools"`) {
		t.Fatal(created.Body.String())
	}
	request("POST", "/api/agent-grants", `{"Grants":{"developer":["abcdefghijklmnopqrstuvwxyz0123456789"]}}`, session, http.StatusOK)
	request("POST", "/api/onboarding", `{"Step":"channels"}`, session, http.StatusOK)
	request("POST", "/api/onboarding", `{"Step":"complete","Channel":"cowork"}`, session, http.StatusOK)
	request("POST", "/api/thread", `{"Text":"Follow-ups","AgentID":"sales-lead"}`, session, http.StatusOK)
	request("POST", "/api/thread", `{"Text":"Invalid","AgentID":"other"}`, session, http.StatusBadRequest)

	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	newAccount := d.Accounts["nora@example.test"]
	space := d.Workspaces[newAccount.Workspace]
	if len(space.Agents) != 2 || space.Agents[0].Role != "Developer" || space.Agents[0].Name != "Sammy" ||
		len(space.Agents[0].ConnectionIDs) != 1 || space.OnboardingStep != "" || space.threadAgent(space.Threads[0].ID).Name != "Taylor" {
		t.Fatalf("unexpected workspace: %#v", space)
	}
	old := Account{ID: key(), Name: "Kim", Email: "kim@example.test", Salt: "fixture", Workspace: key()}
	old.Password = digest("test password", old.Salt)
	d.Accounts[old.Email] = old
	d.Workspaces[old.Workspace] = &Workspace{ID: old.Workspace, Owner: old.ID, Role: "Developer"}
	if err := save(d); err != nil {
		t.Fatal(err)
	}
	existing := token("user_existing", origin)
	response := request("GET", "/api/onboarding", "", existing, http.StatusOK)
	if !strings.Contains(response.Body.String(), `"LinkRequired":true`) {
		t.Fatal(response.Body.String())
	}
	request("POST", "/api/onboarding", `{"Password":"wrong password"}`, existing, http.StatusForbidden)
	request("POST", "/api/onboarding", `{"Password":"test password"}`, existing, http.StatusOK)
	linked := request("GET", "/api/workspace", "", existing, http.StatusOK)
	if !strings.Contains(linked.Body.String(), old.Workspace) || !strings.Contains(linked.Body.String(), old.ID) {
		t.Fatal("legacy account did not retain its workspace and account IDs")
	}
}
