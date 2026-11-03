#!/usr/bin/env bash
# Install Zendo with one command (macOS and Linux):
#   curl -fsSL https://raw.githubusercontent.com/warfollowsme/zendo/main/install.sh | bash
#
# 1. Checks for git and Zen (and that Zen has been run once — a profile is needed).
# 2. Downloads Zendo to ~/.local/share/zendo (or updates it if already downloaded).
# 3. Connects it to the Zen profile and installs the script loader (bin/install --autoconfig);
#    on Linux, copying into Zen's folder may ask for the sudo password.
# 4. Makes the Zendo launcher (bin/app): Zendo.app on macOS, a menu entry on Linux,
#    and starts it.
#
# Variables: ZENDO_HOME — where to download, ZENDO_USER — personal layer
# (default ~/.config/zendo), ZENDO_REPO — where to download from.
set -euo pipefail

REPO="${ZENDO_REPO:-https://github.com/warfollowsme/zendo.git}"
DEST="${ZENDO_HOME:-$HOME/.local/share/zendo}"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
ask()  { # ask "Question" — yes if answered y; no without a terminal
  local answer=""
  [ -r /dev/tty ] || return 1
  printf '%s [y/N] ' "$1" > /dev/tty
  read -r answer < /dev/tty || true
  case "$answer" in y|Y|yes|д|Д|да) return 0 ;; *) return 1 ;; esac
}

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux) OS=linux ;;
  *) die "Zendo works on macOS and Linux. For Windows, see the README." ;;
esac

if ! command -v git >/dev/null 2>&1 || { [ "$OS" = mac ] && ! xcode-select -p >/dev/null 2>&1; }; then
  if [ "$OS" = mac ]; then
    xcode-select --install >/dev/null 2>&1 || true
    die "git is needed: finish installing Apple Command Line Tools in the window that opened, then run this command again."
  fi
  die "git is needed: install it with your package manager (e.g. sudo apt install git), then run this command again."
fi

if [ -d "$DEST/.git" ]; then
  say "Updating Zendo in $DEST"
  git -C "$DEST" pull --ff-only --quiet || die "Could not update $DEST — run: git -C \"$DEST\" pull"
else
  [ -e "$DEST" ] && die "$DEST already exists and is not Zendo. Remove it or set ZENDO_HOME."
  say "Downloading Zendo to $DEST"
  mkdir -p "$(dirname "$DEST")"
  git clone --quiet "$REPO" "$DEST"
fi

# From here on, the project's own helpers know where Zen and its profile are.
source "$DEST/bin/_lib.sh"

AUTOCONFIG="--autoconfig"
if ! detect_app_resources >/dev/null 2>&1; then
  if zen_flatpak; then
    warn "Zen from Flathub keeps its program folder read-only: Zendo installs themes, mods and site styles, but not the scripts (window layout, AI assistant). For everything, use Zen from the tarball or your distro's package."
    AUTOCONFIG=""
  elif [ "$OS" = mac ]; then
    die "Zen is not installed. Get it at https://zen-browser.app (or: brew install --cask zen), launch it once, then run this command again."
  else
    die "Zen is not found. Install it from https://zen-browser.app, launch it once, then run this command again (or set ZEN_APP=/path/to/zen-folder)."
  fi
fi
if ! active_profile >/dev/null 2>&1; then
  start_zen || true
  die "Zen has never been launched: it is opening now to create a profile. Quit it and run this command again."
fi

if zen_running; then
  ask "Zen is running. Quit it to continue?" || die "Quit Zen and run this command again."
  if [ "$OS" = mac ]; then
    osascript -e "quit app \"$(basename "$(cd "$(detect_app_resources)/../.." && pwd -P)" .app)\"" >/dev/null 2>&1 || true
  else
    pkill -x zen 2>/dev/null || pkill -x zen-bin 2>/dev/null || pkill -x zen-browser 2>/dev/null || true
  fi
  for _ in $(seq 1 40); do
    zen_running || break
    sleep 0.25
  done
  zen_running && die "Zen did not quit. Close it and run this command again."
fi

say "Linking Zendo to your Zen profile"
"$DEST/bin/install" $AUTOCONFIG

if [ "$OS" = mac ]; then
  APPS="/Applications"
  [ -w "$APPS" ] || APPS="$HOME/Applications"
  mkdir -p "$APPS"
  "$DEST/bin/app" "$APPS"
  LAUNCHER="Launch Zen with Zendo.app from now on (drag it to the Dock in place of Zen)"
else
  "$DEST/bin/app"
  LAUNCHER="Launch Zen with Zendo from the applications menu from now on (pin it in place of Zen)"
fi

say "Done."
cat <<EOF

  $LAUNCHER:
  after a Zen update it puts the script loader back by itself.

  Your own themes, mods and settings: $ZENDO_USER
  Update Zendo:   $DEST/bin/update
  Remove Zendo:   $DEST/bin/uninstall --autoconfig

EOF
if [ "$OS" = mac ]; then
  open "$APPS/Zendo.app"
else
  "$DEST/bin/launch" || true
fi
