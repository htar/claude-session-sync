export type ErrorKind = 'network' | 'full' | 'other';

const NETWORK =
  /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|getaddrinfo|Could not resolve host|Network is unreachable|Failed to connect|unable to access/i;
const FULL = /insufficient_space|insufficientStorage|storage quota|quotaLimitReached|No space left/i;

/** What kind of failure a message describes, so the user gets advice instead of a raw error text. */
export function classifyError(message: string): ErrorKind {
  if (FULL.test(message)) return 'full';
  if (NETWORK.test(message)) return 'network';
  return 'other';
}
