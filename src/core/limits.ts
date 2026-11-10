export const MB = 1024 * 1024;
export const DEFAULT_MAX_FILE_MB = 90;
export const DEFAULT_MAX_AGE_DAYS = 30;
/** GitHub rejects any file over 100 MiB, and the whole push with it, so the setting cannot go above this. */
export const HARD_MAX_FILE_MB = 95;

export interface Limits {
  maxFileBytes: number;
  /** 0 = no age limit. */
  maxAgeDays: number;
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Settings live in a user-editable JSON file: anything unusable falls back to the default instead of breaking a push. */
export function parseLimits(raw: { maxFileSizeMB?: unknown; maxSessionAgeDays?: unknown }): Limits {
  const mb =
    isNumber(raw.maxFileSizeMB) && raw.maxFileSizeMB >= 1
      ? Math.min(raw.maxFileSizeMB, HARD_MAX_FILE_MB)
      : DEFAULT_MAX_FILE_MB;
  const days =
    isNumber(raw.maxSessionAgeDays) && raw.maxSessionAgeDays >= 0
      ? Math.floor(raw.maxSessionAgeDays)
      : DEFAULT_MAX_AGE_DAYS;
  return { maxFileBytes: Math.floor(mb * MB), maxAgeDays: days };
}
