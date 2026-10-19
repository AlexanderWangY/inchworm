#!/bin/sh
# Package the plugin as build/inchworm-<version>.xpi (a zip with manifest.json at the root).
set -eu
cd "$(dirname "$0")/.."

version=$(node -p "require('./manifest.json').version")
out="build/inchworm-$version.xpi"

mkdir -p build
rm -f "$out"
zip -qr -X "$out" manifest.json bootstrap.js prefs.js src content -x '*.DS_Store'
echo "$out"
