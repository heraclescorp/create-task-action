import * as core from "@actions/core";
import {
	type ExperimentalCoderSDKCreateTaskRequest,
	TaskNameSchema,
	type CoderClient,
	type TaskId,
} from "./coder-client";
import type { ActionInputs, ActionOutputs } from "./schemas";
import type { getOctokit } from "@actions/github";

export type Octokit = ReturnType<typeof getOctokit>;

export class CoderTaskAction {
	constructor(
		private readonly coder: CoderClient,
		private readonly octokit: Octokit,
		private readonly inputs: ActionInputs,
	) {}

	/**
	 * Parse owner and repo from issue URL
	 */
	parseGithubIssueURL(): {
		githubOrg: string;
		githubRepo: string;
		githubIssueNumber: number;
	} {
		if (!this.inputs.githubIssueURL) {
			throw new Error(`Missing issue URL`);
		}

		// Parse: https://github.com/owner/repo/issues/123
		const match = this.inputs.githubIssueURL.match(
			/([^/]+)\/([^/]+)\/issues\/(\d+)/,
		);
		if (!match) {
			throw new Error(`Invalid issue URL: ${this.inputs.githubIssueURL}`);
		}
		return {
			githubOrg: match[1],
			githubRepo: match[2],
			githubIssueNumber: parseInt(match[3], 10),
		};
	}

	/**
	 * Generate task URL
	 */
	generateTaskUrl(coderUsername: string, taskID: TaskId): string {
		// Strip query params and anchors from the base URL
		const baseURL = this.inputs.coderURL.split(/[?#]/)[0].replace(/\/$/, "");
		return `${baseURL}/tasks/${coderUsername}/${taskID}`;
	}

	/**
	 * Comment on GitHub issue with task link
	 */
	async commentOnIssue(
		taskUrl: string,
		owner: string,
		repo: string,
		issueNumber: number,
	): Promise<void> {
		const body = `Task created: ${taskUrl}`;

		try {
			// Try to find existing comment from bot
			const { data: comments } = await this.octokit.rest.issues.listComments({
				owner,
				repo,
				issue_number: issueNumber,
			});

			// Find the last comment that starts with "Task created:"
			const existingComment = comments
				.reverse()
				.find((comment: { body?: string }) =>
					comment.body?.startsWith("Task created:"),
				);

			if (existingComment) {
				// Update existing comment
				await this.octokit.rest.issues.updateComment({
					owner,
					repo,
					comment_id: existingComment.id,
					body,
				});
			} else {
				// Create new comment
				await this.octokit.rest.issues.createComment({
					owner,
					repo,
					issue_number: issueNumber,
					body,
				});
			}
		} catch (error) {
			core.error(`Failed to comment on issue: ${error}`);
		}
	}

	/**
	 * Main action execution
	 */
	async run(): Promise<ActionOutputs> {
		let coderUsername: string;
		if (this.inputs.coderUsername) {
			core.info(`Using provided Coder username: ${this.inputs.coderUsername}`);
			coderUsername = this.inputs.coderUsername;
		} else {
			core.info(
				`Looking up Coder user by GitHub user ID: ${this.inputs.githubUserID}`,
			);
			const coderUser = await this.coder.getCoderUserByGitHubId(
				this.inputs.githubUserID,
			);
			coderUsername = coderUser.username;
		}
		const { githubOrg, githubRepo, githubIssueNumber } =
			this.parseGithubIssueURL();
		core.info(`GitHub owner: ${githubOrg}`);
		core.info(`GitHub repo: ${githubRepo}`);
		core.info(`GitHub issue number: ${githubIssueNumber}`);
		core.info(`Coder username: ${coderUsername}`);
		if (!this.inputs.coderTaskNamePrefix || !this.inputs.githubIssueURL) {
			throw new Error(
				"either taskName or both taskNamePrefix and issueURL must be provided",
			);
		}
		core.info(`Coder organization: ${this.inputs.coderOrganization}`);
		const taskNameString = `${this.inputs.coderTaskNamePrefix}-${githubIssueNumber}`;
		const taskName = TaskNameSchema.parse(taskNameString);
		core.info(`Coder Task name: ${taskName}`);
		const template = await this.coder.getTemplateByOrganizationAndName(
			this.inputs.coderOrganization,
			this.inputs.coderTemplateName,
		);
		core.info(
			`Coder Template: ${template.name} (id:${template.id}, active_version_id:${template.active_version_id})`,
		);
		const templateVersionPresets = await this.coder.getTemplateVersionPresets(
			template.active_version_id,
		);
		let presetID: string | undefined;
		// If no preset specified, use default preset
		if (!this.inputs.coderTemplatePreset) {
			core.info(`Coder Template: Using default preset`);
			for (const preset of templateVersionPresets) {
				if (preset.Default) {
					presetID = preset.ID;
					break;
				}
			}
		} else {
			for (const preset of templateVersionPresets) {
				if (preset.Name === this.inputs.coderTemplatePreset) {
					presetID = preset.ID;
					break;
				}
			}
		}

		// Ensure that we found a valid preset if the user specifically requested one
		if (!!this.inputs.coderTemplatePreset && !presetID) {
			throw new Error(`Preset ${this.inputs.coderTemplatePreset} not found`);
		}
		core.info(`Coder Template: Preset ID: ${presetID}`);

		const existingTask = await this.coder.getTask(coderUsername, taskName);
		if (existingTask) {
			core.info(
				`Coder Task: already exists: ${existingTask.name} (id: ${existingTask.id} status: ${existingTask.status})`,
			);

			// Wait for task to become active and idle before sending
			// input. The agent may be in "working" state even when the
			// task status is "active", and sending input in that state
			// causes 409/502 errors.
			core.info(
				`Coder Task: waiting for task ${existingTask.name} to become active and idle...`,
			);
			await this.coder.waitForTaskActive(
				coderUsername,
				existingTask.id,
				core.debug,
				1_200_000,
			);

			core.info("Coder Task: Sending prompt to existing task...");
			// Send prompt to existing task using the task ID (UUID)
			await this.coder.sendTaskInput(
				coderUsername,
				existingTask.id,
				this.inputs.coderTaskPrompt,
			);
			core.info("Coder Task: Prompt sent successfully");
			return {
				coderUsername,
				taskName: existingTask.name,
				taskUrl: this.generateTaskUrl(coderUsername, existingTask.id),
				taskCreated: false,
			};
		}
		core.info("Creating Coder task...");

		const req: ExperimentalCoderSDKCreateTaskRequest = {
			name: taskName,
			template_version_id: template.active_version_id,
			template_version_preset_id: presetID,
			input: this.inputs.coderTaskPrompt,
		};
		// Create new task
		const createdTask = await this.coder.createTask(coderUsername, req);
		core.info(
			`Coder Task: created successfully (status: ${createdTask.status})`,
		);

		// 5. Generate task URL
		const taskUrl = this.generateTaskUrl(coderUsername, createdTask.id);
		core.info(`Coder Task: URL: ${taskUrl}`);

		// 6. Comment on issue if requested
		if (this.inputs.commentOnIssue) {
			core.info(
				`Commenting on issue ${githubOrg}/${githubRepo}#${githubIssueNumber}`,
			);
			await this.commentOnIssue(
				taskUrl,
				githubOrg,
				githubRepo,
				githubIssueNumber,
			);
			core.info(`Comment posted successfully`);
		} else {
			core.info(`Skipping comment on issue (commentOnIssue is false)`);
		}
		return {
			coderUsername,
			taskName,
			taskUrl,
			taskCreated: true,
		};
	}
}
