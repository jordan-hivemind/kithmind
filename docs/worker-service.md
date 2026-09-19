# Filesystem worker service recipes

These optional recipes run the existing filesystem worker `watch` command as
a per-user service. Start with synthetic files. Do not ingest owner documents
until a backup independent of the source computer, key escrow, and the
restore and owner-pilot gates in the
[Phase 2 plan](plans/2026-09-07-phase2-document-pipeline.md) are complete.

Build and check the worker before configuring a service:

```sh
pnpm exec turbo run build --filter=@repo/pipeline
pnpm --silent brain:doctor -- --config /absolute/path/to/pipeline.json --json
```

The doctor reports `ready`, `degraded`, or `blocked`. It checks the worker
configuration and local prerequisites without an admin credential. Resolve a
blocked result before continuing. A ready result does not establish unattended
health. The `watch` command sends one cloud heartbeat every 30 seconds,
including while a pass is running. The server considers it overdue after 180
seconds. A fresh heartbeat proves only authorized worker-to-gateway
reachability. It does not prove file access, queue coverage, record
completeness, or a supervised process. `run` and `doctor` never send
heartbeats.

The watcher identity the heartbeat presents comes from the journal's random
salt and its endpoint, space, source account and credential slot. Changing the
watched roots, the parser path or the `pdfDocQa` block does not change it, and
neither does moving the journal to a new host. Creating a new journal does: the
salt is new, so the watcher is new, and the server has to be told.

If the health screen shows the Documents watcher with an `identity` pill, this
host's heartbeats are being refused -- it is up and its passes are landing, but
the server has a different watcher registered for the source. Use "Re-register
watcher" in that row's kebab. It clears the registration and the next heartbeat,
within thirty seconds, claims it. Do not stop the watcher first; the host that
is running is the one that should claim the source.

Copying a journal to a second machine copies the watcher identity with it, so
both hosts heartbeat as the same watcher. Run only one. If both run, the
Documents watcher row shows a `2 hosts` pill within about a minute: each worker
process sends a random nonce, and a nonce arriving again after a different one
can only mean two live processes. Stop one host; the pill clears itself once
the survivor has held the heartbeat alone for ten minutes. Heartbeats are
accepted from both throughout, so neither host stops ingesting while this is
sorted out.

After rotating a credential with a quiescent journal, use one authorized
`run` to validate and accept the replacement before restarting `watch`.
Watch refuses an unaccepted credential binding before sending a heartbeat.
Synthetic verification passed this quiescent rotation sequence with the journal
unchanged before acceptance and the old key revoked. The replacement run
completed without publication or catalog changes; the subsequent watch kept
the same watcher identity and published no documents. An
interrupted active journal still requires explicit credential recovery; do not
delete its pending state.

Keep the pipeline configuration, journal, credential material, wrapper, and
logs outside the repository. Use absolute paths throughout the templates. The
pipeline configuration names `KITH_WORKER_KEY` in `credentialEnv`; it never
contains the credential itself. The credential must not appear in a command
argument, plist, service unit, pipeline configuration, or journal.

## macOS LaunchAgent

The macOS template is a per-user LaunchAgent. Apple documents that user agents
run only while that user is logged in. This recipe does not install a system
LaunchDaemon or change that lifetime. The plist uses explicit
`ProgramArguments`, keeps the foreground worker alive, and sets a 30-second restart throttle. See Apple's
[launchd job guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).

Copy the wrapper to a private directory and the plist to the per-user agent
directory:

```sh
mkdir -p /absolute/path/to/private-worker-service "$HOME/Library/LaunchAgents"
chmod 700 /absolute/path/to/private-worker-service
cp examples/worker-service/macos-keychain-watch.sh /absolute/path/to/private-worker-service/macos-keychain-watch.sh
cp examples/worker-service/com.kithmind.filesystem-worker.plist "$HOME/Library/LaunchAgents/com.kithmind.filesystem-worker.plist"
chmod 700 /absolute/path/to/private-worker-service/macos-keychain-watch.sh
chmod 600 "$HOME/Library/LaunchAgents/com.kithmind.filesystem-worker.plist"
```

Edit the private copies:

- `/absolute/path/to/private-worker-service/macos-keychain-watch.sh`: set the dedicated
  Keychain service and account, the absolute Node executable, repository, and
  pipeline configuration paths.
- `$HOME/Library/LaunchAgents/com.kithmind.filesystem-worker.plist`: set the
  absolute wrapper, repository, and private log paths.

