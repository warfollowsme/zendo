#!/usr/bin/env bash
# Install Zendo with one command:
#   curl -fsSL https://raw.githubusercontent.com/warfollowsme/zendo/main/install.sh | bash
#
# 1. Checks for macOS, git and Zen (and that Zen has been run once — a profile is needed).
# 2. Downloads Zendo to ~/.local/share/zendo (or updates it if already there).
# 3. Connects it to the Zen profile and installs the script loader (bin/install --autoconfig).
# 4. Builds Zendo.app in /Applications (or ~/Applications) and launches it.
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

[ "$(uname -s)" = Darwin ] || die "Zendo works on macOS for now."

if ! xcode-select -p >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  xcode-select --install >/dev/null 2>&1 || true
  die "git is needed: finish installing Apple Command Line Tools in the window that opened, then run this command again."
fi

ZEN_APP=""
for app in "/Applications/Zen.app" "/Applications/Zen Browser.app" "$HOME/Applications/Zen.app" "$HOME/Applications/Zen Browser.app"; do
  if [ -d "$app" ]; then ZEN_APP="$app"; break; fi
done
if [ -z "$ZEN_APP" ]; then
  die "Zen is not installed. Get it at https://zen-browser.app (or: brew install --cask zen), launch it once, then run this command again."
fi
if [ ! -f "$HOME/Library/Application Support/zen/profiles.ini" ]; then
  open -a "$ZEN_APP"
  die "Zen has never been launched: it is opening now to create a profile. Quit it (Cmd+Q) and run this command again."
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

if pgrep -x zen >/dev/null 2>&1; then
  ask "Zen is running. Quit it to continue?" || die "Quit Zen (Cmd+Q) and run this command again."
  osascript -e "quit app \"$(basename "$ZEN_APP" .app)\"" >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do
    pgrep -x zen >/dev/null 2>&1 || break
    sleep 0.25
  done
  pgrep -x zen >/dev/null 2>&1 && die "Zen did not quit. Close it and run this command again."
fi

say "Linking Zendo to your Zen profile"
ZEN_APP="$ZEN_APP" "$DEST/bin/install" --autoconfig

APPS="/Applications"
[ -w "$APPS" ] || APPS="$HOME/Applications"
mkdir -p "$APPS"
"$DEST/bin/app" "$APPS"

say "Done."
cat <<EOF

  Launch Zen with Zendo.app from now on (drag it to the Dock in place of Zen):
  after a Zen update it puts the script loader back by itself.

  Your own themes, mods and settings: ${ZENDO_USER:-$HOME/.config/zendo}
  Update Zendo:   $DEST/bin/update
  Remove Zendo:   $DEST/bin/uninstall --autoconfig

EOF
open "$APPS/Zendo.app"
