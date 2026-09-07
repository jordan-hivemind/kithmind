export const MAX_INLINE_TEXT_BYTES = 65_536;
export const MAX_PAGES = 32;
export const MAX_EVIDENCE_SPANS = 128;
export const MAX_DOCUMENTS = 16;
export const MAX_CHUNKS = 128;
export const MAX_STAGE_ROWS = 25;
export const MAX_STAGE_TEXT_BYTES = 128 * 1024;
export const MAX_CURSOR_DISCOVERIES = 4;
export const MAX_LEASE_MS = 5 * 60 * 1000;
export const MAX_JOB_ATTEMPTS = 8;
export const MAX_ERROR_CODE_LENGTH = 64;
export const MAX_ERROR_MESSAGE_LENGTH = 1024;
export const MAX_REQUEST_ID_LENGTH = 128;
export const MAX_EXTERNAL_ID_LENGTH = 2048;
export const MAX_METADATA_LENGTH = 2048;
export const MAX_FINGERPRINT_LENGTH = 256;
export const MAX_LEASE_TOKEN_LENGTH = 256;

export function requireBoundedString(
  name: string,
  value: string,
  maxLength: number,
  allowEmpty = false,
): void {
  if ((!allowEmpty && value.length === 0) || value.length > maxLength) {
    throw new Error(`${name} is invalid`);
  }
}

export function requireIntegerInRange(
  name: string,
  value: number,
  min: number,
  max: number,
): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} is outside the supported limit`);
  }
}
