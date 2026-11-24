package cowork

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGitTokenSettings(t *testing.T) {
	t.Setenv("AGENT_CONNECTION_ENCRYPTION_KEY", "")
	useTestPostgres(t)
	d, err := load()
	if err != nil {
		t.Fatal(err)
	}
	space := &Workspace{ID: "workspace", Owner: "owner"}
	d.Workspaces[space.ID] = space
	owner := Account{ID: "owner", Workspace: space.ID}
	member := Account{ID: "member", Workspace: space.ID}
	const github = "github_pat_example"
	const gitlab = "glpat-example"
	update := func(account Account, body string, status int) {
		t.Helper()
		reply := httptest.NewRecorder()
		updateGitToken(reply, httptest.NewRequest("POST", "/api/git-token", strings.NewReader(body)), d, account, space)
		if reply.Code != status || strings.Contains(reply.Body.String(), github) || strings.Contains(reply.Body.String(), gitlab) {
			t.Fatalf("unexpected token settings response, status %d", reply.Code)
		}
	}
	update(member, `{"Provider":"github","Token":"github_pat_example"}`, 403)
	update(owner, `{"Provider":"example","Token":"github_pat_example"}`, 400)
	update(owner, `{"Provider":"github","Token":"github_pat_example"}`, 200)
	update(owner, `{"Provider":"gitlab","Token":"glpat-example"}`, 200)
	saved, err := load()
	if err != nil {
		t.Fatal(err)
	}
	stored := saved.GitTokens[space.ID]
	for _, ciphertext := range stored {
		if !strings.HasPrefix(ciphertext, agentConnectionCiphertextPrefix) || strings.Contains(ciphertext, github) || strings.Contains(ciphertext, gitlab) {
			t.Fatal("expected encrypted token in PostgreSQL")
		}
	}
	tokens, err := unlockGitTokens(space.ID, stored)
	if err != nil || tokens["github"] != github || tokens["gitlab"] != gitlab {
		t.Fatal("saved tokens did not round trip")
	}
	if _, err := unlockGitTokens("other-workspace", stored); err == nil {
		t.Fatal("token decrypted outside its workspace")
	}
	update(owner, `{"Provider":"github","Remove":true}`, 200)
	if status := gitTokenStatus(d.GitTokens[space.ID]); status["github"] || !status["gitlab"] {
		t.Fatal("removing the GitHub token should preserve the GitLab token")
	}
}
