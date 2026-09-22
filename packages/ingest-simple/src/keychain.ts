// macOS Keychain access via the `security` CLI, argv-based (never a shell
// string), so a secret is never interpolated into anything a shell parses.
// Mirrors `packages/plaid-feed/src/keychain.ts`'s `readKeychainSecretByService`,
// trimmed to the one read this package needs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Reads one generic-password Keychain item's secret by service name only
 * (`security find-generic-password -s <name> -w`). Returns `null` when the
 * item does not exist; never logs or throws the secret itself.
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

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("could not be found") || message.includes("exit code 44")
  );
}
