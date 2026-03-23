import { z } from "zod";

export interface CoderClient {
	getCoderUserByGitHubId(
		githubUserId: number | undefined,
	): Promise<CoderSDKUser>;

	getTemplateByOrganizationAndName(
		organizationName: string,
		templateName: string,
	): Promise<CoderSDKTemplate>;

	getTemplateVersionPresets(
		templateVersionId: string,
	): Promise<CoderSDKTemplateVersionPreset[]>;

	getTask(
		owner: string,
		taskName: TaskName,
	): Promise<ExperimentalCoderSDKTask | null>;

	getTaskById(owner: string, taskId: TaskId): Promise<ExperimentalCoderSDKTask>;

	createTask(
		owner: string,
		params: ExperimentalCoderSDKCreateTaskRequest,
	): Promise<ExperimentalCoderSDKTask>;

	resumeTask(owner: string, taskId: TaskId): Promise<void>;

	sendTaskInput(owner: string, taskId: TaskId, input: string): Promise<void>;

	waitForTaskActive(
		owner: string,
		taskId: TaskId,
		logFn: (msg: string) => void,
		timeoutMs?: number,
	): Promise<void>;
}

// CoderClient provides a minimal set of methods for interacting with the Coder API.
export class RealCoderClient implements CoderClient {
	private readonly headers: Record<string, string>;

	constructor(
		private readonly serverURL: string,
		apiToken: string,
	) {
		this.headers = {
			"Coder-Session-Token": apiToken,
			"Content-Type": "application/json",
		};
	}

