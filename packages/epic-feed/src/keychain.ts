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
    await run("/usr/bin/security", [
      "add-generic-password",
      "-U",
      "-a",
      keychainAccount(),
      "-s",
      service,
      "-w",
      secret,
    ]);
  } catch {
    throw new Error(
      `Failed to write Keychain item "${service}" (security add-generic-password)`,
    );
  }
}

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("could not be found") || message.includes("exit code 44")
  );
}