Create a dedicated Keychain item without placing its value in the command
line. The `security` help requires `-w` to be the final option to prompt for the
password instead of accepting it as an argument:

```sh
/usr/bin/security add-generic-password -U -a "$USER" -s com.example.kithmind.filesystem-worker -w
```

Use the same account in the wrapper as the `-a` value above. Pre-create private
log files and validate the edited plist:

```sh
mkdir -p /absolute/path/to/private-log-directory
chmod 700 /absolute/path/to/private-log-directory
touch /absolute/path/to/private-log-directory/worker.stdout.log /absolute/path/to/private-log-directory/worker.stderr.log
chmod 600 /absolute/path/to/private-log-directory/worker.stdout.log /absolute/path/to/private-log-directory/worker.stderr.log
plutil -lint "$HOME/Library/LaunchAgents/com.kithmind.filesystem-worker.plist"
```

Run the wrapper interactively once. Keychain may require an access prompt; do
not assume it will be available while the login keychain is locked:

```sh
/absolute/path/to/private-worker-service/macos-keychain-watch.sh
```

Wait for the foreground worker to start, then stop it with Control-C. Load and
inspect the per-user agent in a new command:

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.kithmind.filesystem-worker.plist"
launchctl kickstart -k "gui/$(id -u)/com.kithmind.filesystem-worker"
launchctl print "gui/$(id -u)/com.kithmind.filesystem-worker"
```

Unload it with:

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.kithmind.filesystem-worker.plist"
```

The wrapper reads only the named Keychain item into a shell variable, exports
it under the worker's configured environment name, and replaces itself with
the absolute Node command. It never places the value in `ProgramArguments` or
the process argument list. Its `umask 077` applies to files the worker creates;
the plist log files are pre-created separately because `launchd` opens them.

## Linux systemd user service

