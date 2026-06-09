export const API_BASE = "https://app.openhome.com";

export const WS_BASE = "wss://app.openhome.com";

export const ENDPOINTS = {
  getPersonalities: "/api/sdk/get_personalities",
  verifyApiKey: "/api/sdk/verify_apikey/",
  uploadCapability: "/api/capabilities/add-capability/",
  listCapabilities: "/api/capabilities/get-all-capabilities/",
  deleteCapability: (id: string) => `/api/capabilities/delete-capability/${id}`,
  uninstallCapability: (id: string) =>
    `/api/capabilities/uninstall-capability/${id}/`,
  editInstalledCapability: (id: string) =>
    `/api/capabilities/edit-installed-capability/${id}/`,
  editPersonality: "/api/personalities/edit-personality/",
  getInstalledCapabilities: "/api/capabilities/get-installed-capabilities/",
  getInstalledCapabilityByCapability: (capabilityId: string) =>
    `/api/capabilities/get/installed-capability/by-capability/${capabilityId}/`,
  validateReleaseCode: (releaseId: string) =>
    `/api/capabilities/validate/release-code/${releaseId}/`,
  voiceStream: (apiKey: string, agentId: string) =>
    `/websocket/voice-stream/${apiKey}/${agentId}`,
} as const;
