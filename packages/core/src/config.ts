export type AutoExpandWarmup = "ask" | "never" | "always";

export interface ApeironConfig {
  autoExpandWarmup: AutoExpandWarmup;
  maxWarmupExpansionFilesPerRun: number;
}

export const DEFAULT_APEIRON_CONFIG: ApeironConfig = {
  autoExpandWarmup: "never",
  maxWarmupExpansionFilesPerRun: 20
};

export function resolveApeironConfig(input: Partial<ApeironConfig> | undefined): ApeironConfig {
  return {
    ...DEFAULT_APEIRON_CONFIG,
    ...input
  };
}
