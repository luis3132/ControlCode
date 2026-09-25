export function platformsFor(
  files: string[],
  baseUrl: string,
  readSig: (file: string) => string,
): Record<string, { url: string; signature: string }>;
