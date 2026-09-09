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

## Public runner contract

`scripts/run-database-backup.mjs` is a generic runner. It does not contain an
export implementation, backup implementation, schedule, or recovery key. Run
it with one protected absolute configuration path:

```sh
node scripts/run-database-backup.mjs --config /absolute/protected/database-backup.json
```

The configuration file must be canonical, protected, and mode `0600`. Its
state and staging directories must be canonical, existing, protected, and mode
`0700`; command paths must be absolute. A synthetic configuration is:

```json
{
  "version": 1,
  "stateDirectory": "/absolute/private/state",
  "stagingRoot": "/absolute/private/staging",
  "cwd": "/absolute/project",
  "timeoutMs": 600000,
  "exportCommand": {
    "path": "/absolute/tools/export",
    "args": ["--format", "native"]
  },
  "backupCommand": {
    "path": "/absolute/tools/backup",
    "args": ["--mode", "remote"]
  }
}
```

The runner creates a fresh protected staging directory. It appends
`--output-directory` and that directory to the export command, then requires a
exact stdout JSON `{ "status": "passed" }`. Only after export succeeds does it append
`--input-directory` and the same directory to the backup command, which also
must emit a exact stdout JSON `{ "status": "passed" }`. Commands run without a shell.

The state directory records bounded `running`, `failed`, or `succeeded` status
and preserves the last successful time across a failure. A lock conflict fails
closed. Before manual lock recovery, verify no runner or child process remains
active and preserve failed status evidence. The runner does not automatically
prune staging directories, prune remote backups, or forget snapshots.

Owner export and backup adapters remain private. Scheduling is not yet
installed.
