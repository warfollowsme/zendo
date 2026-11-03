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
# In a terminal it asks where to put the base and the personal layer, and for your
# personal layer's repository (Enter keeps the default). The same can be given
# in variables, then that question is skipped: ZENDO_HOME — the base
# (~/.local/share/zendo), ZENDO_USER — the personal layer (~/.config/zendo),
# ZENDO_USER_REPO — its repository, cloned into ZENDO_USER (moving to another
# device; see bin/personal). ZENDO_YES=1 — no questions, defaults everywhere.
# ZENDO_REPO — where to download Zendo from.
set -euo pipefail

REPO="${ZENDO_REPO:-https://github.com/warfollowsme/zendo.git}"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
# A terminal to ask in (curl … | bash reads the script from stdin, so questions go to /dev/tty)
has_tty() { [ -z "${ZENDO_YES:-}" ] && (: < /dev/tty) 2>/dev/null; }
ask()  { # ask "Question" — yes if answered y; no without a terminal
  local answer=""
  has_tty || return 1
  printf '%s [y/N] ' "$1" > /dev/tty
  read -r answer < /dev/tty || true
  case "$answer" in y|Y|yes|д|Д|да) return 0 ;; *) return 1 ;; esac
}
prompt() { # prompt "Question" DEFAULT — the answer; Enter or no terminal — DEFAULT
  local answer=""
  if has_tty; then
    if [ -n "$2" ]; then
      printf '%s [%s]: ' "$1" "$(tilde "$2")" > /dev/tty
    else
      printf '%s: ' "$1" > /dev/tty
    fi
    read -r answer < /dev/tty || true
  fi
  answer="${answer:-$2}"
  case "$answer" in
    "~") answer="$HOME" ;;
    "~/"*) answer="$HOME/${answer#"~/"}" ;;
  esac
  printf '%s\n' "$answer"
}
tilde() { case "$1" in "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;; *) printf '%s' "$1" ;; esac; }

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

DEST="${ZENDO_HOME:-$(prompt "Where to put Zendo (the base)" "$HOME/.local/share/zendo")}"
if [ -d "$DEST/.git" ]; then
  say "Updating Zendo in $DEST"
  git -C "$DEST" pull --ff-only --quiet || die "Could not update $DEST — run: git -C \"$DEST\" pull"
else
  [ -e "$DEST" ] && die "$DEST already exists and is not Zendo. Remove it or set ZENDO_HOME."
  say "Downloading Zendo to $DEST"
  mkdir -p "$(dirname "$DEST")"
  git clone --quiet "$REPO" "$DEST"
fi

# The personal layer: the folder (the one saved by a previous install is the default)
# and, for a new folder, the repository to clone it from
if [ -z "${ZENDO_USER:-}" ]; then
  previous="$(cat "$DEST/.kit/user" 2>/dev/null || true)"
  ZENDO_USER="$(prompt "Where to keep your personal layer (your themes, mods, settings)" "${previous:-$HOME/.config/zendo}")"
fi
export ZENDO_USER
if [ -z "${ZENDO_USER_REPO:-}" ] && [ ! -d "$ZENDO_USER/.git" ]; then
  ZENDO_USER_REPO="$(prompt "Repository with your personal layer, e.g. from another device (Enter — start a new one)" "")"
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

# Your personal layer from its own repository (another device)
if [ -n "${ZENDO_USER_REPO:-}" ]; then
  if [ -d "$ZENDO_USER/.git" ]; then
    warn "$ZENDO_USER is already a git repository — kept as is (update it with bin/personal pull)"
  elif [ -n "$(ls -A "$ZENDO_USER" 2>/dev/null)" ]; then
    die "$ZENDO_USER already exists — move it away so your personal layer can be cloned there"
  else
    say "Downloading your personal layer to $ZENDO_USER"
    git clone --quiet "$ZENDO_USER_REPO" "$ZENDO_USER" ||
      die "Could not clone $ZENDO_USER_REPO (a private repository needs git access: gh auth login, or an SSH key)"
  fi
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
