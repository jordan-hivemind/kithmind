#!/bin/sh

set -eu
umask 077

credential_directory="${CREDENTIALS_DIRECTORY:?}"
credential_path="$credential_directory/kithmind-worker-key"
if [ ! -f "$credential_path" ] || [ ! -r "$credential_path" ]; then
  exit 1
fi

credential="$(/bin/cat -- "$credential_path")"
if [ -z "$credential" ]; then
  exit 1
fi

KITH_WORKER_KEY="$credential"
export KITH_WORKER_KEY
unset credential

exec "/ABSOLUTE/PATH/TO/NODE" \
  "/ABSOLUTE/PATH/TO/REPOSITORY/packages/pipeline/dist/cli.js" \
  watch \
  --config "/ABSOLUTE/PATH/TO/pipeline.json"
