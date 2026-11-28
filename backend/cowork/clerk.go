package cowork

import (
	"context"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/clerk/clerk-sdk-go/v2"
	clerkhttp "github.com/clerk/clerk-sdk-go/v2/http"
	"github.com/clerk/clerk-sdk-go/v2/jwks"
	"github.com/clerk/clerk-sdk-go/v2/user"
)

type clerkClients struct {
	keys  *jwks.Client
	users *user.Client
}

var clerkBackend = sync.OnceValue(func() clerkClients {
	secret := strings.TrimSpace(os.Getenv("CLERK_SECRET_KEY"))
	config := &clerk.ClientConfig{BackendConfig: clerk.BackendConfig{
		Key: &secret, HTTPClient: &http.Client{Timeout: 5 * time.Second},
	}}
	return clerkClients{jwks.NewClient(config), user.NewClient(config)}
})

func clerkEnabled() bool {
	return os.Getenv("COWORK_AUTH") == "clerk"
}

func clerkSessionCookie(r *http.Request) (*http.Cookie, error) {
	publishableKey := os.Getenv("CLERK_PUBLISHABLE_KEY")
	if publishableKey == "" {
		publishableKey = os.Getenv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")
	}
	if publishableKey != "" {
		// Clerk namespaces session cookies with a hash of its public key.
		digest := sha1.Sum([]byte(publishableKey))
		name := "__session_" + base64.RawURLEncoding.EncodeToString(digest[:6])
		if cookie, err := r.Cookie(name); err == nil && cookie.Value != "" {
			return cookie, nil
		}
	}
	return r.Cookie("__session")
}

func clerkSession(w http.ResponseWriter, r *http.Request) (string, string) {
	issuer := strings.TrimSpace(os.Getenv("COWORK_CLERK_ISSUER"))
	origin := strings.TrimRight(strings.TrimSpace(os.Getenv("COWORK_PUBLIC_URL")), "/")
	cookie, err := clerkSessionCookie(r)
	if err != nil || issuer == "" || origin == "" || os.Getenv("CLERK_SECRET_KEY") == "" {
		return "", ""
	}
	if requestOrigin := r.Header.Get("Origin"); requestOrigin != "" && requestOrigin != origin {
		return "", ""
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	var subject, sessionID string
	clerkhttp.WithHeaderAuthorization(
		clerkhttp.JWKSClient(clerkBackend().keys),
		clerkhttp.AuthorizationJWTExtractor(func(*http.Request) string { return cookie.Value }),
		clerkhttp.AuthorizedParty(func(party string) bool { return party == origin }),
		clerkhttp.AuthorizationFailureHandler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})),
		func(params *clerkhttp.AuthorizationParams) error { params.ProxyURL = &issuer; return nil },
	)(http.HandlerFunc(func(_ http.ResponseWriter, authenticated *http.Request) {
		if claims, ok := clerk.SessionClaimsFromContext(authenticated.Context()); ok && claims.SessionID != "" && claims.Expiry != nil {
			subject = claims.Subject
			sessionID = claims.SessionID
		}
	})).ServeHTTP(w, r.WithContext(ctx))
	return subject, sessionID
}

// AgentConnectionsIdentity authenticates an owner using Cowork's workspace rules.
func AgentConnectionsIdentity(w http.ResponseWriter, r *http.Request) (string, string, int) {
	if !clerkEnabled() {
		return "", "", http.StatusServiceUnavailable
	}
	subject, session := clerkSession(w, r)
	if subject == "" {
		return "", "", http.StatusUnauthorized
	}
	if !AgentConnectionsOwnerExists(subject) {
		return "", "", http.StatusForbidden
	}
	return subject, session, http.StatusOK
}

func AgentConnectionsOwnerExists(subject string) bool {
	if !clerkEnabled() || subject == "" {
		return false
	}
	mutex.Lock()
	defer mutex.Unlock()
	d, err := load()
	if err != nil {
		return false
	}
	account, ok := accountForClerk(d, subject)
	space := d.Workspaces[account.Workspace]
	return ok && space != nil && space.Owner == account.ID
}

