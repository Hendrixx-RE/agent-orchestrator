/**
 * Onboarding demo mode.
 *
 * The new cloud onboarding flow (agent credential → repository → agent setup)
 * needs three control-plane behaviors that don't exist on any reachable
 * deployment yet: a verified-on-save GitHub token, a reachability check at
 * project create, and per-agent provider connections a fresh org has none of.
 * Building the UI against a real backend isn't possible until that ships, and
 * blocking the UI on it isn't necessary — the wire contract is already fixed
 * (see cloud/internal/httpapi/{provider_handlers,resource_handlers}.go on
 * this branch), so this fakes exactly that contract, in-memory, client-side.
 *
 * Everything else — sign-in, `/me`, the org, the real project list — passes
 * through to the real fetch untouched: this only intercepts the handful of
 * onboarding paths below. As each one lands on the control plane, delete its
 * case here; nothing above this file (the components, the hooks, the query
 * keys) changes when you do.
 *
 * On by default only when explicitly requested — see isCloudDemoModeEnabled.
 */

import type { CloudCpProviderConnection } from "./types";

const API_PREFIX = "/api/cloud/v1";
const DEMO_MODE_STORAGE_KEY = "ao.cloudDemoMode";

/** Enabled via `VITE_AO_CLOUD_DEMO=1` at build time, or toggled at runtime by
 * calling `window.__aoSetCloudDemoMode(true)` from the devtools console — both
 * exist so a demo can be armed without rebuilding. Never on by default. */
