export const customBuild = {
    name: "SpaceNinjaServer U44 Custom",
    version: "0.1.0-u44.1.1-custom.2",
    targetGameVersion: "44.1.1",
    targetFamily: "44.x",
    // Exact 44.1.x build labels are intentionally learned from the client at runtime.
    // This ceiling covers the verified Oct 2026 U44.1.1 release window without opening the gate indefinitely.
    defaultMaxBuildLabel: "2026.10.09.23.59",
    u44MinimumBuildLabel: "2026.09.22.16.46"
} as const;

export default customBuild;