func accountForClerk(d *database, subject string) (Account, bool) {
	if subject != "" {
		for _, account := range d.Accounts {
			if account.ClerkID == subject {
				return account, true
			}
		}
	}
	return Account{}, false
}

type clerkProfile struct {
	ID, Email, Name, ExternalID string
}

func profileForClerk(ctx context.Context, subject string) (clerkProfile, error) {
	person, err := clerkBackend().users.Get(ctx, subject)
	if err != nil {
		return clerkProfile{}, err
	}
	if person.ID != subject || person.PrimaryEmailAddressID == nil || person.Banned || person.Locked {
		return clerkProfile{}, errors.New("Clerk account is unavailable")
	}
	var email string
	for _, address := range person.EmailAddresses {
		if address.ID == *person.PrimaryEmailAddressID && address.Verification != nil && address.Verification.Status == "verified" {
			email = strings.ToLower(strings.TrimSpace(address.EmailAddress))
			break
		}
	}
	if email == "" || len(email) > 254 {
		return clerkProfile{}, errors.New("a verified primary email is required")
	}
	name := strings.TrimSpace(strings.Join([]string{stringValue(person.FirstName), stringValue(person.LastName)}, " "))
	if name == "" {
		name, _, _ = strings.Cut(email, "@")
	}
	if runes := []rune(name); len(runes) > 80 {
		name = string(runes[:80])
	}
	return clerkProfile{ID: subject, Email: email, Name: name, ExternalID: stringValue(person.ExternalID)}, nil
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func linkClerkAccount(w http.ResponseWriter, d *database, profile clerkProfile, account Account, password string) {
	imported := profile.ExternalID != "" && profile.ExternalID == account.ID
	if account.ClerkID != "" || (!imported && (account.Password == "" || len(password) > 128 ||
		subtle.ConstantTimeCompare([]byte(account.Password), []byte(digest(password, account.Salt))) != 1)) {
		fail(w, http.StatusForbidden, "Could not verify the existing Cowork account.")
		return
	}
	account.ClerkID = profile.ID
	d.Accounts[account.Email] = account
	if save(d) != nil {
		fail(w, http.StatusConflict, "Could not link the account. Try again.")
		return
	}
	view(w, d, account)
}

type workspaceAgent struct {
	ID, Role, Name string
	Channel        string   `json:",omitempty"`
	ConnectionIDs  []string `json:",omitempty"`
}

var providerConnectionID = regexp.MustCompile(`^[a-zA-Z0-9_-]{30,80}$`)

func updateAgentGrants(w http.ResponseWriter, r *http.Request, d *database, account Account, space *Workspace) {
	if account.ID != space.Owner {
		fail(w, http.StatusForbidden, "Workspace owner access required.")
		return
	}
	var input struct{ Grants map[string][]string }
	if !decode(w, r, &input) {
		return
	}
	for agentID, ids := range input.Grants {
		if _, exists := space.agent(agentID); agentID == "" || !exists || len(ids) > 100 {
			fail(w, http.StatusBadRequest, "Invalid agent access selection.")
			return
		}
		for _, id := range ids {
			if !providerConnectionID.MatchString(id) {
				fail(w, http.StatusBadRequest, "Invalid connection selection.")
				return
			}
		}
	}
	for i := range space.Agents {
		space.Agents[i].ConnectionIDs = input.Grants[space.Agents[i].ID]
	}
	if save(d) != nil {
		fail(w, http.StatusConflict, "Could not update agent access. Try again.")
		return
	}
	view(w, d, account)
}

var onboardingRoles = map[string]string{
	"developer": "Developer", "product-manager": "Product Manager",
	"sales-lead": "Sales Lead", "social-media": "Social Media",
}

func onboardingAPI(w http.ResponseWriter, r *http.Request, d *database, profile clerkProfile) {
	var input struct {
		Agents   []workspaceAgent
		Invite   string
		Password string
		Step     string
		Channel  string
	}
	if r.Method == http.MethodPost && !decode(w, r, &input) {
		return
	}
	account, exists := accountForClerk(d, profile.ID)
	if !exists {
		legacy, existing := d.Accounts[profile.Email]
		// Clerk's server-managed external ID preserves ownership if imported users change email.
		if profile.ExternalID != "" && (!existing || profile.ExternalID != legacy.ID) {
			for _, candidate := range d.Accounts {
				if candidate.ID == profile.ExternalID {
					if existing && candidate.ID != legacy.ID {
						fail(w, http.StatusConflict, "This Clerk email is associated with a different Cowork account.")
						return
					}
					legacy, existing = candidate, true
					break
				}
			}
		}
		if existing {
			if r.Method == http.MethodPost {
				linkClerkAccount(w, d, profile, legacy, input.Password)
			} else {
				jsonReply(w, http.StatusOK, map[string]bool{"LinkRequired": true, "Imported": profile.ExternalID == legacy.ID})
			}
			return
		}
		if r.Method == http.MethodGet {
			jsonReply(w, http.StatusOK, map[string]bool{"NewWorkspace": true})
			return
		}
		account = Account{ID: key(), Name: profile.Name, Email: profile.Email, ClerkID: profile.ID}
		if invite := strings.TrimSpace(input.Invite); invite != "" {
			for _, space := range d.Workspaces {
				if space.Invite == invite {
					account.Workspace = space.ID
					break
				}
			}
			if account.Workspace == "" {
				fail(w, http.StatusBadRequest, "That workspace invite is invalid.")
				return
			}
		} else {
			agents, err := onboardingAgents(input.Agents)
			if err != nil {
				fail(w, http.StatusBadRequest, err.Error())
				return
			}
			account.Workspace = key()
			d.Workspaces[account.Workspace] = &Workspace{
				ID: account.Workspace, Role: agents[0].Role, Owner: account.ID, Invite: key(),
				Agents: agents, OnboardingStep: "tools", Channels: map[string]string{},
			}
		}
		d.Accounts[profile.Email] = account
	} else if r.Method == http.MethodPost {
		space := d.Workspaces[account.Workspace]
		if account.ID != space.Owner {
			fail(w, http.StatusForbidden, "Workspace owner access required.")
			return
		}
		switch {
		case input.Step == "channels" && space.OnboardingStep == "tools":
			space.OnboardingStep = "channels"
		case input.Step == "complete" && space.OnboardingStep == "channels":
			if input.Channel != "cowork" && input.Channel != "slack" && input.Channel != "telegram" {
				fail(w, http.StatusBadRequest, "Choose where to work with your agents.")
				return
			}
			for i := range space.Agents {
				space.Agents[i].Channel = input.Channel
			}
			space.OnboardingStep = ""
		default:
			view(w, d, account)
			return
		}
	}
	if r.Method == http.MethodPost && save(d) != nil {
		fail(w, http.StatusConflict, "Could not save workspace setup. Try again.")
		return
	}
	if !exists && r.Method == http.MethodPost {
		w.Header().Set("X-Cowork-New-Account", "1")
	}
	view(w, d, account)
}

func onboardingAgents(choices []workspaceAgent) ([]workspaceAgent, error) {
	if len(choices) == 0 || len(choices) > len(onboardingRoles) {
		return nil, errors.New("Choose at least one agent.")
	}
	seen := make(map[string]bool, len(choices))
	for i := range choices {
		choice := &choices[i]
		role, ok := onboardingRoles[choice.ID]
		if !ok || seen[choice.ID] {
			return nil, errors.New("Choose each available agent only once.")
		}
		seen[choice.ID] = true
		name, err := workspaceAgentName(choice.Name, role)
		if err != nil {
			return nil, err
		}
		*choice = workspaceAgent{ID: choice.ID, Role: role, Name: name}
	}
	return choices, nil
}

func (space *Workspace) agent(id string) (workspaceAgent, bool) {
	for _, agent := range space.Agents {
		if agent.ID == id {
			return agent, true
		}
	}
	if id == "" {
		if len(space.Agents) > 0 {
			return space.Agents[0], true
		}
		return workspaceAgent{Role: space.Role, Name: space.Role + " agent"}, true
	}
	return workspaceAgent{}, false
}

func (space *Workspace) threadAgent(id string) workspaceAgent {
	for _, thread := range space.Threads {
		if thread.ID == id {
			if agent, ok := space.agent(thread.AgentID); ok {
				return agent
			}
		}
	}
	agent, _ := space.agent("")
	return agent
}
