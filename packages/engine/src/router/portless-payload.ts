/** Exact upstream Portless version bundled into the Hestia router payload. */
export const HESTIA_PORTLESS_VERSION = "0.15.1";

/** SHA-256 of the exact Hestia hardening patch bundled into Portless. */
export const HESTIA_PORTLESS_PATCH_SHA256 = "9ca94ca771ce502769a2c7cbe3bb4fe8d54dc847ff9f7e3e2b34abf728618690";

export interface PortlessPayloadProvenance {
  package: "portless";
  version: string;
  patchSha256: string;
}

/** Build the deterministic provenance record copied into every router payload. */
export function expectedPortlessPayloadProvenance(): PortlessPayloadProvenance {
  return {
    package: "portless",
    version: HESTIA_PORTLESS_VERSION,
    patchSha256: HESTIA_PORTLESS_PATCH_SHA256,
  };
}

/** Check whether unknown provenance matches this exact Hestia source release. */
export function portlessPayloadProvenanceIsCurrent(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const provenance = value as Record<string, unknown>;
  return provenance.package === "portless" &&
    provenance.version === HESTIA_PORTLESS_VERSION &&
    provenance.patchSha256 === HESTIA_PORTLESS_PATCH_SHA256;
}
