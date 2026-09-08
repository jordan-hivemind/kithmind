# Filesystem text worker

The filesystem worker sends small UTF-8 text files to a configured Kith Mind
source. The hosted Brain retains searchable text and evidence, so reads do not
depend on the worker or original folder being online. PDF conversion, typed
record extraction, cloud monitoring, and portable restore are separate work.

Use a synthetic folder first. Owner-document ingestion remains gated on the
isolated restore and pilot checks in the
[Phase 2 plan](plans/2026-09-07-phase2-document-pipeline.md).

The initial worker requires Node.js 22 or newer and a local POSIX filesystem
with ownership and mode checks, as on macOS or Linux. Windows ACL support and
shared network journals are not implemented.

## Access and local state

Create a filesystem source in Settings in the intended Personal or shared
space. Create an ingest-only API key scoped to that space and source. The
worker does not need a Convex deployment key or general document-read access.
Each reader connects to the hosted Brain using their own authorized account
or credential.

The configuration uses an exact gateway URL ending in `/api/worker`. HTTPS is
required except for an explicit loopback development URL. Redirects are
rejected. A local configuration has this shape; replace the example IDs and
paths with your synthetic source and folder:

```json
{
  "protocolVersion": 1,
  "endpoint": "https://your-brain.example/api/worker",
  "spaceId": "YOUR_SPACE_ID",
  "sourceAccountId": "YOUR_FILESYSTEM_SOURCE_ID",
  "credentialEnv": "KITH_WORKER_KEY",
  "roots": [{ "alias": "demo", "path": "/absolute/path/to/synthetic-files" }],
  "journalDir": "/absolute/path/to/private-worker-state"
}
```

Root aliases use lowercase letters, digits, dots, underscores, and hyphens,
start with a letter or digit, and are at most 64 characters. Aliases must be
unique. Keep the same alias when restarting a source.

Keep the configuration, credentials, and journal outside this repository.
The configuration must be a regular UTF-8 JSON file no larger than 64 KiB.
A symlink at the configuration path is rejected.
Configuration names the environment variable containing the API key; it does
not contain the key itself. The journal can temporarily contain file text,
paths, and lease tokens needed to retry an interrupted request. Treat it as
sensitive local data. Its directory must have mode `0700` and its files mode
`0600`. Do not place it inside a scanned folder.

Pending requests are persisted before sending, and results are persisted
before advancing local progress. After an uncertain network response, the
worker replays the same request. Deleting pending state can prevent that
recovery. Removing local files does not securely erase copies in backups,
filesystem snapshots, or storage devices.

A salted credential fingerprint in the protected journal detects key changes;
the reusable API key is not persisted. Changing a key while a request or lease
is unresolved stops recovery. Revoking an original actor also prevents its
unfinished cloud work from publishing. Full operator-authorized credential
recovery remains part of P2-4.

Check the configuration with [worker diagnostics](worker-doctor.md) before
starting a pass. [Optional user-service recipes](worker-service.md) describe
foreground polling under a service manager.

## Run a synthetic folder

Install dependencies from the repository root and build the worker:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@repo/pipeline
```

Create a regular `.txt` file in the configured synthetic folder. Resolve the
scoped API key into the configured environment variable through your credential
store or a hidden terminal prompt. For the example above:

```sh
read -s KITH_WORKER_KEY
export KITH_WORKER_KEY
node packages/pipeline/dist/cli.js run --config /absolute/path/to/pipeline.json
```

Run the same command again to check unchanged-file handling. Change the file
and run again to publish a replacement revision. Query the hosted Brain with
an authorized read credential to inspect retained text and citations.

The foreground polling command is:

```sh
node packages/pipeline/dist/cli.js watch --config /absolute/path/to/pipeline.json
```

Keep one worker for a source on a host. The worker takes kernel-held loopback
locks for its configured authority and journal directory, and releases them on
exit or process death.
A lock conflict stops a second worker; it does not steal another process's
journal. Use one canonical gateway URL consistently. This local lock does not
coordinate different hosts; the server independently fences scans and leases.

Foreground polling is not a system service or cloud monitor. Optional user-service recipes cover local process supervision. Cloud
alerts for a stopped host remain separate work.
The initial default waits five minutes between completed passes. Set
`watchIntervalMs` in local configuration to change that interval. Passes do not
overlap; this is a configurable starting point, not a measured latency target.

| Setting           | Default | Allowed range                   |
| ----------------- | ------- | ------------------------------- |
| `watchIntervalMs` | 300,000 | 1,000 to 3,600,000 milliseconds |
| `maxFiles`        | 256     | 1 to 256 files per pass         |
| `maxDepth`        | 16      | 1 to 64 directory levels        |
| `maxFileBytes`    | 65,536  | 1 to 65,536 bytes per file      |

Traversal also stops after 4,096 visited filesystem entries. This initial
worker does not split an oversized folder into multiple scans. Journal and
request byte limits can stop a pass independently of the file-count limit.

## Identity and recovery

A source-local UUID identifies a file. Equal content in two files does not
merge their identities. A filename, hash, or inode does not prove a rename.
Root aliases and path mappings are identity inputs; changing them requires
care.

After journal loss, the worker uses the cloud identity-recovery protocol.
Exact surviving mappings can be recovered. Ambiguous paths remain in review;
the worker cannot approve a replacement identity or mark an unmatched old
record unavailable on that basis. Operator resolution is tracked separately
in P2-12. Forgotten identities remain protected from automatic reimport.

A missing root, permission failure, or interrupted walk is a failed or
incomplete scan. Only healthy completed reconciliation can establish that a
previously observed file is absent. Unavailability preserves hosted evidence;
forgetting is a separate authorized action.

## File-access boundary

Use roots controlled by the account running the worker. The worker rejects
symlinks and checks paths and opened-file metadata before and after reading.
It rejects unsupported files, invalid UTF-8, detected changes, and files above
its limits instead of publishing truncated content.

The initial worker fails the whole scan for these file errors, unreadable
directories, or entry/depth overflow. It does not omit the affected item and
seal the remaining inventory as healthy. Use a folder of supported synthetic
text files for this stage.

The portable Node implementation is not a sandbox against a hostile local
process changing ancestor directories between checks. Do not give untrusted
local users write access to the roots or their ancestors. File content remains
data; it cannot change the configured destination or worker operations.

## Interpreting status

Each pass prints a small JSON result. `run` exits successfully only for a
complete processing assessment; an incomplete assessment or a failed pass returns
a nonzero exit status. A `rate_limited` result retains recovery state. Run the
same configuration again after the server window resets; foreground polling
retries on its next interval.

Enumeration and processing are separate. A completed scan can still have
pending, failed, unavailable, or review work. Processing assessments describe
a checked snapshot; a later scan or source change invalidates old results.
Rerun an assessment to refresh a conservative incomplete result after work
finishes.

Record coverage remains `not_established`. Processing every visible text file
does not establish that all medical or financial records for a date range are
present. See the [worker protocol](plans/2026-09-07-worker-protocol.md) for the
server contract and bounds.
