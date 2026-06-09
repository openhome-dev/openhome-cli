import FormDataLib from "form-data";
import type {
  GetPersonalitiesResponse,
  Personality,
  UploadAbilityResponse,
  UploadAbilityMetadata,
  ListAbilitiesResponse,
  GetAbilityResponse,
  ApiErrorResponse,
  VerifyApiKeyResponse,
  DeleteCapabilityResponse,
  ToggleCapabilityResponse,
  AssignCapabilitiesResponse,
  UpdatePersonalityResponse,
  UserCapability,
  AbilitySummaryWithExtras,
} from "./contracts.js";
import { API_BASE, ENDPOINTS } from "./endpoints.js";

export class NotImplementedError extends Error {
  constructor(endpoint: string) {
    super(`API endpoint not yet implemented: ${endpoint}`);
    this.name = "NotImplementedError";
  }
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class SessionExpiredError extends Error {
  constructor() {
    super("Session token expired or invalid");
    this.name = "SessionExpiredError";
  }
}

export interface IApiClient {
  getPersonalities(): Promise<Personality[]>;
  verifyApiKey(apiKey: string): Promise<VerifyApiKeyResponse>;
  uploadAbility(
    zipBuffer: Buffer,
    imageBuffer: Buffer | null,
    imageName: string | null,
    metadata: UploadAbilityMetadata,
    timeoutMs?: number,
  ): Promise<UploadAbilityResponse>;
  listAbilities(): Promise<ListAbilitiesResponse>;
  getAbility(id: string): Promise<GetAbilityResponse>;
  deleteCapability(id: string): Promise<DeleteCapabilityResponse>;
  toggleCapability(
    id: string,
    enabled: boolean,
  ): Promise<ToggleCapabilityResponse>;
  assignCapabilities(
    personalityId: string,
    capabilityIds: number[],
  ): Promise<AssignCapabilitiesResponse>;
  updatePersonality(
    id: string,
    name: string,
    description: string,
  ): Promise<UpdatePersonalityResponse>;
}

type AuthMode = "apikey" | "jwt" | "xapikey";

// Statuses worth retrying (transient server/network errors)
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function isRetryableNetworkError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("network")
  );
}

