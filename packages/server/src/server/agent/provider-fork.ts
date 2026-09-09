/**
 * Raised when a provider-native fork is requested for a provider whose session
 * store cannot branch. Callers are expected to fall back to the text-attachment
 * fork rather than surfacing this as a hard failure.
 */
export class ProviderForkUnsupportedError extends Error {
  constructor(readonly provider: string) {
    super(`Provider '${provider}' does not support forking its session`);
    this.name = "ProviderForkUnsupportedError";
  }
}