	private async request<T>(
		endpoint: string,
		options?: RequestInit,
	): Promise<T> {
		const url = `${this.serverURL}${endpoint}`;
		const response = await fetch(url, {
			...options,
			headers: { ...this.headers, ...options?.headers },
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new CoderAPIError(
				`Coder API error: ${response.statusText}`,
				response.status,
				body,
			);
		}

		// Handle 204 No Content and other responses with no body
		if (
			response.status === 204 ||
			response.headers?.get("content-length") === "0"
		) {
			return undefined as T;
		}

		return response.json() as Promise<T>;
	}

	/**
	 * getCoderUserByGitHubId retrieves an existing Coder user with the given GitHub user ID using Coder's stable API.
	 * Throws an error if more than one user exists with the same GitHub user ID or if a GitHub user ID of 0 is provided.
	 */
	async getCoderUserByGitHubId(
		githubUserId: number | undefined,
	): Promise<CoderSDKUser> {
		if (githubUserId === undefined) {
			throw new CoderAPIError("GitHub user ID cannot be undefined", 400);
		}
		if (githubUserId === 0) {
			throw "GitHub user ID cannot be 0";
		}
		const endpoint = `/api/v2/users?q=${encodeURIComponent(`github_com_user_id:${githubUserId}`)}`;
		const response = await this.request<unknown[]>(endpoint);
		const userList = CoderSDKGetUsersResponseSchema.parse(response);
		if (userList.users.length === 0) {
			throw new CoderAPIError(
				`No Coder user found with GitHub user ID ${githubUserId}`,
				404,
			);
		}
		if (userList.users.length > 1) {
			throw new CoderAPIError(
				`Multiple Coder users found with GitHub user ID ${githubUserId}`,
				409,
			);
		}
		return CoderSDKUserSchema.parse(userList.users[0]);
	}

	/**
	 * getTemplateByOrganizationAndName retrieves a template via Coder's stable API.
	 */
	async getTemplateByOrganizationAndName(
		organizationName: string,
		templateName: string,
	): Promise<CoderSDKTemplate> {
		const endpoint = `/api/v2/organizations/${encodeURIComponent(organizationName)}/templates/${encodeURIComponent(templateName)}`;
		const response =
			await this.request<typeof CoderSDKTemplateSchema>(endpoint);
		return CoderSDKTemplateSchema.parse(response);
	}

	/**
	 * getTemplateVersionPresets retrieves the presets for a given template version (UUID).
	 */
	async getTemplateVersionPresets(
		templateVersionId: string,
	): Promise<CoderSDKTemplateVersionPresetsResponse> {
		const endpoint = `/api/v2/templateversions/${encodeURIComponent(templateVersionId)}/presets`;
		const response =
			await this.request<CoderSDKTemplateVersionPresetsResponse>(endpoint);
		return CoderSDKTemplateVersionPresetsResponseSchema.parse(response);
	}

	/**
	 * getTask retrieves an existing task via Coder's experimental Tasks API.
	 * Returns null if the task does not exist.
	 */
	async getTask(
		owner: string,
		taskName: TaskName,
	): Promise<ExperimentalCoderSDKTask | null> {
		// TODO: needs taskByOwnerAndName endpoint, fake it for now with the list endpoint.
		try {
			const allTasksResponse = await this.request<unknown>(
				`/api/experimental/tasks?q=${encodeURIComponent(`owner:${owner}`)}`,
			);
			const allTasks =
				ExperimentalCoderSDKTaskListResponseSchema.parse(allTasksResponse);
			const task = allTasks.tasks.find((t) => t.name === taskName);
			if (!task) {
				return null;
			}
			return task;
		} catch (error) {
			if (error instanceof CoderAPIError && error.statusCode === 404) {
				return null;
			}
			throw error;
		}
	}

	/**
	 * getTaskById retrieves an existing task by ID via Coder's experimental Tasks API.
	 */
	async getTaskById(
		owner: string,
		taskId: TaskId,
	): Promise<ExperimentalCoderSDKTask> {
		const endpoint = `/api/experimental/tasks/${encodeURIComponent(owner)}/${encodeURIComponent(taskId)}`;
		const response = await this.request<unknown>(endpoint);
		return ExperimentalCoderSDKTaskSchema.parse(response);
	}

	/**
	 * createTask creates a new task with the given parameters using Coder's experimental Tasks API.
	 */
	async createTask(
		owner: string,
		params: ExperimentalCoderSDKCreateTaskRequest,
	): Promise<ExperimentalCoderSDKTask> {
		const endpoint = `/api/experimental/tasks/${encodeURIComponent(owner)}`;
		const response = await this.request<unknown>(endpoint, {
			method: "POST",
			body: JSON.stringify(params),
		});
		return ExperimentalCoderSDKTaskSchema.parse(response);
	}

	/**
	 * sendTaskInput sends the given input to an existing task via Coder's experimental Tasks API.
	 */
	async sendTaskInput(
		ownerUsername: string,
		taskId: TaskId,
		input: string,
	): Promise<void> {
		const endpoint = `/api/experimental/tasks/${ownerUsername}/${taskId}/send`;
		await this.request<unknown>(endpoint, {
			method: "POST",
			body: JSON.stringify({ input }),
		});
	}

	async resumeTask(
		ownerUsername: string,
		taskId: TaskId,
	): Promise<void> {
		const endpoint = `/api/v2/tasks/${ownerUsername}/${taskId}/resume`;
		await this.request<unknown>(endpoint, {
			method: "POST",
		});
	}

	/**
	 * waitForTaskActive polls the task status until it reaches "active" state or times out.
	 */
	async waitForTaskActive(
		owner: string,
		taskId: TaskId,
		logFn: (msg: string) => void,
		timeoutMs = 120000, // 2 minutes default
	): Promise<void> {
		const startTime = Date.now();
		const pollIntervalMs = 2000; // Poll every 2 seconds

		while (Date.now() - startTime < timeoutMs) {
			const task = await this.getTaskById(owner, taskId);

			if (task.status === "error") {
				throw new CoderAPIError(
					`Task entered error state while waiting for active state`,
					500,
					task,
				);
			}
			logFn(
				`waitForTaskActive: task_id: ${taskId} status: ${task.status} current_state: ${task.current_state?.state}`,
			);
			if (
				task.status === "active" &&
				task.current_state &&
				task.current_state.state === "idle"
			) {
				return;
			}

			// Wait before next poll
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}

		throw new CoderAPIError(
			`Timeout waiting for task to reach active state (waited ${timeoutMs}ms)`,
			408,
		);
	}
}

// Branded types for task identifiers to prevent mixing UUIDs and names
export const TaskIdSchema = z.string().uuid().brand("TaskId");
export type TaskId = z.infer<typeof TaskIdSchema>;

export const TaskNameSchema = z.string().min(1).brand("TaskName");
export type TaskName = z.infer<typeof TaskNameSchema>;

// CoderSDKUserSchema is the schema for codersdk.User.
export const CoderSDKUserSchema = z.object({
	id: z.string().uuid(),
	username: z.string(),
	email: z.string().email(),
	organization_ids: z.array(z.string().uuid()),
	github_com_user_id: z.number().optional(),
});
export type CoderSDKUser = z.infer<typeof CoderSDKUserSchema>;

// CoderSDKUserListSchema is the schema for codersdk.GetUsersResponse.
export const CoderSDKGetUsersResponseSchema = z.object({
	users: z.array(CoderSDKUserSchema),
});
export type CoderSDKGetUsersResponse = z.infer<
	typeof CoderSDKGetUsersResponseSchema
>;

// CoderSDKTemplateSchema is the schema for codersdk.Template.
export const CoderSDKTemplateSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	description: z.string().optional(),
	organization_id: z.string().uuid(),
	active_version_id: z.string().uuid(),
});
export type CoderSDKTemplate = z.infer<typeof CoderSDKTemplateSchema>;

