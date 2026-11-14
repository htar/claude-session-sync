export type ErrorKind = 'access' | 'network' | 'full' | 'other';

/** No access or not signed in. git's «unable to access … 403» is here, not under network; a local EACCES is not. */
const ACCESS =
  /Sync folder not found|HTTP 40[13]|returned error: 40[13]|authentication failed|could not read (username|password)|Permission denied \(publickey|not authorized|repository not found|sign.?in|rejected the sign-in/i;
const NETWORK =
  /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|getaddrinfo|Could not resolve host|Network is unreachable|Failed to connect|unable to access/i;
const FULL =
  /insufficient_space|insufficientStorage|storageQuotaExceeded|storage quota|quotaLimitReached|No space left/i;

/** What kind of failure a message describes, so the user gets advice instead of a raw error text. */
export function classifyError(message: string): ErrorKind {
  if (FULL.test(message)) return 'full';
  if (ACCESS.test(message)) return 'access';
  if (NETWORK.test(message)) return 'network';
  return 'other';
}

/**
 * Hides credentials before a message reaches the log or a notification: a password or token in a URL
 * (`https://user:token@host`), bearer tokens and GitHub tokens.
 */
export function redactSecrets(message: string): string {
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@')
    .replace(/(Bearer\s+)[\w.~+/=-]+/gi, '$1***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***');
}
