#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/dist}"
EXTENSION_UUID="gnome-totp-authenticator@talhasiddique7"
STAGING_ROOT="$(mktemp -d)"
STAGING_DIR="$STAGING_ROOT/$EXTENSION_UUID"

cleanup() {
    rm -rf -- "$STAGING_ROOT"
}
trap cleanup EXIT

for command in gnome-extensions glib-compile-schemas; do
    if ! command -v "$command" >/dev/null 2>&1; then
        printf 'Required build tool not found: %s\n' "$command" >&2
        exit 1
    fi
done

mkdir -p "$STAGING_DIR" "$OUTPUT_DIR"

for item in extension.js metadata.json prefs.js stylesheet.css icons lib schemas ui; do
    if [[ ! -e "$ROOT_DIR/$item" ]]; then
        printf 'Required extension source is missing: %s\n' "$item" >&2
        exit 1
    fi
    cp -R -- "$ROOT_DIR/$item" "$STAGING_DIR/"
done

glib-compile-schemas --strict "$STAGING_DIR/schemas"
gnome-extensions pack "$STAGING_DIR" \
    --extra-source=icons \
    --extra-source=lib \
    --extra-source=ui \
    --schema=schemas/org.gnome.shell.extensions.gnome-totp-authenticator.gschema.xml \
    --out-dir "$OUTPUT_DIR" \
    --force

printf 'Extension package created in %s\n' "$OUTPUT_DIR"
