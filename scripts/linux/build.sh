#!/usr/bin/env bash
# Builds Kern's Linux bundles (.deb, .rpm, AppImage) inside the container
# defined by the Dockerfile next to this script. From the repository root:
#
#   docker build -t kern-linux scripts/linux
#   docker run --rm -v "$PWD:/repo:ro" -v "$PWD/release/linux:/out" \
#     -v kern-cargo:/root/.cargo/registry -v kern-target:/build/src-tauri/target kern-linux
#
# The repository is mounted read-only and copied in, so host node_modules and
# build output never mix with the Linux build. The two named volumes are caches.
set -euo pipefail

mkdir -p /build /out
tar -C /repo --exclude=./node_modules --exclude=./dist --exclude=./release --exclude=./src-tauri/target -cf - . | tar -C /build -xf -
cd /build

npm ci --no-audit --no-fund
npx tauri build

bundle=src-tauri/target/release/bundle
cp -v "$bundle"/deb/*.deb "$bundle"/rpm/*.rpm "$bundle"/appimage/*.AppImage /out/
