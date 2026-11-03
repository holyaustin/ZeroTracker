/** Channel names, shared by the server (publish) and browser (subscribe). No imports, so it is safe in client bundles. */
export const channels = {
  account: (orgId: string) => `org:${orgId}:account`,
  fleet: (orgId: string) => `org:${orgId}:fleet`,
  vehicle: (vehicleId: string) => `vehicle:${vehicleId}`,
  owner: "owner:global",
} as const;
