/** Safely extracts a human-readable message from a value caught in a `catch` block. */
export function getErrorMessage(error: unknown, fallback = ''): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}
