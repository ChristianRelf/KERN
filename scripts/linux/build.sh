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
# .git is excluded as well as the build output: nothing here needs history,
# and a concurrent commit or push on the host would otherwise change it
# mid-read and fail the copy.
tar -C /repo --exclude=./.git --exclude=./node_modules --exclude=./dist --exclude=./release --exclude=./src-tauri/target -cf - . | tar -C /build -xf -
cd /build

npm ci --no-audit --no-fund

# The target directory is a cache that outlives one build, so bundles from
# an earlier version are still sitting in it. Clear them, or the copy below
# picks them up too and a release ends up carrying both versions.
rm -rf src-tauri/target/release/bundle

# With a signing key in the environment the AppImage also gets its updater
# signature, so Linux installs can update themselves like the Windows ones.
# Without one this stays an ordinary build (.deb/.rpm/AppImage only).
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo '{"bundle":{"createUpdaterArtifacts":true}}' > /build/release.conf.json
  npx tauri build --config /build/release.conf.json
else
  npx tauri build
fi

bundle=src-tauri/target/release/bundle
cp -v "$bundle"/deb/*.deb "$bundle"/rpm/*.rpm "$bundle"/appimage/*.AppImage /out/
# The .sig only exists when the build was signed.
cp -v "$bundle"/appimage/*.AppImage.sig /out/ 2>/dev/null || true
