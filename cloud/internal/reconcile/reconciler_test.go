package reconcile

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/cloud/internal/domain"
	"github.com/aoagents/agent-orchestrator/cloud/internal/sandbox"
)

type workerSpecStore struct {
	Store
	issued int
}

func (s *workerSpecStore) IssueAccessTicket(
	context.Context, string, string, string, []string, time.Duration,
) (string, error) {
	s.issued++
	return "bootstrap-ticket", nil
}

func TestWorkerSpecUsesPersistedCoderWorkspaceLayout(t *testing.T) {
	t.Parallel()
	store := &workerSpecStore{}
	reconciler := New(store, nil, Options{PublicURL: "https://cloud.example.com"})
	profile := json.RawMessage(`{"coder":{"baseUrl":"https://coder.example.com","owner":"planned-owner","templateId":"2a2e262c-b31c-4202-946d-a19ad45d1fd2","parameters":{"region":"us-west-2"},"durableRoot":"/customer/persistent"}}`)
	spec, err := reconciler.workerSpec(context.Background(), domain.Sandbox{
		SessionID: "session-1", OrgID: "org-1", Provider: sandbox.ProviderCoder,
		ResourceProfile: profile,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"AO_WORKSPACE_DIR":  "/customer/persistent/repository",
		"AO_DATA_DIR":       "/customer/persistent/.ao/worker",
		"HOME":              "/customer/persistent/.ao/home",
		"CLAUDE_CONFIG_DIR": "/customer/persistent/.ao/home/.claude",
		"CODEX_HOME":        "/customer/persistent/.ao/home/.codex",
	}
	for key, expected := range want {
		if spec.Environment[key] != expected {
			t.Errorf("%s = %q, want %q", key, spec.Environment[key], expected)
		}
	}
	if spec.DurableRoot != "/customer/persistent" {
		t.Errorf("DurableRoot = %q", spec.DurableRoot)
	}
}

func TestWorkerSpecAdvertisesWorkerBinaryHashes(t *testing.T) {
	t.Parallel()
	workerBin := []byte("fake ao-worker binary")
	helperBin := []byte("fake ao helper binary")
	reconciler := New(&workerSpecStore{}, nil, Options{
		PublicURL:          "https://cloud.example.com",
		WorkerBinary:       workerBin,
		WorkerHelperBinary: helperBin,
	})
	spec, err := reconciler.workerSpec(context.Background(), domain.Sandbox{
		SessionID: "session-1", OrgID: "org-1", Provider: sandbox.ProviderNodeOps,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := spec.Environment["AO_WORKER_EXPECTED_SHA256"]; got != sha256HexOf(workerBin) {
		t.Fatalf("AO_WORKER_EXPECTED_SHA256 = %q, want %q", got, sha256HexOf(workerBin))
	}
	if got := spec.Environment["AO_WORKER_HELPER_EXPECTED_SHA256"]; got != sha256HexOf(helperBin) {
		t.Fatalf("AO_WORKER_HELPER_EXPECTED_SHA256 = %q, want %q", got, sha256HexOf(helperBin))
	}
	if spec.Environment["AO_WORKER_HELPER_PATH"] == "" {
		t.Fatal("AO_WORKER_HELPER_PATH must be advertised so the helper self-update can shadow the baked copy")
	}
}

func TestWorkerSpecOmitsHashesWithoutBinary(t *testing.T) {
	t.Parallel()
	reconciler := New(&workerSpecStore{}, nil, Options{PublicURL: "https://cloud.example.com"})
	spec, err := reconciler.workerSpec(context.Background(), domain.Sandbox{
		SessionID: "session-1", OrgID: "org-1", Provider: sandbox.ProviderNodeOps,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := spec.Environment["AO_WORKER_EXPECTED_SHA256"]; ok {
		t.Fatal("no worker binary configured: the self-update env must be absent so self-update stays inert")
	}
}

func TestWorkerSpecPreservesOtherProviderWorkspaceLayout(t *testing.T) {
	t.Parallel()
	store := &workerSpecStore{}
	reconciler := New(store, nil, Options{PublicURL: "https://cloud.example.com"})
	spec, err := reconciler.workerSpec(context.Background(), domain.Sandbox{
		SessionID: "session-1", OrgID: "org-1", Provider: sandbox.ProviderNodeOps,
	})
	if err != nil {
		t.Fatal(err)
	}
	if spec.Environment["AO_WORKSPACE_DIR"] != "/workspace/repository" ||
		spec.Environment["AO_DATA_DIR"] != "/workspace/.ao/worker" || spec.DurableRoot != "" {
		t.Fatalf("unexpected non-Coder layout: %+v", spec)
	}
}

func TestWorkerSpecRejectsCoderWithoutDurableContractBeforeIssuingTicket(t *testing.T) {
	t.Parallel()
	store := &workerSpecStore{}
	reconciler := New(store, nil, Options{PublicURL: "https://cloud.example.com"})
	_, err := reconciler.workerSpec(context.Background(), domain.Sandbox{
		SessionID: "session-1", OrgID: "org-1", Provider: sandbox.ProviderCoder,
	})
	if err == nil || !strings.Contains(err.Error(), "session resource profile") {
		t.Fatalf("workerSpec error = %v", err)
	}
	if store.issued != 0 {
		t.Fatalf("issued %d bootstrap tickets for an invalid layout", store.issued)
	}
}

func TestCoderRestoreBootstrapRequiresDurableIdentity(t *testing.T) {
	t.Parallel()
	now := time.Now()
	reconciler := New(&workerSpecStore{}, nil, Options{})
	record := domain.Sandbox{
		SessionID: "session-1", Provider: sandbox.ProviderCoder, WorkerLastSeenAt: &now,
	}
	bootstrap := reconciler.workerBootstrap(record, sandbox.Spec{DurableRoot: "/mnt/ao"}, false)
	if !bootstrap.RequireDurableIdentity || bootstrap.DurableIdentity != "session-1" {
		t.Fatalf("unexpected restore bootstrap: %+v", bootstrap)
	}
	first := reconciler.workerBootstrap(domain.Sandbox{
		SessionID: "session-2", Provider: sandbox.ProviderCoder,
	}, sandbox.Spec{DurableRoot: "/mnt/ao"}, false)
	if first.RequireDurableIdentity {
		t.Fatal("first Coder bootstrap unexpectedly required an existing identity")
	}
}

// pausePathStore spies on the two store calls the pause path makes.
type pausePathStore struct {
	Store
	disconnected int
	observed     string
}

func (s *pausePathStore) DisconnectSessionWorkers(context.Context, string, string) error {
	s.disconnected++
	return nil
}

func (s *pausePathStore) UpdateSandboxObservation(
	_ context.Context, _, _, _, _, observedState, _ string, _ time.Time,
) error {
	s.observed = observedState
	return nil
}

// stopSpyProvider fakes just the two provider calls the pause path uses.
type stopSpyProvider struct {
	sandbox.Provider
	state   string
	stopped int
}

func (p *stopSpyProvider) Get(context.Context, sandbox.ID) (sandbox.Environment, error) {
	return sandbox.Environment{ID: "env-1", State: p.state}, nil
}

func (p *stopSpyProvider) Stop(context.Context, sandbox.ID) error {
	p.stopped++
	return nil
}

type fixedResolver struct{ provider sandbox.Provider }

func (r fixedResolver) Resolve(context.Context, domain.Sandbox) (sandbox.Provider, error) {
	return r.provider, nil
}

// Pausing a running sandbox must stop the provider AND disconnect its worker,
// so a subsequent terminal keystroke sees "no worker" and wakes the box instead
// of enqueuing input to a dead worker that expires unclaimed.
func TestReconcilePauseDisconnectsWorker(t *testing.T) {
	t.Parallel()
	store := &pausePathStore{}
	provider := &stopSpyProvider{state: sandbox.StateRunning}
	reconciler := New(store, fixedResolver{provider}, Options{})
	if err := reconciler.reconcileSandbox(context.Background(), domain.Sandbox{
		SessionID: "session-1", OrgID: "org-1", Provider: sandbox.ProviderNodeOps,
		DesiredState:          domain.SandboxDesiredPaused,
		ObservedState:         domain.SandboxObservedRunning,
		ProviderEnvironmentID: "env-1",
	}); err != nil {
		t.Fatalf("reconcileSandbox: %v", err)
	}
	if provider.stopped != 1 {
		t.Fatalf("provider.Stop called %d times, want 1", provider.stopped)
	}
	if store.disconnected != 1 {
		t.Fatalf("DisconnectSessionWorkers called %d times, want 1", store.disconnected)
	}
	if store.observed != domain.SandboxObservedStopped {
		t.Fatalf("observed = %q, want %q", store.observed, domain.SandboxObservedStopped)
	}
}

// A sandbox already stopped provider-side must not re-stop or re-disconnect on
// every reconcile tick while it stays paused.
func TestReconcilePauseAlreadyStoppedSkipsDisconnect(t *testing.T) {
	t.Parallel()
	store := &pausePathStore{}
	provider := &stopSpyProvider{state: sandbox.StateStopped}
	reconciler := New(store, fixedResolver{provider}, Options{})
	if err := reconciler.reconcileSandbox(context.Background(), domain.Sandbox{
		SessionID: "session-1", OrgID: "org-1", Provider: sandbox.ProviderNodeOps,
		DesiredState:          domain.SandboxDesiredPaused,
		ObservedState:         domain.SandboxObservedStopped,
		ProviderEnvironmentID: "env-1",
	}); err != nil {
		t.Fatalf("reconcileSandbox: %v", err)
	}
	if provider.stopped != 0 {
		t.Fatalf("provider.Stop called %d times on an already-stopped env, want 0", provider.stopped)
	}
	if store.disconnected != 0 {
		t.Fatalf("DisconnectSessionWorkers called %d times on an already-stopped env, want 0", store.disconnected)
	}
}
