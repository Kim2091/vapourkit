// electron/packageNames.ts
//
// A leaf module on purpose: name normalization is needed by code that must not
// pull in Electron (and therefore must not reach constants.ts through
// vendorPackages), so it lives on its own with no project imports.

/** PEP 503 name normalization: lowercase, underscores mapped to dashes. */
export function normalizePackageName(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, '-');
}
