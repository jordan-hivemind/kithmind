# Dated encrypted database backups

## Design

Create a dated native Convex ZIP that includes file storage. Treat the ZIP and
its manifest as credential-bearing artifacts: stage them only in a protected
local directory with mode `700`, and write files with mode `600`.

Before export, perform an explicit deployment preflight. Verify the intended
deployment, authenticated identity, and team or project context in the same
credential context. Record a manifest containing the export date, deployment
identity, schema and Git versions, file list, byte lengths, and hashes.

Encrypt the native ZIP and manifest before uploading them to Dropbox. Verify
the expected real Dropbox folder identity before publication. Keep the restic
repository separate from processing artifacts and verify its expected real
repository identity before use.

For verification, use a separate process with no cache. Dump the encrypted
objects, decrypt with the protected age identity, and compare bytes with the
staged ZIP and manifest. Never copy existing Dropbox PDFs into the backup
set; only Kith-created state is eligible.

Recovery enumerates restic snapshots by the fixed database host and tag, then
inspects the exact object path. It verifies the exact repository, password,
and age identities through protected key recovery before decrypting.

## Recipe

1. Resolve the explicit deployment and run the credential preflight.
2. Export the native Convex ZIP with file storage enabled.
3. Write and hash the Git and schema version manifest.
4. Encrypt the ZIP and manifest in the protected staging directory.
5. Verify the real Dropbox folder and restic repository identities.
6. Publish the encrypted bundle to the database restic repository.
7. In a separate no-cache process, dump, decrypt, and compare exact bytes.
8. Record the dated proof and retain only Kith-created backup state.

## Status and acceptance

The first production baseline operation passed export and exact remote decrypt
verification on 2026-09-08. The public generic runner merged in PR79. Private
owner adapters now run through an installed daily service; its first actual
service run passed export, encryption, remote readback and decryption. A new schema still requires a fresh evidence bundle.
The additional current-schema evidence is local only and is not part of the
remote version-1 manifest. A scheduled snapshot does not itself perform an
isolated restore.

The previous isolated native restore proof from P223 is separate evidence. It
does not claim that the latest production ZIP was imported.

Acceptance requires an explicit deployment preflight, protected staging and
permissions, a Git and schema manifest, encryption before Dropbox publication,
separate restic processing storage, real folder and repository identity checks,
separate-process no-cache byte equality, and recovery by fixed host, tag, and
exact object path.
