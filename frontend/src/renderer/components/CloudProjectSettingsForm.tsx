import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	ProjectSettingsFormView,
	ProjectSettingsInputRow,
	ProjectSettingsSection,
	ProjectSettingsValueRow,
} from "@aoagents/product-ui";
import { useCloudCp } from "../hooks/useCloudCp";
import { useCloudOrg } from "../hooks/useCloudOrg";
import { cloudProjectsQueryKey, useCloudProjectsQuery } from "../hooks/useWorkspaceQuery";
import { ProductExternalLink } from "./ProductExternalLink";
import type { ProjectSettingsSaveState } from "./ProjectSettingsForm";

/**
 * Project settings for a project hosted by the AO cloud control plane.
 *
 * Cloud projects have no locally-registered daemon record (they are merged
 * into the workspace list purely client-side, see useCloudProjectsQuery), so
 * this reads and writes them through the control-plane project endpoints
 * instead of the local daemon's `/api/v1/projects/{id}`. The control plane
 * only supports renaming and changing the default branch (`UpdateProjectInput`
 * in contracts/cloud/openapi.yaml); there is no cloud analogue yet for the
 * local worker/orchestrator agent, reviewer, or tracker-intake settings, so
 * this form intentionally only exposes identity and the default branch.
 */
export function CloudProjectSettingsForm({
	projectId,
	onSaveState,
}: {
	projectId: string;
	onSaveState?: (state: ProjectSettingsSaveState) => void;
}) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const { client, ready } = useCloudCp();
	const { org } = useCloudOrg();
	const orgId = org?.id;
	const query = useCloudProjectsQuery();
	const project = query.data?.find((item) => item.id === projectId);

	const [displayName, setDisplayName] = useState(project?.displayName ?? "");
	const [defaultBranch, setDefaultBranch] = useState(project?.defaultBranch ?? "");
	useEffect(() => {
		if (!project) return;
		setDisplayName(project.displayName);
		setDefaultBranch(project.defaultBranch);
	}, [project]);

	const [savedAt, setSavedAt] = useState<number | null>(null);
	const [showSaving, setShowSaving] = useState(false);
	const [validationError, setValidationError] = useState<string | null>(null);

	const mutation = useMutation({
		mutationFn: async () => {
			if (!ready || orgId === undefined) throw new Error(t("settings.project.degraded"));
			const name = displayName.trim();
			const branch = defaultBranch.trim();
			await client.updateProject(orgId, projectId, { displayName: name, defaultBranch: branch });
		},
		onSuccess: () => {
			setSavedAt(Date.now());
			setValidationError(null);
			void queryClient.invalidateQueries({ queryKey: cloudProjectsQueryKey });
		},
	});

	useEffect(() => {
		if (!mutation.isPending) {
			setShowSaving(false);
			return;
		}
		const timeout = window.setTimeout(() => setShowSaving(true), 200);
		return () => window.clearTimeout(timeout);
	}, [mutation.isPending]);

	useEffect(() => {
		const mutationError = mutation.isError
			? mutation.error instanceof Error
				? mutation.error.message
				: t("settings.project.saveFailed")
			: undefined;
		onSaveState?.({
			phase: validationError || mutationError
				? "failed"
				: mutation.isPending
					? showSaving
						? "saving"
						: "pending"
					: savedAt !== null
						? "saved"
						: "idle",
			error: validationError ?? mutationError,
		});
	}, [mutation.error, mutation.isError, mutation.isPending, onSaveState, savedAt, showSaving, t, validationError]);

	useEffect(() => {
		if (savedAt === null) return;
		const timeout = window.setTimeout(() => setSavedAt(null), 1800);
		return () => window.clearTimeout(timeout);
	}, [savedAt]);

	if (query.isLoading) {
		return <p className="text-sm text-settings-muted">{t("settings.project.loading")}</p>;
	}
	if (!project) {
		return (
			<p className="text-sm text-error">
				{query.error instanceof Error ? query.error.message : t("settings.project.loadFailed")}
			</p>
		);
	}

	return (
		<ProjectSettingsFormView
			id="project-settings-form"
			onSubmit={() => {
				setSavedAt(null);
				if (displayName.trim() === "") {
					setValidationError(t("settings.project.nameRequired"));
					return;
				}
				if (defaultBranch.trim() === "") {
					setValidationError(t("createProject.cloudDefaultBranchRequired"));
					return;
				}
				setValidationError(null);
				mutation.mutate();
			}}
		>
			<ProjectSettingsSection title={t("settings.project.identity")} titleHidden grouped>
				<ProjectSettingsInputRow
					editIcon={<Pencil className="settings-inline-edit-icon" aria-hidden="true" />}
					editLabel={t("settings.field.edit", { label: t("settings.project.name") })}
					id="projectName"
					label={t("settings.project.name")}
					value={displayName}
					onChange={setDisplayName}
				/>
				<ProjectSettingsValueRow label={t("settings.project.id")} value={project.id} />
				<ProjectSettingsValueRow
					externalLink={ProductExternalLink}
					href={project.repositoryUrl}
					label={t("settings.project.repo")}
					value={project.repositoryUrl || "—"}
				/>
			</ProjectSettingsSection>
			<ProjectSettingsSection title={t("settings.project.workflow")} grouped>
				<ProjectSettingsInputRow
					editIcon={<Pencil className="settings-inline-edit-icon" aria-hidden="true" />}
					editLabel={t("settings.field.edit", { label: t("settings.project.defaultBranch") })}
					id="defaultBranch"
					label={t("settings.project.defaultBranch")}
					value={defaultBranch}
					onChange={setDefaultBranch}
				/>
			</ProjectSettingsSection>
		</ProjectSettingsFormView>
	);
}
