# Filesystem worker service recipes

These optional recipes run the existing filesystem worker `watch` command as
a per-user service. Start with synthetic files. Do not ingest owner documents
until the isolated restore and owner-pilot gates in the
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

After rotating a credential with a quiescent journal, use one authorized
`run` to validate and accept the replacement before restarting `watch`.
Watch refuses an unaccepted credential binding before sending a heartbeat.
An interrupted active journal still requires explicit credential recovery;
do not delete its pending state.

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

## Template validation

The macOS plist and both shell wrappers are syntax-checked in this repository.
The Linux unit is reviewed as a template, but systemd runtime validation is not
performed on macOS. Validate the edited unit on its target Linux host with the
installed systemd tools before enabling it.