function retryDelay(attempt: number, retryAfterHeader?: string | null): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds)) return Math.min(seconds * 1000, 30_000);
    const date = Date.parse(retryAfterHeader);
    if (!isNaN(date)) return Math.max(0, date - Date.now());
  }
  const jitter = Math.random() * 500;
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt) + jitter, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ApiClient implements IApiClient {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    baseUrl?: string,
    private readonly jwt?: string,
  ) {
    this.baseUrl = baseUrl ?? API_BASE;
    if (!this.baseUrl.startsWith("https://")) {
      throw new Error("API base URL must use HTTPS. Got: " + this.baseUrl);
    }
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
    auth: AuthMode = "apikey",
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const authHeaders: Record<string, string> = {};
    if (auth === "jwt") {
      authHeaders["Authorization"] = `Bearer ${this.jwt}`;
    } else if (auth === "xapikey") {
      authHeaders["X-API-KEY"] = this.apiKey;
    } else {
      authHeaders["Authorization"] = `Bearer ${this.apiKey}`;
    }

    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleep(retryDelay(attempt));
      }

      let response: Response;
      try {
        response = await fetch(url, {
          ...options,
          headers: { ...authHeaders, ...(options.headers ?? {}) },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // Timeout or network error
        if (err instanceof DOMException && err.name === "TimeoutError") {
          lastError = new ApiError(
            "TIMEOUT",
            `Request timed out after ${timeoutMs / 1000}s`,
          );
          continue; // retry on timeout
        }
        if (isRetryableNetworkError(err)) {
          lastError = err;
          continue; // retry on transient network errors
        }
        throw err; // non-retryable (e.g. programming error)
      }

      // Retry on transient server errors
      if (RETRYABLE_STATUSES.has(response.status)) {
        const retryAfter = response.headers.get("Retry-After");
        lastError = new ApiError(
          String(response.status),
          `Server error ${response.status}`,
        );
        await sleep(retryDelay(attempt, retryAfter));
        continue;
      }

      if (!response.ok) {
        if (response.status === 404) throw new NotImplementedError(path);

        let body: Record<string, unknown> | null = null;
        try {
          body = (await response.json()) as Record<string, unknown>;
        } catch {
          // ignore parse errors
        }

        if (
          (body as ApiErrorResponse | null)?.error?.code === "NOT_IMPLEMENTED"
        ) {
          throw new NotImplementedError(path);
        }

        const message =
          (body?.detail as string) ??
          (body as ApiErrorResponse | null)?.error?.message ??
          response.statusText;

        if (
          auth === "jwt" &&
          (response.status === 401 ||
            message.toLowerCase().includes("token not valid") ||
            message.toLowerCase().includes("token is invalid") ||
            message.toLowerCase().includes("not valid for any token"))
        ) {
          throw new SessionExpiredError();
        }

        throw new ApiError(String(response.status), message);
      }

      return response.json() as Promise<T>;
    }

    // All attempts exhausted
    throw (
      lastError ??
      new ApiError(
        "NETWORK_ERROR",
        `Request to ${path} failed after ${MAX_ATTEMPTS} attempts`,
      )
    );
  }

  async getPersonalities(): Promise<Personality[]> {
    const data = await this.request<GetPersonalitiesResponse>(
      ENDPOINTS.getPersonalities,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: this.apiKey, with_image: true }),
      },
    );
    return data.personalities;
  }

  async uploadAbility(
    zipBuffer: Buffer,
    imageBuffer: Buffer | null,
    imageName: string | null,
    metadata: UploadAbilityMetadata,
    timeoutMs = 120_000, // 2 min default — large zips on slow connections
  ): Promise<UploadAbilityResponse> {
    const form = new FormDataLib();
    form.append("zip_file", zipBuffer, {
      filename: "ability.zip",
      contentType: "application/zip",
    });

    if (imageBuffer && imageName) {
      const imageExt = imageName.split(".").pop()?.toLowerCase() ?? "png";
      const imageMime =
        imageExt === "jpg" || imageExt === "jpeg" ? "image/jpeg" : "image/png";
      form.append("image_file", imageBuffer, {
        filename: imageName,
        contentType: imageMime,
      });
    }

    form.append("name", metadata.name);
    form.append("description", metadata.description);
    form.append("category", metadata.category);
    form.append("trigger_words", metadata.matching_hotwords.join(", "));
    if (metadata.personality_id) {
      form.append("personality_id", metadata.personality_id);
    }
    if (metadata.template !== undefined) {
      form.append("template", String(metadata.template));
    }

    const url = `${this.baseUrl}${ENDPOINTS.uploadCapability}`;

    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(retryDelay(attempt));

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.jwt}`,
            ...form.getHeaders(),
          },
          body: form.getBuffer() as unknown as BodyInit,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "TimeoutError") {
          throw new ApiError(
            "TIMEOUT",
            `Upload timed out after ${timeoutMs / 1000}s. Use --timeout to increase the limit.`,
          );
        }
        if (isRetryableNetworkError(err)) {
          lastErr = err;
          continue;
        }
        throw err;
      }

      if (RETRYABLE_STATUSES.has(response.status)) {
        lastErr = new ApiError(
          String(response.status),
          `Server error ${response.status}`,
        );
        continue;
      }

      if (!response.ok) {
        let body: Record<string, unknown> | null = null;
        try {
          body = (await response.json()) as Record<string, unknown>;
        } catch {
          // ignore
        }
        const message =
          (body?.detail as string) ??
          (body as ApiErrorResponse | null)?.error?.message ??
          response.statusText;

        if (
          response.status === 401 ||
          message.toLowerCase().includes("token not valid") ||
          message.toLowerCase().includes("token is invalid") ||
          message.toLowerCase().includes("not valid for any token")
        ) {
          throw new SessionExpiredError();
        }
        throw new ApiError(String(response.status), message);
      }

      return response.json() as Promise<UploadAbilityResponse>;
    }

    throw (
      lastErr ?? new ApiError("NETWORK_ERROR", "Upload failed after retries")
    );
  }

  async listAbilities(): Promise<ListAbilitiesResponse> {
    // get-all-capabilities returns user-created abilities, JWT auth
    const data = await this.request<UserCapability[]>(
      ENDPOINTS.listCapabilities,
      { method: "GET" },
      "jwt",
    );
    return {
      abilities: data.map((c) => ({
        ability_id: String(c.id),
        unique_name: c.name,
        display_name: c.name,
        version: c.capability_versions?.length ?? 1,
        status: c.is_installed ? "active" : "processing",
        personality_ids: [],
        created_at: c.last_updated ?? new Date().toISOString(),
        updated_at: c.last_updated ?? new Date().toISOString(),
        trigger_words: c.trigger_words,
        category: c.category,
      })),
    };
  }

  async getAbility(id: string): Promise<GetAbilityResponse> {
    // No single-get endpoint — fetch all and filter
    const { abilities } = await this.listAbilities();
    const found = abilities.find(
      (a) => a.ability_id === id || a.unique_name === id,
    );
    if (!found) {
      throw new ApiError("404", `Ability "${id}" not found.`);
    }
    return { ...found, validation_errors: [], deploy_history: [] };
  }

  async verifyApiKey(apiKey: string): Promise<VerifyApiKeyResponse> {
    return this.request<VerifyApiKeyResponse>(ENDPOINTS.verifyApiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey }),
    });
  }

  async deleteCapability(id: string): Promise<DeleteCapabilityResponse> {
    try {
      return await this.request<DeleteCapabilityResponse>(
        ENDPOINTS.deleteCapability(id),
        { method: "DELETE" },
        "jwt",
      );
    } catch (err) {
      // Fall back to uninstall if primary delete endpoint is missing or returns
      // "Invalid user Ability" (system abilities use a different path)
      if (
        err instanceof NotImplementedError ||
        (err instanceof ApiError &&
          err.message.includes("Invalid user Ability"))
      ) {
        return this.request<DeleteCapabilityResponse>(
          ENDPOINTS.uninstallCapability(id),
          { method: "DELETE" },
          "jwt",
        );
      }
      throw err;
    }
  }

  async toggleCapability(
    id: string,
    enabled: boolean,
  ): Promise<ToggleCapabilityResponse> {
    // Fetch current state first so we can PUT back the full object
    const { abilities } = await this.listAbilities();
    const current = abilities.find((a) => a.ability_id === id);
    if (!current) {
      throw new ApiError("404", `Ability "${id}" not found.`);
    }
    return this.request<ToggleCapabilityResponse>(
      ENDPOINTS.editInstalledCapability(id),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          name: current.unique_name,
          category: (current as AbilitySummaryWithExtras).category ?? "skill",
          trigger_words:
            (current as AbilitySummaryWithExtras).trigger_words ?? [],
        }),
      },
      "xapikey",
    );
  }

  async assignCapabilities(
    personalityId: string,
    capabilityIds: number[],
  ): Promise<AssignCapabilitiesResponse> {
    // Uses multipart/form-data — JSON is rejected
    // Each capability ID must be a separate form field (server expects number[])
    const form = new FormData();
    form.append("personality_id", personalityId);
    for (const id of capabilityIds) {
      form.append("matching_capabilities", String(id));
    }
    return this.request<AssignCapabilitiesResponse>(
      ENDPOINTS.editPersonality,
      { method: "PUT", body: form },
      "xapikey",
    );
  }

  async getInstalledCapabilityByCapability(
    capabilityId: string,
  ): Promise<{ release_id?: string; id?: number; [key: string]: unknown }> {
    return this.request(
      ENDPOINTS.getInstalledCapabilityByCapability(capabilityId),
      { method: "GET" },
      "xapikey",
    );
  }

  async updateAbilityCode(
    releaseId: string,
    zipBuffer: Buffer,
    commitMessage = "Updated via openhome CLI",
  ): Promise<{ detail?: string; message?: string }> {
    const form = new FormDataLib();
    form.append("zip_file", zipBuffer, {
      filename: "ability.zip",
      contentType: "application/zip",
    });
    form.append("committed", "false");
    form.append("commit_message", commitMessage);
    return fetch(`${this.baseUrl}${ENDPOINTS.validateReleaseCode(releaseId)}`, {
      method: "POST",
      headers: {
        "X-API-KEY": this.apiKey,
        ...form.getHeaders(),
      },
      body: form.getBuffer() as unknown as BodyInit,
    }).then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new ApiError(
          String(res.status),
          (body as { detail?: string }).detail ?? res.statusText,
        );
      return body as { detail?: string; message?: string };
    });
  }

  async updatePersonality(
    id: string,
    name: string,
    description: string,
  ): Promise<UpdatePersonalityResponse> {
    const form = new FormData();
    form.append("personality_id", id);
    form.append("name", name);
    form.append("description", description);
    return this.request<UpdatePersonalityResponse>(
      ENDPOINTS.editPersonality,
      { method: "PUT", body: form },
      "xapikey",
    );
  }
}
