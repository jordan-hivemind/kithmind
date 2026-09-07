#!/bin/sh

set -eu
umask 077

KEYCHAIN_SERVICE="com.example.kithmind.filesystem-worker"
KEYCHAIN_ACCOUNT="REPLACE_WITH_KEYCHAIN_ACCOUNT"

credential="$(
  /usr/bin/security find-generic-password \
    -s "$KEYCHAIN_SERVICE" \
    -a "$KEYCHAIN_ACCOUNT" \
    -w
)"
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
