// macOS Keychain access via the `security` CLI, argv-based (never a shell
// string), so a secret is never interpolated into anything a shell parses.
// Copied from `@repo/plaid-feed`'s own `keychain.ts` (no shared keychain
// package exists yet; `@repo/ingest-simple` carries its own copy too) rather
// than depending on a sibling feed package for a few argv calls.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The Keychain account every entry this package writes uses. */
export function keychainAccount(): string {
  const user = process.env.USER;
  if (!user) throw new Error("USER is not set; cannot address the Keychain");
  return user;
}

/**
 * Reads one generic-password Keychain item's secret by service name only
 * (`security find-generic-password -s <name> -w`), for items provisioned
 * outside this package (the client id and secret).
 */
export async function readKeychainSecretByService(
  service: string,
): Promise<string | null> {
  try {
    const { stdout } = await run("/usr/bin/security", [
      "find-generic-password",
      "-s",
      service,
      "-w",
    ]);
    const secret = stdout.trim();
    return secret === "" ? null : secret;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Reads one generic-password Keychain item this package itself wrote, by
 * service and the same account `writeKeychainSecret` used.
 */
export async function readKeychainSecret(
  service: string,
): Promise<string | null> {
  try {
    const { stdout } = await run("/usr/bin/security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      keychainAccount(),
      "-w",
    ]);
    const secret = stdout.trim();
    return secret === "" ? null : secret;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * The exact `security add-generic-password` argv `writeKeychainSecret`
 * passes, as a pure function so a test can assert on it without ever
 * executing `/usr/bin/security` (which does not exist on a Linux CI
 * runner).
 */
export function addGenericPasswordArgs(
  account: string,
  service: string,
  secret: string,
): string[] {
  return ["add-generic-password", "-U", "-a", account, "-s", service, "-w", secret];
}

/**
 * Writes (or replaces, `-U`) one generic-password Keychain item.
 *
 * The secret is passed as an argv element, not through the shell, and is
 * never included in any error this throws.
 */
export async function writeKeychainSecret(
  service: string,
  secret: string,
): Promise<void> {
  try {
    await run(
      "/usr/bin/security",
      addGenericPasswordArgs(keychainAccount(), service, secret),
    );
  } catch {
    throw new Error(
      `Failed to write Keychain item "${service}" (security add-generic-password)`,
    );
  }
}

/**
 * The exact `security delete-generic-password` argv `deleteKeychainSecret`
 * passes, as a pure function for the same reason `addGenericPasswordArgs`
 * is one.
 */
export function deleteGenericPasswordArgs(account: string, service: string): string[] {
  return ["delete-generic-password", "-a", account, "-s", service];
}

/** Deletes one generic-password Keychain item this package wrote. A missing
 * item is not an error -- deleting something already gone is the state the
 * caller wanted. */
export async function deleteKeychainSecret(service: string): Promise<void> {
  try {
    await run(
      "/usr/bin/security",
      deleteGenericPasswordArgs(keychainAccount(), service),
    );
  } catch (error) {
    if (isNotFound(error)) return;
    throw new Error(
      `Failed to delete Keychain item "${service}" (security delete-generic-password)`,
    );
  }
}

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("could not be found") || message.includes("exit code 44")
  );
}

/**
 * The `get`/`set`/`delete` shape `authorize.ts` and `pull.ts` depend on,
 * rather than three loose functions -- so a test can substitute one
 * in-memory object instead of mocking three module exports individually,
 * and a production caller never has to remember to pass all three
 * consistently.
 */
export type TokenStore = {
  get(service: string): Promise<string | null>;
  set(service: string, secret: string): Promise<void>;
  delete(service: string): Promise<void>;
};

/** The real Keychain-backed store, the default everywhere this package
 * reads or writes a person's tokens. */
export const keychainTokenStore: TokenStore = {
  get: readKeychainSecret,
  set: writeKeychainSecret,
  delete: deleteKeychainSecret,
};
