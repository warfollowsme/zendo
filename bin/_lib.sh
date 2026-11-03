# shellcheck shell=bash
# Shared functions for the scripts in bin/. Loaded with `source`.
# Written for bash 3.2, the version macOS ships by default:
# no associative arrays, mapfile or ${var,,}.

set -euo pipefail

KIT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
KIT_PROFILE_SRC="$KIT_ROOT/profile"
KIT_CHROME_SRC="$KIT_PROFILE_SRC/chrome"
KIT_KIT_DIR="$KIT_CHROME_SRC/kit"
KIT_STATE="$KIT_ROOT/.kit"          # local state, not in git
KIT_ZEN_SOURCE="$KIT_ROOT/zen-source"

# Personal layer: your own themes, mods, site styles, scripts, prefs and the
# chosen theme and mods. The base (this repo) is updated by bin/update; updates
# never touch the personal layer. Its path is saved by bin/install.
if [ -z "${ZENDO_USER:-}" ] && [ -f "$KIT_STATE/user" ]; then
  ZENDO_USER="$(cat "$KIT_STATE/user")"
fi
ZENDO_USER="${ZENDO_USER:-$HOME/.config/zendo}"
KIT_SKEL="$KIT_ROOT/defaults/user"   # personal layer skeleton

if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_DIM=""; C_BOLD=""; C_RESET=""
fi

info() { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

is_macos() { [ "$(uname -s)" = "Darwin" ]; }

# Folders where Zen keeps its profiles (profiles.ini, installs.ini).
zen_data_dirs() {
  if is_macos; then
    printf '%s\n' "$HOME/Library/Application Support/zen"
  else
    printf '%s\n' "$HOME/.zen" \
      "$HOME/.var/app/app.zen_browser.zen/.zen" \
      "$HOME/.config/zen"
  fi
}

# Value of a key from the first matching section of an ini file.
# ini_get FILE SECTION_REGEX KEY
ini_get() {
  awk -v sec="$2" -v key="$3" '
    /^\[/ { insec = ($0 ~ sec) ; next }
    insec && index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }
  ' "$1"
}

# The profile the project is connected to.
# Order: ZEN_PROFILE → saved at install → the one Zen opens.
detect_profile() {
  if [ -n "${ZEN_PROFILE:-}" ]; then
    printf '%s\n' "$ZEN_PROFILE"; return 0
  fi
  if [ -f "$KIT_STATE/profile" ]; then
    cat "$KIT_STATE/profile"; return 0
  fi
  active_profile
}

# The profile Zen opens on startup: installs.ini → profiles.ini.
# May differ from the saved one if Zen switched to another profile
# (e.g. "Default (release)" appeared after a reinstall). Zen's AppImage starts
# with MOZ_LEGACY_PROFILES=1 and ignores installs.ini: its profile is the one
# marked Default=1 in profiles.ini.
active_profile() {
  if [ -n "${ZEN_PROFILE:-}" ]; then
    printf '%s\n' "$ZEN_PROFILE"; return 0
  fi
  local dir rel
  while IFS= read -r dir; do
    [ -d "$dir" ] || continue
    if [ -f "$dir/installs.ini" ] && [ ! -f "$KIT_STATE/appimage" ]; then
      rel="$(ini_get "$dir/installs.ini" '^[[]' Default)"
      if [ -n "$rel" ] && [ -d "$dir/$rel" ]; then
        printf '%s\n' "$dir/$rel"; return 0
      fi
    fi
    if [ -f "$dir/profiles.ini" ]; then
      rel="$(awk '
        /^\[Profile/ { path=""; def=0; insec=1; next }
        /^\[/ { insec=0; next }
        insec && /^Path=/ { path=substr($0, 6) }
        insec && /^Default=1/ { def=1 }
        insec && def && path != "" { print path; exit }
      ' "$dir/profiles.ini")"
      if [ -n "$rel" ]; then
        case "$rel" in
          /*) [ -d "$rel" ] && { printf '%s\n' "$rel"; return 0; } ;;
          *)  [ -d "$dir/$rel" ] && { printf '%s\n' "$dir/$rel"; return 0; } ;;
        esac
      fi
    fi
  done <<EOF
$(zen_data_dirs)
EOF
  return 1
}

require_active_profile() {
  local p
  p="$(active_profile)" || die "Zen profile not found. Launch Zen at least once or specify the path: ZEN_PROFILE=\"/path/to/profile\" $0"
  [ -d "$p" ] || die "Profile directory not found: $p"
  printf '%s\n' "$p"
}

require_profile() {
  local p
  p="$(detect_profile)" || die "Zen profile not found. Launch Zen at least once or specify the path: ZEN_PROFILE=\"/path/to/profile\" $0"
  [ -d "$p" ] || die "Profile directory not found: $p"
  printf '%s\n' "$p"
}

# Zen's application folder, where the fx-autoconfig files go.
detect_app_resources() {
  if [ -n "${ZEN_APP:-}" ]; then
    if [ -d "$ZEN_APP/Contents/Resources" ]; then
      printf '%s\n' "$ZEN_APP/Contents/Resources"
    else
      printf '%s\n' "$ZEN_APP"
    fi
    return 0
  fi
  if is_macos; then
    local app
    for app in "/Applications/Zen.app" "/Applications/Zen Browser.app" \
               "$HOME/Applications/Zen.app" "$HOME/Applications/Zen Browser.app"; do
      if [ -d "$app/Contents/Resources" ]; then
        printf '%s\n' "$app/Contents/Resources"; return 0
      fi
    done
  else
    # Linux: the unpacked AppImage (see appimage_unpack), the folder with
    # application.ini next to the zen binary in PATH (often a symlink), or a
    # known install location.
    if [ -f "$KIT_STATE/appimage" ] && [ -f "$ZEN_APPIMAGE_DIR/application.ini" ]; then
      printf '%s\n' "$ZEN_APPIMAGE_DIR"; return 0
    fi
    local bin dir
    for bin in "$(command -v zen 2>/dev/null || true)" "$(command -v zen-browser 2>/dev/null || true)"; do
      [ -n "$bin" ] || continue
      while [ -L "$bin" ]; do
        local target; target="$(readlink "$bin")"
        case "$target" in /*) bin="$target" ;; *) bin="$(dirname "$bin")/$target" ;; esac
      done
      dir="$(cd "$(dirname "$bin")" && pwd -P)"
      [ -f "$dir/application.ini" ] && { printf '%s\n' "$dir"; return 0; }
    done
    for dir in /opt/zen /opt/zen-browser /opt/zen-browser-bin \
               "$HOME/.tarball-installations/zen" "$HOME/.local/share/zen" "$HOME/.local/opt/zen"; do
      [ -f "$dir/application.ini" ] && { printf '%s\n' "$dir"; return 0; }
    done
  fi
  return 1
}

# Linux: Zen installed from Flathub. Its application folder is read-only, so
# the script loader can't be installed — only CSS works.
zen_flatpak() {
  ! is_macos && command -v flatpak >/dev/null 2>&1 && flatpak info app.zen_browser.zen >/dev/null 2>&1
}

# ---- Linux: Zen as an AppImage
# An AppImage is read-only, so the script loader can't go into it. Zendo runs an
# unpacked copy instead ($ZEN_APPIMAGE_DIR) and leaves the AppImage as is; when
# the AppImage is replaced (a new Zen), bin/launch unpacks it again.
ZEN_APPIMAGE_DIR="$KIT_STATE/zen-appimage"

# Zen's AppImage: ZEN_APPIMAGE, the one saved at install, or one in a usual place.
find_appimage() {
  local dir f
  if [ -n "${ZEN_APPIMAGE:-}" ]; then
    [ -f "$ZEN_APPIMAGE" ] && { printf '%s\n' "$ZEN_APPIMAGE"; return 0; }
    return 1
  fi
  f="$(cat "$KIT_STATE/appimage" 2>/dev/null || true)"
  [ -n "$f" ] && [ -f "$f" ] && { printf '%s\n' "$f"; return 0; }
  for dir in "$HOME/Applications" "$HOME/AppImages" "$HOME/.local/bin" "$HOME/Downloads" "$HOME/Desktop" /opt; do
    for f in "$dir"/[Zz]en*.[Aa]pp[Ii]mage; do
      [ -f "$f" ] && { printf '%s\n' "$f"; return 0; }
    done
  done
  return 1
}

# Whether the unpacked copy is of this very AppImage (size and modification time).
appimage_current() {
  [ -f "$ZEN_APPIMAGE_DIR/application.ini" ] &&
    [ "$(cat "$ZEN_APPIMAGE_DIR.stamp" 2>/dev/null)" = "$(stat -c '%s %Y' "$1" 2>/dev/null)" ]
}

# Unpack the AppImage into $ZEN_APPIMAGE_DIR (a few seconds, no FUSE needed).
appimage_unpack() {
  local image="$1" tmp="$KIT_STATE/zen-appimage.tmp"
  [ -x "$image" ] || { warn "$image is not executable: chmod +x \"$image\""; return 1; }
  rm -rf "$tmp" && mkdir -p "$tmp"
  if ! (cd "$tmp" && "$image" --appimage-extract >/dev/null 2>&1) || [ ! -f "$tmp/squashfs-root/application.ini" ]; then
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$ZEN_APPIMAGE_DIR"
  # newer AppImage runtimes unpack into AppDir, and squashfs-root is a link to it
  mv "$(cd "$tmp/squashfs-root" && pwd -P)" "$ZEN_APPIMAGE_DIR"
  rm -rf "$tmp"
  stat -c '%s %Y' "$image" > "$ZEN_APPIMAGE_DIR.stamp"
  printf '%s\n' "$image" > "$KIT_STATE/appimage"
}

# Run a program detached from this terminal: right away in its own session
# (setsid -f), so closing the terminal (or the installer's) doesn't take Zen
# with it. Without setsid -f (old util-linux) — nohup.
detach() {
  setsid -f "$@" >/dev/null 2>&1 < /dev/null || { nohup "$@" >/dev/null 2>&1 < /dev/null & }
}

# Start Zen in the background (or bring it forward / open a window if it runs).
start_zen() {
  local res
  if is_macos; then
    res="$(detect_app_resources)" || return 1
    /usr/bin/open -a "$(cd "$res/../.." && pwd -P)"
  elif res="$(detect_app_resources 2>/dev/null)" && [ "$res" = "$ZEN_APPIMAGE_DIR" ]; then
    # as the AppImage itself would: its AppRun, with APPIMAGE for "default browser"
    APPIMAGE="$(cat "$KIT_STATE/appimage")" detach "$res/AppRun"
  elif [ -n "$res" ] && [ -x "$res/zen" ]; then
    detach "$res/zen"
  elif command -v zen-browser >/dev/null 2>&1; then
    detach zen-browser
  elif command -v zen >/dev/null 2>&1; then
    detach zen
  elif zen_flatpak; then
    detach flatpak run app.zen_browser.zen
  else
    return 1
  fi
}

# Version of the installed Zen (if it can be found).
installed_zen_version() {
  local res
  res="$(detect_app_resources 2>/dev/null)" || return 1
  if is_macos && [ -f "$res/../Info.plist" ]; then
    /usr/bin/defaults read "$(cd "$res/.." && pwd -P)/Info" CFBundleShortVersionString 2>/dev/null
  elif [ -f "$res/application.ini" ]; then
    ini_get "$res/application.ini" '^[[]App[]]' Version
  fi
}

zen_source_version() {
  [ -f "$KIT_ZEN_SOURCE/surfer.json" ] || return 1
  sed -n 's/.*"displayVersion": *"\([^"]*\)".*/\1/p' "$KIT_ZEN_SOURCE/surfer.json" | head -n 1
}

zen_running() {
  if is_macos; then
    pgrep -x zen >/dev/null 2>&1 || pgrep -f '/Zen( Browser)?\.app/Contents/MacOS/' >/dev/null 2>&1
  else
    pgrep -x zen >/dev/null 2>&1 || pgrep -x zen-bin >/dev/null 2>&1 || pgrep -x zen-browser >/dev/null 2>&1
  fi
}

# The profile's startupCache folder (cleared after JS changes).
startup_cache_dirs() {
  local profile name
  profile="$1"; name="$(basename "$profile")"
  printf '%s\n' "$profile/startupCache"
  if is_macos; then
    printf '%s\n' "$HOME/Library/Caches/zen/Profiles/$name/startupCache"
  else
    printf '%s\n' "$HOME/.cache/zen/$name/startupCache" \
      "$HOME/.var/app/app.zen_browser.zen/cache/zen/$name/startupCache"
  fi
}

clear_startup_cache() {
  local d cleared=0
  while IFS= read -r d; do
    if [ -d "$d" ]; then
      rm -rf "$d" && cleared=1 && ok "Startup cache cleared: $d"
    fi
  done <<EOF
$(startup_cache_dirs "$1")
EOF
  [ "$cleared" = 1 ] || info "${C_DIM}No startup cache found — nothing to clear.${C_RESET}"
}

# Human-readable name from a css file header (@name ...).
css_meta() {
  sed -n "s/^ *\* *@$2 *\(.*\)$/\1/p" "$1" | head -n 1
}

# Names of css files of a kind (themes, mods, sites) from the base and personal layer.
kit_names() {
  local f
  for f in "$KIT_KIT_DIR/$1"/*.css "$ZENDO_USER/$1"/*.css; do
    [ -e "$f" ] || continue
    case "$(basename "$f")" in ._*) continue ;; esac
    basename "$f" .css
  done | sort -u
}

# Path to a css file of a kind: a personal file replaces a base one of the same name.
# kit_file KIND NAME
kit_file() {
  if [ -f "$ZENDO_USER/$1/$2.css" ]; then
    printf '%s\n' "$ZENDO_USER/$1/$2.css"
  elif [ -f "$KIT_KIT_DIR/$1/$2.css" ]; then
    printf '%s\n' "$KIT_KIT_DIR/$1/$2.css"
  else
    return 1
  fi
}

# Whether this project wrote it to the profile: a link to the base or personal layer,
# a folder of only such links, or a user.js built by bin/sync. Anything else is foreign;
# bin/install moves it to a backup.
SYNC_MARK="// Generated by bin/sync"
is_ours() {
  local p="$1" l
  if [ -L "$p" ]; then
    case "$(readlink "$p")" in
      "$KIT_ROOT"/*|"$ZENDO_USER"|"$ZENDO_USER"/*) return 0 ;;
    esac
    return 1
  fi
  if [ -d "$p" ]; then
    [ -z "$(find "$p" -mindepth 1 ! -type d ! -type l -print 2>/dev/null | head -n 1)" ] || return 1
    while IFS= read -r l; do
      [ -n "$l" ] || continue
      is_ours "$l" || return 1
    done <<EOF
$(find "$p" -mindepth 1 -type l 2>/dev/null)
EOF
    return 0
  fi
  [ -f "$p" ] && head -n 1 "$p" | grep -qF "$SYNC_MARK"
}
