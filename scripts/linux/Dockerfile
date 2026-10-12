# Linux release builds. Ubuntu 22.04 keeps the glibc baseline low, so the
# .deb, .rpm and AppImage run on current Debian/Ubuntu/Fedora/Arch and
# derivatives. See build.sh for usage.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl wget file git pkg-config xdg-utils patchelf \
      libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH=/root/.cargo/bin:$PATH
# linuxdeploy (used for the AppImage) is itself an AppImage; containers have no FUSE.
ENV APPIMAGE_EXTRACT_AND_RUN=1

COPY build.sh /usr/local/bin/kern-build
RUN chmod +x /usr/local/bin/kern-build
CMD ["kern-build"]
