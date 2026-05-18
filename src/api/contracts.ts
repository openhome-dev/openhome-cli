// Existing endpoints

export interface GetPersonalitiesRequest {
  api_key: string;
  with_image?: boolean;
}

export interface Personality {
  id: string;
  name: string;
  description?: string;
  image?: string;
}

export interface GetPersonalitiesResponse {
  personalities: Personality[];
}

// Upload request metadata
export type AbilityCategory =
  | "skill"
  | "brain_skill"
  | "background_daemon"
  | "local";

export interface UploadAbilityMetadata {
  name: string;
  description: string;
  category: AbilityCategory;
  matching_hotwords: string[];
  personality_id?: string;
  template?: number;
}

export interface UploadAbilityResponse {
  // Actual API returns capability_id + detail
  capability_id?: number;
  detail?: string;
  // Legacy / future fields (may be absent)
  ability_id?: string;
  unique_name?: string;
  version?: number;
  status?: "processing" | "active" | "failed";
  validation_errors?: string[];
  created_at?: string;
  message?: string;
}

export interface AbilitySummary {
  ability_id: string;
  unique_name: string;
  display_name: string;
  version: number;
  status: "processing" | "active" | "failed" | "disabled";
  personality_ids: string[];
  created_at: string;
  updated_at: string;
}

// Extended with fields from the real API
export interface AbilitySummaryWithExtras extends AbilitySummary {
  trigger_words?: string[];
  category?: string;
}

// Raw shape returned by get-installed-capabilities
export interface InstalledCapability {
  id: number;
  name: string;
  category: string;
  enabled: boolean;
  trigger_words: string[];
  last_updated?: string;
  image_file?: string;
  default?: boolean;
  system_capability?: boolean;
  agent_capability?: boolean;
  shortcut?: boolean;
}

// Raw shape returned by get-all-capabilities (user-created abilities)
export interface UserCapability {
  id: number;
  name: string;
  category: string;
  description: string;
  trigger_words: string[];
  is_installed: boolean;
  is_approved: boolean;
  is_published: boolean;
  last_updated?: string;
  capability_versions?: {
    id: number;
    version: string;
    is_user_enabled: boolean;
  }[];
}

export interface ListAbilitiesResponse {
  abilities: AbilitySummary[];
}

export interface GetAbilityResponse extends AbilitySummary {
  validation_errors: string[];
  deploy_history: DeployEvent[];
}

export interface DeployEvent {
  version: number;
  status: "success" | "failed";
  timestamp: string;
  message: string;
}

export interface ApiErrorResponse {
  error: {
    code:
      | "UNAUTHORIZED"
      | "VALIDATION_FAILED"
      | "NOT_FOUND"
      | "NOT_IMPLEMENTED";
    message: string;
    details?: Record<string, unknown>;
  };
}

// Verify API key
export interface VerifyApiKeyResponse {
  valid: boolean;
  message?: string;
}

// Delete capability
export interface DeleteCapabilityResponse {
  message?: string;
}

// Toggle capability enabled/disabled
export interface ToggleCapabilityResponse {
  enabled?: boolean;
  message?: string;
}

// Assign capabilities to a personality
export interface AssignCapabilitiesRequest {
  matching_capabilities: number[];
}

export interface AssignCapabilitiesResponse {
  message?: string;
}

// Update personality name/prompt
export interface UpdatePersonalityResponse {
  detail?: string;
  message?: string;
  personality_id?: string;
}