// CoderSDKTemplateVersionPresetSchema is the schema for codersdk.Preset.
export const CoderSDKTemplateVersionPresetSchema = z.object({
	ID: z.string().uuid(),
	Name: z.string(),
	Default: z.boolean(),
});
export type CoderSDKTemplateVersionPreset = z.infer<
	typeof CoderSDKTemplateVersionPresetSchema
>;

// CoderSDKTemplateVersionPresetsResponseSchema is the schema for []codersdk.Preset which is returned by the API.
export const CoderSDKTemplateVersionPresetsResponseSchema = z.array(
	CoderSDKTemplateVersionPresetSchema,
);
export type CoderSDKTemplateVersionPresetsResponse = z.infer<
	typeof CoderSDKTemplateVersionPresetsResponseSchema
>;

// ExperimentalCoderSDKCreateTaskRequestSchema is the schema for experimental codersdk.CreateTaskRequest.
export const ExperimentalCoderSDKCreateTaskRequestSchema = z.object({
	name: z.string().min(1),
	template_version_id: z.string().min(1),
	template_version_preset_id: z.string().min(1).optional(),
	input: z.string().min(1),
});
export type ExperimentalCoderSDKCreateTaskRequest = z.infer<
	typeof ExperimentalCoderSDKCreateTaskRequestSchema
>;

// ExperimentalCoderSDKTaskStateSchema is the schema for experimental codersdk.TaskState
export const ExperimentalCoderSDKTaskStateEntrySchema = z.object({
	state: z.enum(["idle", "working", "complete", "failed"]),
});

export type ExperimentalCoderSDKTaskStateEntry = z.infer<
	typeof ExperimentalCoderSDKTaskStateEntrySchema
>;

// ExperimentalCoderSDKTaskStatusSchema is the schema for experimental codersdk.TaskStatus
export const ExperimentalCoderSDKTaskStatusSchema = z.enum([
	"pending",
	"initializing",
	"active",
	"paused",
	"unknown",
	"error",
]);

export type ExperimentalCoderSDKTaskStatus = z.infer<
	typeof ExperimentalCoderSDKTaskStatusSchema
>;

// ExperimentalCoderSDKTaskSchema is the schema for experimental codersdk.Task.
export const ExperimentalCoderSDKTaskSchema = z.object({
	id: TaskIdSchema,
	name: TaskNameSchema,
	owner_id: z.string().uuid(),
	template_id: z.string().uuid(),
	created_at: z.string(),
	updated_at: z.string(),
	status: ExperimentalCoderSDKTaskStatusSchema,
	current_state: ExperimentalCoderSDKTaskStateEntrySchema.nullable(),
});
export type ExperimentalCoderSDKTask = z.infer<
	typeof ExperimentalCoderSDKTaskSchema
>;

// ExperimentalCoderSDKTaskListResponseSchema is the schema for Coder's GET /api/experimental/tasks endpoint.
// At the time of writing, this type is not exported by github.com/coder/coder/v2/codersdk.
export const ExperimentalCoderSDKTaskListResponseSchema = z.object({
	tasks: z.array(ExperimentalCoderSDKTaskSchema),
});
export type ExperimentalCoderSDKTaskListResponse = z.infer<
	typeof ExperimentalCoderSDKTaskListResponseSchema
>;

// CoderAPIError is a custom error class for Coder API errors.
export class CoderAPIError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
		public readonly response?: unknown,
	) {
		super(message);
		this.name = "CoderAPIError";
	}
}
