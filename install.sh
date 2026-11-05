#!/usr/bin/env bash

set -euo pipefail

EXTENSION_UUID="gnome-totp-authenticator@talhasiddique7"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"
REQUIRED_FILES=(extension.js metadata.json prefs.js stylesheet.css icons lib schemas ui)

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

printf '%b\n' "${BLUE}Installing GNOME TOTP Authenticator${NC}"

if [[ ! -f "$SCRIPT_DIR/metadata.json" ]]; then
    printf '%b\n' "${RED}Run this script from a complete project checkout.${NC}" >&2
    exit 1
fi

if command -v gnome-shell >/dev/null 2>&1; then
    GNOME_VERSION="$(gnome-shell --version | sed -E 's/.* ([0-9]+)(\..*)?$/\1/')"
    if [[ "$GNOME_VERSION" =~ ^[0-9]+$ ]]; then
        if (( GNOME_VERSION < 45 )); then
            printf '%b\n' "${RED}GNOME Shell 45 or newer is required (found $GNOME_VERSION).${NC}" >&2
            exit 1
        fi
        printf '%b\n' "${GREEN}GNOME Shell $GNOME_VERSION detected.${NC}"
    else
        printf '%b\n' "${YELLOW}Could not parse the GNOME Shell version; continuing.${NC}"
    fi
else
    printf '%b\n' "${YELLOW}GNOME Shell was not found; installing files without enabling the extension.${NC}"
fi

for command in gjs glib-compile-schemas; do
    if ! command -v "$command" >/dev/null 2>&1; then
        printf '%b\n' "${RED}Required command not found: $command${NC}" >&2
        exit 1
    fi
done

if ! gjs -c 'imports.gi.Secret' >/dev/null 2>&1; then
    printf '%b\n' "${RED}GJS libsecret bindings are required. Install libsecret and its GObject introspection bindings.${NC}" >&2
    exit 1
fi

for item in "${REQUIRED_FILES[@]}"; do
    if [[ ! -e "$SCRIPT_DIR/$item" ]]; then
        printf '%b\n' "${RED}Required extension source is missing: $item${NC}" >&2
        exit 1
    fi
done

mkdir -p "$EXTENSION_DIR"
for item in "${REQUIRED_FILES[@]}"; do
    cp -R -- "$SCRIPT_DIR/$item" "$EXTENSION_DIR/"
done

glib-compile-schemas --strict "$EXTENSION_DIR/schemas"
printf '%b\n' "${GREEN}Extension installed at $EXTENSION_DIR${NC}"

if command -v gnome-extensions >/dev/null 2>&1; then
    if gnome-extensions enable "$EXTENSION_UUID"; then
        printf '%b\n' "${GREEN}Extension enabled.${NC}"
    else
        printf '%b\n' "${YELLOW}Files are installed, but automatic enabling failed. Run: gnome-extensions enable $EXTENSION_UUID${NC}"
    fi
else
    printf '%b\n' "${YELLOW}Enable the extension from GNOME Extensions after restarting the Shell.${NC}"
fi