export function isCloudDemoModeEnabled(): boolean {
	if (import.meta.env.VITE_AO_CLOUD_DEMO === "1") return true;
	try {
		return window.localStorage.getItem(DEMO_MODE_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

declare global {
	interface Window {
		__aoSetCloudDemoMode?: (enabled: boolean) => void;
	}
}

if (typeof window !== "undefined") {
	window.__aoSetCloudDemoMode = (enabled: boolean) => {
		try {
			if (enabled) window.localStorage.setItem(DEMO_MODE_STORAGE_KEY, "1");
			else window.localStorage.removeItem(DEMO_MODE_STORAGE_KEY);
		} catch {
			// Storage unavailable (private mode, etc.) — the env var path still works.
		}
	};
}

type DemoConnection = CloudCpProviderConnection;

function nowIso(): string {
	return new Date().toISOString();
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function errorResponse(status: number, code: string, message: string): Response {
	return jsonResponse(status, { code, message });
}

/** A pasted secret "works" unless it announces itself as the failure demo —
 * matches the mockup's invalid-token state without needing a real provider. */
function secretLooksInvalid(secret: string): boolean {
	return /\b(bad|invalid|expired|revoked)\b/i.test(secret);
}

function demoConnection(provider: string, label: string): DemoConnection {
	const now = nowIso();
	return {
		id: `demo-${provider}-${label}`,
		provider,
		label,
		config: {},
		validationState: "valid",
		validatedAt: now,
		createdAt: now,
		updatedAt: now,
	};
}

const DEFAULT_AGENT_LABEL = "default";

// Module-scoped, not per-call: `useCloudCp()` memoizes a client per component
// instance, so CloudOnboardingGate, CloudCredentialDialog, CloudProjectCard
// and CloudAgentSetupStep each construct their own client. If this state
// lived inside createDemoCloudCpFetch's closure, a credential saved from one
// component's dialog would be invisible to another's — one shared store for
// the whole renderer session is what makes the demo behave like one backend.
// Keyed "provider:label", e.g. "claude-code:default" or "github:default".
const demoConnections = new Map<string, DemoConnection>();
let demoProjectSeq = 0;

/**
 * Wraps a real `fetch` so a fixed set of cloud control-plane onboarding paths
 * are served from in-memory state instead of the network. Everything else —
 * sign-in, `/me`, the org, the real project list — is passed straight
 * through to `realFetch`.
 */
export function createDemoCloudCpFetch(realFetch: typeof fetch): typeof fetch {
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const prefixIndex = url.pathname.indexOf(API_PREFIX);
		if (prefixIndex < 0) return realFetch(input, init);
		const path = url.pathname.slice(prefixIndex + API_PREFIX.length);
		const method = (init?.method ?? "GET").toUpperCase();
		const readBody = (): unknown => {
			if (init?.body === undefined || typeof init.body !== "string") return undefined;
			try {
				return JSON.parse(init.body) as unknown;
			} catch {
				return undefined;
			}
		};

		// PUT/DELETE /orgs/{orgId}/provider-connections/agents/{agent}
		let match = path.match(/^\/orgs\/[^/]+\/provider-connections\/agents\/([^/]+)$/);
		if (match) {
			const agent = decodeURIComponent(match[1]);
			const key = `${agent}:${DEFAULT_AGENT_LABEL}`;
			if (method === "PUT") {
				const body = readBody() as { secret?: string } | undefined;
				const secret = body?.secret ?? "";
				if (secret.length < 4) {
					return errorResponse(422, "validation_error", "The coding-agent credential is invalid.");
				}
				if (secretLooksInvalid(secret)) {
					return errorResponse(422, "invalid_credential", "This key doesn't work — check it hasn't expired or been revoked.");
				}
				const connection = demoConnection(agent, DEFAULT_AGENT_LABEL);
				demoConnections.set(key, connection);
				return jsonResponse(200, { providerConnection: connection });
			}
			if (method === "DELETE") {
				demoConnections.delete(key);
				return new Response(null, { status: 204 });
			}
		}

		// GET /orgs/{orgId}/provider-connections
		if (method === "GET" && /^\/orgs\/[^/]+\/provider-connections$/.test(path)) {
			return jsonResponse(200, { providerConnections: [...demoConnections.values()] });
		}

		// GET /me/providers
		if (method === "GET" && path === "/me/providers") {
			return jsonResponse(200, { providerConnections: [...demoConnections.values()] });
		}

		// PUT/DELETE /me/github-pat
		if (path === "/me/github-pat") {
			const key = "github:default";
			if (method === "PUT") {
				const body = readBody() as { secret?: string } | undefined;
				const secret = body?.secret ?? "";
				if (secret.length < 8) {
					return errorResponse(422, "validation_error", "The GitHub personal access token is invalid.");
				}
				if (secretLooksInvalid(secret)) {
					return errorResponse(
						422,
						"invalid_credential",
						"This GitHub token doesn't work — check it hasn't expired or been revoked.",
					);
				}
				const connection = demoConnection("github", DEFAULT_AGENT_LABEL);
				demoConnections.set(key, connection);
				return jsonResponse(200, { providerConnection: connection });
			}
			if (method === "DELETE") {
				demoConnections.delete(key);
				return new Response(null, { status: 204 });
			}
		}

		// POST /orgs/{orgId}/projects
		if (method === "POST" && /^\/orgs\/[^/]+\/projects$/.test(path)) {
			const body = readBody() as
				| { displayName?: string; repositoryUrl?: string; defaultBranch?: string; config?: Record<string, unknown> }
				| undefined;
			const repositoryUrl = body?.repositoryUrl ?? "";
			const looksPrivate = /private/i.test(repositoryUrl);
			const hasGitHubToken = demoConnections.has("github:default");
			if (looksPrivate && !hasGitHubToken) {
				return errorResponse(
					422,
					"repository_unreachable",
					"Can't reach this repository — it may be private, or the URL may be wrong.",
				);
			}
			demoProjectSeq += 1;
			const now = nowIso();
			match = url.pathname.match(/\/orgs\/([^/]+)\/projects$/);
			const orgId = match ? decodeURIComponent(match[1]) : "demo-org";
			return jsonResponse(201, {
				project: {
					id: `demo-project-${demoProjectSeq}`,
					orgId,
					displayName: body?.displayName ?? "New project",
					repositoryUrl,
					defaultBranch: body?.defaultBranch ?? "main",
					config: body?.config ?? {},
					createdAt: now,
					updatedAt: now,
				},
			});
		}

		return realFetch(input, init);
	};
}
