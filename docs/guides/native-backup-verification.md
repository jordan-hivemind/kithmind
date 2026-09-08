# Native backup verification

`scripts/verify-native-convex-restore.mjs` restores an already decrypted native
Convex ZIP into an isolated local backend and compares the exported rows,
metadata, and storage bytes with the input. It supports bounded ZIP64 inputs.
It deploys the repository schema without application functions, authentication
configuration, HTTP routes, or cron definitions.

Run it on macOS from an installed repository. The backend runs under a macOS
sandbox that denies outbound connections; the verifier uses loopback connections
to that backend. This is a recovery check, not a live deployment restore.

```sh
node scripts/verify-native-convex-restore.mjs \
  --repo /absolute/kithmind \
  --snapshot /absolute/native-backup.zip \
  --backend /absolute/convex-local-backend \
  --backend-sha256 3fefa471e11eab56aabf86039ddf825ed1b4dbadadec2df6b88b6ffd9d604400 \
  --backend-version 'local_backend unknown' \
  --output-dir /absolute/protected-parent/new-verification \
  --backend-port 3210 \
  --site-port 3211
```

All eight flags are required. Use two distinct, available local ports. The
output directory must not exist; its parent must already exist, be owned by
you, and not be writable by other users. The verifier creates the output with
owner-only permissions. It rejects inherited `CONVEX_*` environment variables
and checks the backend hash and exact version output before use.

The output contains restored private data. Keep it outside Git in a protected
location. No recovery keys are required because the input is already decrypted.
A successful result includes exact export comparison and backend shutdown
verification. This does not establish that a remote backup is current or readable;
remote readback and decryption are separate checks.

## Optional pinned backend provenance

For a reproducible Apple Silicon backend, use the official release archive:

<https://github.com/get-convex/convex-backend/releases/download/precompiled-2026-08-25-7cce8fb/convex-local-backend-aarch64-apple-darwin.zip>

Verify the downloaded archive SHA-256:

`98831b0f511f6eed70b0b4dfca62015df57877e08017d2b2979b39d62ae7317b`

After extraction, verify the backend binary SHA-256:

`3fefa471e11eab56aabf86039ddf825ed1b4dbadadec2df6b88b6ffd9d604400`

The binary reports `local_backend unknown` for `--version`. Treat the archive
and binary hashes as the trust pins; do not infer a semantic version from that
text.
