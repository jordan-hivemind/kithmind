# Database backups

Kith Mind’s native database snapshot assurance covers the application database
and its stored files. It does not duplicate original Dropbox PDFs; provider
originals remain governed by their separate recovery references.

A native snapshot is encrypted before it is sent to the remote backup
repository. Recovery records bind an exact repository boundary and require
ciphertext readback and decryption checks. Those checks establish that the
archived encrypted artifact can be recovered. They are distinct from an
isolated local restore, which checks the restored schema and data shape without
proving that deployed application code is identical.

The owner-specific export and backup adapters are not public interfaces. A
public runner contract is still under review. It will create a fresh protected
staging directory, pass that directory explicitly to an export adapter, then
pass the same directory explicitly to a backup adapter. It must retain bounded
status evidence and fail closed if another run holds its lock.

A future daily schedule runs only when the owner machine is logged in and
awake. A missed time is handled by the next available scheduled run; this guide
does not promise provider behavior or an exact catch-up time.

Automatic prune and forget are not part of this workflow. Retention changes
require a separately reviewed action. Recovery identities and keys are managed
separately from this guide and are never included in commands, logs, or public
configuration.
