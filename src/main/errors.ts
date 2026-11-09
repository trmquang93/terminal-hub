export type HubErrorStatus = 400 | 401 | 404 | 409 | 410 | 504;

export class HubError extends Error {
  constructor(
    readonly status: HubErrorStatus,
    message: string,
    /** Extra JSON fields for the error body (e.g. the handshake list of a 504). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
