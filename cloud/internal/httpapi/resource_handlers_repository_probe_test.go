package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/cloud/internal/domain"
	"github.com/go-chi/chi/v5"
)

// repositoryProbeFakeStore records whether CreateProject was reached, so a
// rejected (unreachable) repository can be proven to never create a project
// row or provision a sandbox for it.
type repositoryProbeFakeStore struct {
	Store
	created int
}

func (s *repositoryProbeFakeStore) CreateProject(
	context.Context, domain.Principal, string, string, domain.CreateProject,
) (domain.Project, error) {
	s.created++
	return domain.Project{ID: "proj-1", DisplayName: "widgets"}, nil
}

const repositoryProbeOrgID = "00000000-0000-0000-0000-0000000000aa"

func newRepositoryProbeTestServer(t *testing.T, probeClient *http.Client) (*Server, *repositoryProbeFakeStore) {
	t.Helper()
	store := &repositoryProbeFakeStore{}
	srv := New(Options{
		Store:                 store,
		RepositoryProbeClient: probeClient,
		Logger:                slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	return srv, store
}

func createProjectRequestFor(t *testing.T, repositoryURL string) *http.Request {
	t.Helper()
	body, err := json.Marshal(createProjectRequest{
		DisplayName: "widgets", RepositoryURL: repositoryURL, DefaultBranch: "main",
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/orgs/"+repositoryProbeOrgID+"/projects", bytes.NewReader(body))
	req.Header.Set("Idempotency-Key", "test-key-1")

	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("orgId", repositoryProbeOrgID)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)
	ctx = context.WithValue(ctx, principalKey, domain.Principal{UserID: "00000000-0000-0000-0000-000000000001"})
	return req.WithContext(ctx)
}

// gitSmartHTTPFake answers the git smart-HTTP info/refs probe the way a real
// host does: 200 for a repository that exists and is reachable, 404
// otherwise (git and GitHub both collapse "doesn't exist" and "private, no
// access" into the same answer, on purpose).
func gitSmartHTTPFake(reachable bool) *httptest.Server {
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("service") != "git-upload-pack" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if reachable {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
}

func TestCreateProjectAcceptsAReachableRepository(t *testing.T) {
	fake := gitSmartHTTPFake(true)
	t.Cleanup(fake.Close)
	srv, store := newRepositoryProbeTestServer(t, fake.Client())

	w := httptest.NewRecorder()
	srv.createProject(w, createProjectRequestFor(t, fake.URL+"/octo/widgets.git"))

	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", w.Code, w.Body.String())
	}
	if store.created != 1 {
		t.Fatalf("CreateProject called %d times, want 1", store.created)
	}
}

// This is the fix: today the same case creates the project anyway and only
// fails later, inside a sandbox, at checkout — an opaque failure far from the
// form the user could have fixed it on.
func TestCreateProjectRejectsAnUnreachableRepositoryBeforeCreating(t *testing.T) {
	fake := gitSmartHTTPFake(false)
	t.Cleanup(fake.Close)
	srv, store := newRepositoryProbeTestServer(t, fake.Client())

	w := httptest.NewRecorder()
	srv.createProject(w, createProjectRequestFor(t, fake.URL+"/octo/private-or-typo.git"))

	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422; body=%s", w.Code, w.Body.String())
	}
	if store.created != 0 {
		t.Fatalf("CreateProject called %d times, want 0 — an unreachable repository must not be created", store.created)
	}
}

// A probe that cannot even reach the network (here: nothing listening) must
// not block project creation — that is an infrastructure hiccup, not the
// repository's own answer. Loopback only; no real network call.
func TestProbeRepositoryReachableFailsOpenOnConnectionError(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a loopback port: %v", err)
	}
	deadAddr := listener.Addr().String()
	_ = listener.Close() // nothing is listening here now

	srv := New(Options{
		Store:                 &repositoryProbeFakeStore{},
		RepositoryProbeClient: &http.Client{Timeout: 2 * time.Second},
		Logger:                slog.New(slog.NewTextHandler(io.Discard, nil)),
	})

	if !srv.probeRepositoryReachable(context.Background(), "https://"+deadAddr+"/octo/widgets.git") {
		t.Fatal("probeRepositoryReachable = false on a connection error, want true (fail open)")
	}
}
