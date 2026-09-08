# Worker diagnostics

The doctor checks a filesystem worker's local configuration, scoped access,
folders, protected journal, and hosted source status. It reports operational
readiness separately from data completeness. Start with a synthetic folder;
the isolated restore and owner-pilot gates in the
[Phase 2 plan](plans/2026-09-07-phase2-document-pipeline.md) still apply.

## Run the check

Follow the [filesystem worker setup](filesystem-worker.md) to create a source,
scoped ingest credential, and local configuration. Build the worker after
installing dependencies:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@repo/pipeline
pnpm --silent brain:doctor -- --config /absolute/path/to/pipeline.json --json
```

The direct worker command is also available:

```sh
node packages/pipeline/dist/cli.js doctor --config /absolute/path/to/pipeline.json --json
```

Omit `--json` for the human-readable result. These commands use the credential
named by `credentialEnv` in the configuration. A worker host needs only its
scoped credential and the configured gateway. Deployment environment files
and a Convex administrator session are optional operator checks, described
below.

## Interpret the result

| Operational state | Meaning                                                                                      | Exit status |
| ----------------- | -------------------------------------------------------------------------------------------- | ----------- |
| `ready`           | The checked local prerequisites and scoped source access permit a new pass.                  | 0           |
| `degraded`        | Inspection found contention or recovery work that needs attention.                           | 0           |
| `blocked`         | A definite configuration, credential, filesystem, or journal problem prevents safe progress. | Nonzero     |

Automation that requires exclusive maintenance should require `ready`.
A first installation can be ready before it has scanned any files. Read the
source section to see enumeration, processing, and record coverage separately.
A stale processing assessment is reported as incomplete. Record coverage
remains `not_established` for this text-only stage.

The result uses fixed diagnostic codes and bounded source status. It omits
credentials, server error messages, file contents, filenames, source URLs,
and journal request or lease details.

The JSON doctor result is version 2. Version 2 adds the separate heartbeat
check while leaving the worker `source.status` protocol unchanged.

## Journal inspection and recovery

Doctor inspection leaves journal content, permissions, and recovery files
unchanged. It does not create a missing journal, clean up interrupted writes,
or accept a replacement credential. Filesystem access times may follow the
host's normal read policy.

Folder checks establish bounded local readability. They do not verify
provider-specific Dropbox or iCloud placeholder and hydration status.

A held lock is reported as contention. It can belong to another worker,
inspector, or unrelated listener. The polling worker releases its locks
between passes, so lock availability does not establish service health either.

Pending or active recovery is reported separately from readiness. Resume the
ordinary worker with the same configuration and original credential after
resolving the reported problem. A replacement credential that conflicts with
active recovery blocks readiness, even if the replacement can access the
source. A quiescent credential change can be reported without modifying the
journal; the ordinary worker performs its authorization check when it runs.

A manual-recovery requirement must be resolved before restarting. Keep the
journal for diagnosis. Removing it can discard the exact pending request
needed to recover an uncertain response. Operator-authorized credential and
identity recovery continue in P2-4 and P2-12.

## Check deployment configuration separately

On the deployment operator's configured checkout, the existing preflight
commands remain available:

```sh
pnpm check:self-hosting
pnpm check:self-hosting:convex
```

The Convex command checks the production deployment by default. Use the
existing checker's explicit deployment options for another environment.
These checks validate configuration presence and shape within their documented
scope. They do not establish provider reachability or complete vector coverage.

The doctor also reads separate cloud diagnostics status. It never sends a
heartbeat. A current heartbeat proves only that an authorized `watch` worker
recently reached the worker gateway. It does not prove source-file access,
queue progress, record coverage, or a service-manager process is healthy.
The doctor keeps those observations separate from enumeration, processing, and
record coverage. Embedding and daemon capabilities remain `unverified`.

| Cloud heartbeat                                                               | Doctor check              | Doctor readiness |
| ----------------------------------------------------------------------------- | ------------------------- | ---------------- |
| No watcher configured                                                         | `warn not_configured`     | `degraded`       |
| Watcher awaiting its first heartbeat                                          | `warn awaiting_heartbeat` | `degraded`       |
| Fresh heartbeat                                                               | `pass current`            | unaffected       |
| Overdue heartbeat with no incident yet                                        | `warn overdue`            | `degraded`       |
| Open missing-worker incident                                                  | `fail missing_worker`     | `blocked`        |
| Unauthorized, malformed, mismatched, or unreachable diagnostics response      | `warn unavailable`        | `degraded`       |
| See [self-hosting](self-hosting.md) for deployment setup and                  |
| [optional user services](worker-service.md) for local service-manager checks. |

## Fresh-installation demonstration

1. Create a small synthetic text file in the configured folder.
2. Run doctor and resolve any blocked diagnostic. A never-scanned source and
   `recordCoverage: not_established` are expected initially.
3. Run one worker pass:

   ```sh
   node packages/pipeline/dist/cli.js run --config /absolute/path/to/pipeline.json
   ```

4. Run doctor again. Inspect enumeration and processing separately from its
   operational state.
5. With an authorized reader, query the hosted text and citations. Stop the
   worker and repeat the read to check that lookup uses hosted information.

Use the [worker limits and recovery guidance](filesystem-worker.md) for file
errors, ambiguous paths, rate limiting, and incomplete assessments.
