import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudProjectSettingsForm } from "./CloudProjectSettingsForm";

const { cloudState, listProjectsMock, updateProjectMock } = vi.hoisted(() => ({
	cloudState: { ready: true, org: { id: "org-1" } as { id: string } | undefined },
	listProjectsMock: vi.fn(),
	updateProjectMock: vi.fn(),
}));

vi.mock("../hooks/useCloudCp", () => ({
	useCloudCp: () => ({
		client: { listProjects: listProjectsMock, updateProject: updateProjectMock },
		ready: cloudState.ready,
		baseUrl: "https://cp.example.com",
	}),
}));

vi.mock("../hooks/useCloudOrg", () => ({
	useCloudOrg: () => ({ org: cloudState.org, isLoading: false, error: undefined, ready: cloudState.ready }),
}));

function renderForm(projectId = "proj-1") {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<CloudProjectSettingsForm projectId={projectId} />
		</QueryClientProvider>,
	);
}

describe("CloudProjectSettingsForm", () => {
	beforeEach(() => {
		cloudState.ready = true;
		cloudState.org = { id: "org-1" };
		listProjectsMock.mockReset().mockResolvedValue({
			items: [
				{
					id: "proj-1",
					orgId: "org-1",
					displayName: "My Cloud Project",
					repositoryUrl: "https://github.com/acme/repo",
					defaultBranch: "main",
					config: {},
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
				},
			],
			page: {},
		});
		updateProjectMock.mockReset().mockResolvedValue({
			project: {
				id: "proj-1",
				orgId: "org-1",
				displayName: "Renamed",
				repositoryUrl: "https://github.com/acme/repo",
				defaultBranch: "develop",
				config: {},
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-02T00:00:00Z",
			},
		});
	});

	it("loads the project from the control plane instead of the local daemon", async () => {
		renderForm();

		expect(await screen.findByRole("button", { name: "Edit Project name" })).toHaveTextContent("My Cloud Project");
		expect(screen.getByText("https://github.com/acme/repo")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Edit Default branch" })).toHaveTextContent("main");
	});

	it("saves the display name and default branch via updateProject", async () => {
		renderForm();

		const nameTrigger = await screen.findByRole("button", { name: "Edit Project name" });
		await userEvent.click(nameTrigger);
		const nameInput = screen.getByLabelText("Project name");
		await userEvent.clear(nameInput);
		await userEvent.type(nameInput, "Renamed");
		await userEvent.tab();

		const branchTrigger = screen.getByRole("button", { name: "Edit Default branch" });
		await userEvent.click(branchTrigger);
		const branchInput = screen.getByLabelText("Default branch");
		await userEvent.clear(branchInput);
		await userEvent.type(branchInput, "develop");
		await userEvent.tab();

		const form = document.getElementById("project-settings-form") as HTMLFormElement;
		form.requestSubmit();

		await vi.waitFor(() =>
			expect(updateProjectMock).toHaveBeenCalledWith("org-1", "proj-1", {
				displayName: "Renamed",
				defaultBranch: "develop",
			}),
		);
	});
});