The Linux template is a user service. It uses `LoadCredential` with an explicit
private source file outside the repository. At activation, systemd exposes the
credential as a file under `$CREDENTIALS_DIRECTORY`; the wrapper reads that
file, exports the value required by the current worker, and replaces itself
with the absolute Node command. See systemd's
[service credential documentation](https://systemd.io/CREDENTIALS/).

`LoadCredential` does not encrypt the source file at rest. Store that file on
an appropriately protected or encrypted host filesystem with mode `0600`. A
host that supports and has tested an encrypted credential or credential-store
integration may substitute it, but this template does not assume a particular
systemd version or host facility.

Copy the wrapper to a private directory and the unit to the user service
directory:

```sh
mkdir -p /absolute/path/to/private-worker-service "$HOME/.config/systemd/user"
chmod 700 /absolute/path/to/private-worker-service
cp examples/worker-service/linux-credential-watch.sh /absolute/path/to/private-worker-service/linux-credential-watch.sh
cp examples/worker-service/kithmind-filesystem-worker.service "$HOME/.config/systemd/user/kithmind-filesystem-worker.service"
chmod 700 /absolute/path/to/private-worker-service/linux-credential-watch.sh
chmod 600 "$HOME/.config/systemd/user/kithmind-filesystem-worker.service"
```

Edit the private copies:

- `/absolute/path/to/private-worker-service/linux-credential-watch.sh`: set the absolute Node,
  repository, and pipeline configuration paths.
- `$HOME/.config/systemd/user/kithmind-filesystem-worker.service`: set the
  absolute repository, wrapper, and private credential-file paths.

Create the plaintext source file without placing its value in an argument. Use
a private credential directory that is separate from the worker journal. This
subshell refuses to overwrite an existing credential and discards its shell
variable when it exits. Run the block in Bash or zsh:

```bash
(
  set -euC
  umask 077
  credential_directory=/absolute/path/to/private-worker-credential
  credential_path="$credential_directory/worker-key"
  mkdir -p "$credential_directory"
  chmod 700 "$credential_directory"
  printf 'Worker credential: ' >&2
  IFS= read -r -s KITH_WORKER_KEY
  printf '\n' >&2
  if [ -z "$KITH_WORKER_KEY" ]; then
    printf 'Credential must not be empty.\n' >&2
    exit 1
  fi
  printf '%s' "$KITH_WORKER_KEY" > "$credential_path"
  chmod 600 "$credential_path"
)
```

Install and inspect the user service:

```sh
systemctl --user daemon-reload
systemctl --user enable --now kithmind-filesystem-worker.service
systemctl --user status kithmind-filesystem-worker.service
journalctl --user -u kithmind-filesystem-worker.service
```

Stop and disable it with:

```sh
systemctl --user disable --now kithmind-filesystem-worker.service
```

A user manager normally follows the user's login lifecycle. If the worker must
run before login or remain after logout, inspect the host's policy and
`loginctl enable-linger` behavior first. The [loginctl reference](https://github.com/systemd/systemd/blob/main/man/loginctl.xml)
documents that lingering starts the user manager at boot and retains it after
logout. Enabling it is a
separate host policy decision and may require administrator authorization.

The unit and wrapper both set a restrictive umask and use a 30-second restart
delay. Service-manager status proves only that a process is supervised. Use
the worker doctor and authorized source status for point-in-time checks.

## Deferred work daemon

Section 2.6 of the [PostgreSQL consolidation
plan](plans/2026-09-12-postgres-consolidation.md) runs Convex's four
maintenance crons and its ten `scheduler.runAfter` call sites from this same
always-on host instead of from Convex, through `kith.deferred_work`
(`packages/kith-store/src/deferred/`) and the `kith-deferred-work` command
(`packages/kith-store/src/deferred/cli.ts`). It reads `KITH_STORE_DATABASE_URL`,
plus the embedding provider key (`OPENAI_API_KEY` or the `BRAIN_EMBED_*` set) that
`embedding_fill` jobs use; nothing else.

Run one round by hand to check the command before installing a service:

```sh
pnpm exec turbo run build --filter=@repo/kith-store
KITH_STORE_DATABASE_URL=postgres://... node packages/kith-store/dist/deferred/cli.js once
```

`once` runs every sweep (stranded inline ingestion recovery, expired OAuth
grants, expired worker protocol state) and then drains due jobs once, prints
one JSON summary line, and exits. `tick --interval-ms 60000` does the same on
a loop and is what the service below runs continuously; `drain
[--interval-ms N] [--max-jobs N]` drains jobs without running the sweeps, for
an operator who wants to catch up a backlog without waiting on the sweep
schedule.

A missed round costs nothing: every sweep and every drained job is
idempotent, and scheduling the same job twice while it is still queued is a
no-op (`dedupeKey`). There is no equivalent of the filesystem worker's cloud
heartbeat for this daemon; its liveness is `docs/worker-doctor.md`'s concern
for the process that runs it, not this one's.

The fourth Convex cron, `detect missing filesystem workers`, is not a sweep
here at all. It becomes a read-time predicate
(`isWatcherOverdue`/`watcherStaleness` in
`packages/kith-store/src/workers/diagnostics.ts`) that a status route or
`brain doctor` calls directly, so a host that is down still reports itself
stale. The one piece that still needs to run on a schedule is the durable
incident record for alerting
(`recordMissingWorkerIncidents`, same file): at most one open
`missing_worker` incident row per watcher, written once a day. That is a
Vercel Hobby cron, not this daemon -- the Hobby plan allows exactly one run
per day, which is what a once-daily incident write needs and per-minute sweeps
do not fit into.

### macOS LaunchAgent

`docs/kithmind-deferred-work.launchd.plist.txt` is a copy-and-fill template
for a per-user LaunchAgent running `kith-deferred-work tick --interval-ms
60000` continuously, the same `RunAtLoad`/`KeepAlive`/`ThrottleInterval` shape
the filesystem worker's own LaunchAgent above uses. Follow that section's
Keychain, wrapper, `plutil -lint`, and `launchctl bootstrap`/`kickstart`
steps, substituting the deferred-work label, wrapper, and `KITH_STORE_DATABASE_URL`
Keychain item for the filesystem worker's own.

## Discovery work stuck at the attempt cap

A discovery work row is refused once its `attempts` reaches
`MAX_WORKER_DISCOVERY_ATTEMPTS` (8). Both reserve paths return `lease_conflict`
at the cap, and nothing in the protocol lowers the counter, so a document whose
attempts were spent on a client defect stays unreachable after the defect is
fixed. Use `kith-discovery-reset` (`packages/kith-store/src/workers/cli.ts`)
when a pass reports `lease_conflict` on an item and that item is at the cap. It
resets the counter and returns the row to `queued`, so the next pass reserves it
once in the normal way.

It reaches only rows that ran out of attempts without anything having judged the
document: `queued` and `leased`. A `failed` row at the cap is a settled parse
failure and a `needs_review` row is parked for a review, so neither is swept
here; retrying those is a per-row decision that wants to see what the row is
holding, which this command does not report. It refuses a row whose lease has
not expired, because a live worker may still hold it, and it never touches a
successfully admitted row, superseded history, `lease_epoch`, or anything
outside the work row. A second run is a no-op.

A run counts and writes nothing unless `--apply` is given. A count may sweep
every space; a write may not, so `--apply` requires `--space`.

```sh
pnpm exec turbo run build --filter=@repo/kith-store
KITH_STORE_DATABASE_URL=postgres://... node packages/kith-store/dist/workers/cli.js
KITH_STORE_DATABASE_URL=postgres://... node packages/kith-store/dist/workers/cli.js --space <id>
KITH_STORE_DATABASE_URL=postgres://... node packages/kith-store/dist/workers/cli.js --space <id> --apply
```

Output is one JSON line per space carrying the space id, the eligible count and
the reset count, and nothing else.

## A local receipt the server does not hold

A pass that meets `original_receipt_unknown_to_server` has met a contradiction:
the local archive catalog records an admission for the original, and the
authoritative server says it has never seen that revision. A receipt records
that original bytes were accepted somewhere, and dropping one on a server's
silence would re-admit anything a temporary misrouting had touched.

Since P2-31f a pass repairs this itself only in the one case where it is
provably safe: the catalog holds no other filing receipt, so there is nothing a
wider failure could be hiding. Every other case is parked, and the route for it
is in the parked documents section below, not this command: `reconcile-receipts`
addresses only the document the pass is currently on, and a parked document is
one the pass has walked past. Use this command while the pass is still stopped
on the document, and the parked route otherwise.

It is client only. It sends one `discovery.lookupArchivedAdmission`, the same
read-only lookup the pass itself uses, which reserves nothing and spends no
discovery attempt, and it changes nothing server side. A receipt the server
does confirm is never touched.

That lookup is addressed by the whole archived work identity, and only the
checkpoint's scan plan carries it, so the command asks about the checkpoint's
current original and no other row. It reports how many local originals hold a
receipt so a wider problem is still visible in the counts.

Stop the watcher first. The command takes the journal lock the way `run` does
and refuses `journal_contended` while the watcher holds it.

```sh
launchctl bootout gui/$(id -u)/<watcher-label>
pnpm exec turbo run build --filter=@repo/pipeline
pnpm --silent brain:worker -- reconcile-receipts --config /absolute/path/to/pipeline.json --json
pnpm --silent brain:worker -- reconcile-receipts --config /absolute/path/to/pipeline.json --apply --json
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<watcher-label>.plist
```

A dry run reports counts only, for example
`{"state":"unknown_receipt_found","scope":"checkpoint_original","applied":false,"originalsWithReceipts":1,"receiptsChecked":1,"receiptsConfirmed":0,"receiptsUnknown":1}`.
`--apply` answers `"state":"reconciled"` with `"applied":true`. A second run
answers `"state":"clean"` with every count at zero, and a run with nothing to
do answers the same.

With `--apply` it clears, on the original row and its processing row, exactly
what an admission wrote: each row's `cloud` record and every per-copy
`cloudReceipt`. The archive copies, the restic backup, the provider locator and
its proof, the capture and the spool all stay, because the bytes are archived
and only the server-side receipt is void. It leaves a note on each row carrying
a code and the time, and no ids. The journal checkpoint rewinds to the
read-only lookup with the dead lease dropped, so the next pass takes the
ordinary first-admission path: the original lookup, the processing lookup, one
reserve and one admit.

Builds before P2-31f left that original lookup unresolved in the journal, with
the server's not-found answer already recorded, because the throw happened
inside the journaled transition and no `run` could drain it. The command still
expects and handles that state: it uses the recorded answer rather than asking
again, clears the catalog, and leaves the checkpoint alone, because the replay
makes the same move by itself once the row holds no receipt. Any other
unresolved request still refuses.

A refusal writes nothing and names why: `journal_contended` (stop the watcher),
`journal_request_pending` (an unresolved request that is not the lookup above;
run one `run`), `checkpoint_not_archived`, `checkpoint_rows_missing`,
`checkpoint_plan_missing`, `processing_receipt_conflict` (the processing
receipt names a different revision), `processing_already_activated` (a
generation is live server side under this admission, which is P2-31's work),
`lookup_refused` (the server's own code is in `lookupCode`) or
`lookup_invalid`. The two processing refusals apply to the dry run as well, so
a count never hides what `--apply` would have met. Exit status is 1 on a
refusal and 0 otherwise.

## Parked documents

One document can meet a condition that is terminal for it and says nothing
about any other file. Before P2-31f such a condition ended the whole pass, so
one stuck document stopped every other file from being filed, on every pass,
until an operator intervened. A pass now records a marker on that document and
carries on. It ends `complete` or `incomplete` by the ordinary rules and never
`failed` when parked documents are the only problem.

Parking is the last resort, not the first move. Each condition is repaired
automatically where a repair is provably safe, and parked documents are retried
on their own before anyone is asked to look.

| Code | What it means | Automatic recovery |
| ---- | ------------- | ------------------ |
| `provider_verification_stale_review_required` | The proof that the document matches its cloud copy expired. | Refreshed in place on a never-admitted original. Parks only if the refresh still yields a stale proof, or if the original is already admitted, which needs P2-31. |
| `original_receipt_unknown_to_server` | The document has a filing receipt the server has no record of. | Repaired in the pass by the `reconcile-receipts` logic, subject to the safety limits below. Parks when this document's own state forbids the repair: its processing row or a sibling row is activated, a processing receipt names another revision, or its receipt has been cleared once before. |
| `catalog_conflict` | The document changed on disk while it was being filed. | None needed. The bounded retry clears it once the file stops changing. |
| `original_receipt_revision_conflict` | The server and this computer disagree about which version was accepted. | None. Choosing a version could file the wrong document, so a person decides. |
| `archive_catalog_revision_conflict` | The document's local records disagree about which version was published. | None. Picking one risks the wrong generation, so a person decides. |
| `provider_original_reference_already_bound` | The document is already filed under a reference the server will not accept twice. | None. Admitting against an existing reference has no protocol shape yet; this is P2-31. |
| `receipt_clear_refused_by_safety_limit` | A receipt looked wrong and the pass stopped rather than repair it, because the server itself may be wrong. | None, deliberately. Check the deployment first. |

No condition that means the whole run is in trouble is ever parked. Credential,
journal, archive repository, server unavailable, rate limit and scan conflict
failures still end the pass.

### Safety limits on the automatic receipt repair

Retiring a filing receipt is the one repair a pass makes that cannot be undone,
and the failure it repairs -- a server that has never heard of a document this
computer believes it filed -- looks from one document exactly like a server
that has lost everything. The operator command has a person reading the counts
first. The automatic route has these limits instead, and refuses with
`receipt_clear_refused_by_safety_limit` unless all of them hold:

- the document's receipt has never been cleared before, at most one automatic
  repair per document ever;
- no other document was repaired in the last 24 hours, at most one per day;
- nothing else in the catalog could be hidden by the failure. The repair is
  safe on its own only when this receipt is the only one the catalog holds:
  with others present, a server that has lost everything and the one genuinely
  misrouted document look identical from here, and no read this worker can make
  during a pass can tell them apart. Three were tried. Asking the server about
  an already filed document is refused, because the server answers that
  question through a work row that a filed document no longer has. The status
  counts are absent from the moment a pass starts its scan. The inventory page
  is refused outside a recovery scan. So a catalog with more than one filing
  receipt always parks, and an operator decides.

A repair a pass makes and one an operator asks for are both appended to the
document's own record, so a second one is visible rather than silent.

Three automatic retries six hours apart lapse well inside the one-per-day
limit, so a document parked on that limit spends its retries without ever being
eligible again and is escalated. That is by design: the second and third
attempts would be the same guess, and the answer is an operator decision.

### Repairing a parked receipt yourself

`reconcile-receipts` only ever addresses the document the pass is currently on,
and a parked document is one the pass has walked past, so the command cannot
reach it. It reports parked documents by count and code on every answer,
including a refusal, which makes it the dry run. The apply step is a pass an
operator starts.

This command is the sharpest tool here. Against a wrong or empty backend it
voids every receipt it reaches, and each of those documents is then re-admitted
to that backend on the same pass. The relaxed rules apply to every document in
the pass whose own lookup returns a well-formed "not found", which is not the
same set as the parked ones and can be larger. Work through these
preconditions in order, and do not skip one:

1. Run `doctor` and confirm the report is healthy apart from the parked items.
2. Confirm the web deployment and its database are the intended ones: check the
   health endpoint, and confirm a known document is still retrievable through
   MCP. A backend that answers but holds nothing is the case this guards.
3. Run the `reconcile-receipts` dry run and read `parkedOriginals` and
   `parkedCodes`.
4. Run with `--max-clears` set to exactly that `parkedOriginals` count.

```sh
launchctl bootout gui/$(id -u)/<watcher-label>
pnpm --silent brain:worker -- doctor --config /absolute/path/to/pipeline.json --json
pnpm --silent brain:worker -- reconcile-receipts --config /absolute/path/to/pipeline.json --json
pnpm --silent brain:worker -- run --config /absolute/path/to/pipeline.json --retry-parked --operator-clear --max-clears <parkedOriginals>
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<watcher-label>.plist
```

The run clears every marker, retries each parked document, and repairs a
receipt the server denies when the document's own state allows it: the
processing row and its siblings are not activated, no processing receipt names
another revision, and the server's answer is a well-formed "not found". A
refused or unanswered lookup is not a "not found" and retires nothing. It does
not apply the once-ever or once-per-day limits, which exist only because a pass
decides alone. Once `--max-clears` is spent the rest of the pass parks as
usual. Before the first clear the pass writes one line to stderr with the
counts it is about to act on, and the result reports `operatorClears`. Every
clear is recorded against the document as an operator clear.

`--operator-clear` is refused without `--retry-parked`, and refused without
`--max-clears`; `--max-clears` is refused on its own. The per-document record
keeps the last 16 clears, so a document cleared repeatedly shows its recent
history rather than all of it.

### Documents that need attention

A parked document is `escalated` when its code has no automatic recovery, or
when its retries are spent. A pass carrying one ends `incomplete` with code
`items_need_attention` and a nonzero exit, so it does not read as a clean
`complete`. Documents still inside their retry budget are counted and leave the
pass as it was.

A parked document is offered to the pass again when any of these happens, in
order of how often they do:

- its bytes change, which lands it on a fresh catalog row with no marker;
- the runner's handling of these codes changes, which a new build records as a
  different capability fingerprint;
- its bounded retry comes round, at most once every six hours and at most three
  times, after which it waits;
- an operator runs `run --retry-parked`, which clears every marker.

Publishing a document clears its marker.

### What an operator sees

A pass result carries `parked`, `parkedCodes` and `parkedOldestAgeMs` when any
document is parked, and none of the three when none is. A watcher writes one
result object per pass, so its log is the durable record:

```json
{"state":"incomplete","code":"items_need_attention","scanned":42,"published":41,"parked":1,"parkedEscalated":1,"parkedCodes":["original_receipt_revision_conflict"],"parkedOldestAgeMs":93600000}
```

`doctor` reports the same thing without taking the journal lock, so it works
while the watcher runs. The report carries a seventh check, `archive`, whose
code is `none_parked`, `items_parked`, `items_escalated` or `not_checked`. The
check carries `parked`, `parkedEscalated`, `parkedCodes` and
`parkedOldestAgeMs`, and the text output adds one line per code saying what it
means and what to do. See `worker-doctor.md` for the readiness each code
implies. Counts and codes only: no file name, no path and nothing a document
contains ever appears in a result or a report.

Alert on `parkedEscalated` above zero, and on `parkedOldestAgeMs` past a
threshold. A `receipt_clear_refused_by_safety_limit` is the one to look at
first: it says this computer suspects the server rather than the document.

To retry everything that is parked, stop the watcher, run one pass with the
flag, and start it again:

```sh
launchctl bootout gui/$(id -u)/<watcher-label>
pnpm --silent brain:worker -- run --config /absolute/path/to/pipeline.json --retry-parked
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<watcher-label>.plist
```

The flag clears every marker, including the attempt counts, so a document that
still meets its condition is parked again with one attempt recorded.

A parked document is not reported to the server, so the server-side processing
assessment still counts it under `pending`, or under `unavailable` when it was
never admitted. An assessment carrying a parked document therefore reads
`incomplete`, which is correct: that document has not been filed.

## Template validation

The macOS plist and both shell wrappers are syntax-checked in this repository.
The Linux unit is reviewed as a template, but systemd runtime validation is not
performed on macOS. Validate the edited unit on its target Linux host with the
installed systemd tools before enabling it. The deferred-work plist template
in `docs/` is text only and is not part of that check.
