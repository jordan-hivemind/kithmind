// An in-memory `TokenStore` (see `src/keychain.ts`), so a test never touches
// the real Keychain -- `security` does not exist on a Linux CI runner, which
// is exactly what made `runAuthorize`/`pullOneSource` take this interface
// instead of calling `writeKeychainSecret`/`readKeychainSecret` directly.

export function inMemoryTokenStore(seed = {}) {
  const items = new Map(Object.entries(seed));
  return {
    items,
    async get(service) {
      return items.has(service) ? items.get(service) : null;
    },
    async set(service, secret) {
      items.set(service, secret);
    },
    async delete(service) {
      items.delete(service);
    },
  };
}
