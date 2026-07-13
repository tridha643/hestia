/** Exact upstream Portless version bundled into the Hestia router payload. */
export const HESTIA_PORTLESS_VERSION = "0.15.1";

/** SHA-256 of the exact Hestia hardening patch bundled into Portless. */
export const HESTIA_PORTLESS_PATCH_SHA256 = "7d969a7e8bc556d0e866accc836b06e237f567b68d3d7fb7eaed5b0378fbc2d6";

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
