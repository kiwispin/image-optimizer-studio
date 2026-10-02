export const isHostedDeployment =
  process.env.PUBLIC_DEPLOYMENT === "true" ||
  process.env.RENDER === "true" ||
  Boolean(process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** How long originals and outputs are kept before being deleted. */
export const retentionMs = numberFromEnv("RETENTION_HOURS", isHostedDeployment ? 1 : 24) * 60 * 60 * 1000;
/** Largest single upload accepted. Small hosts get a lower default. */
export const maxUploadBytes = numberFromEnv("MAX_UPLOAD_MB", isHostedDeployment ? 50 : 1024) * 1024 * 1024;
/** How many images are optimized at the same time. Each one can use hundreds of MB, so 1 is the safe default. */
export const processConcurrency = numberFromEnv("PROCESS_CONCURRENCY", 1);
export const allowUrlImport = process.env.ALLOW_URL_IMPORT ? process.env.ALLOW_URL_IMPORT === "true" : !isHostedDeployment;

/**
 * Largest image (in megapixels) the server will decode. Guards against decompression bombs on
 * public hosts. 0 / unset locally means no limit.
 */
export const maxInputPixels = numberFromEnv("MAX_MEGAPIXELS", isHostedDeployment ? 40 : Number.POSITIVE_INFINITY) * 1_000_000;

/**
 * AVIF's encoder needs ~500 MB at 12 MP and ~900 MB at 24 MP. Above this size a hosted server
 * leaves AVIF out of Auto and refuses explicit AVIF, so a 512 MB instance isn't killed mid-job.
 */
export const maxAvifPixels = numberFromEnv("AVIF_MAX_MEGAPIXELS", isHostedDeployment ? 8 : Number.POSITIVE_INFINITY) * 1_000_000;
