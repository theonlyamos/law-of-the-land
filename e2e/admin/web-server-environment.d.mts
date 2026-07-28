export function buildWebServerEnvironment(
  environment: Record<string, string | undefined>,
): Record<string, string>;

export function assertIsolatedWebServerEnvironment(
  environment: Record<string, string | undefined>,
): void;
