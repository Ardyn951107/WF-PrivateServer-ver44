import { config } from "./configService.ts";
import { version_compare } from "../helpers/inventoryHelpers.ts";
import customBuild from "../constants/customBuild.ts";

export interface IClientCompatibilityResult {
    allowed: boolean;
    family: "legacy" | "u44" | "future";
    maxBuildLabel: string | null;
}

export const getConfiguredMaxBuildLabel = (): string | null => {
    const configured = config.clientCompatibility?.maxBuildLabel;
    if (configured === null) return null;
    return configured ?? customBuild.defaultMaxBuildLabel;
};

export const classifyClientBuild = (buildLabel: string): IClientCompatibilityResult["family"] => {
    if (version_compare(buildLabel, customBuild.u44MinimumBuildLabel) < 0) return "legacy";
    const maxBuildLabel = getConfiguredMaxBuildLabel();
    if (maxBuildLabel !== null && version_compare(buildLabel, maxBuildLabel) > 0) return "future";
    return "u44";
};

export const checkClientCompatibility = (buildLabel: string): IClientCompatibilityResult => {
    const maxBuildLabel = getConfiguredMaxBuildLabel();
    return {
        allowed: maxBuildLabel === null || version_compare(buildLabel, maxBuildLabel) <= 0,
        family: classifyClientBuild(buildLabel),
        maxBuildLabel
    };
};
