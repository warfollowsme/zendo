# shellcheck shell=bash
# Общие функции для скриптов в bin/. Подключается через `source`.
# Пишем под bash 3.2 — это версия, которая стоит в macOS по умолчанию:
# без ассоциативных массивов, mapfile и ${var,,}.

set -euo pipefail

KIT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
KIT_PROFILE_SRC="$KIT_ROOT/profile"
KIT_CHROME_SRC="$KIT_PROFILE_SRC/chrome"
KIT_KIT_DIR="$KIT_CHROME_SRC/kit"
KIT_STATE="$KIT_ROOT/.kit"          # локальное состояние, не в git
KIT_ZEN_SOURCE="$KIT_ROOT/zen-source"

# Личный слой: свои темы, моды, стили сайтов, скрипты, настройки и выбор
# темы и модов. База (этот репозиторий) обновляется bin/update, личный слой
# обновления не трогают. Путь запоминается при bin/install.
if [ -z "${ZENDO_USER:-}" ] && [ -f "$KIT_STATE/user" ]; then
  ZENDO_USER="$(cat "$KIT_STATE/user")"
fi
ZENDO_USER="${ZENDO_USER:-$HOME/.config/zendo}"
KIT_SKEL="$KIT_ROOT/defaults/user"   # заготовка личного слоя

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

# Папки, где Zen держит профили (profiles.ini, installs.ini).
zen_data_dirs() {
  if is_macos; then
    printf '%s\n' "$HOME/Library/Application Support/zen"
  else
    printf '%s\n' "$HOME/.zen" \
      "$HOME/.var/app/app.zen_browser.zen/.zen" \
      "$HOME/.config/zen"
  fi
}

# Значение ключа из первой подходящей секции ini-файла.
# ini_get FILE SECTION_REGEX KEY
ini_get() {
  awk -v sec="$2" -v key="$3" '
    /^\[/ { insec = ($0 ~ sec) ; next }
    insec && index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }
  ' "$1"
}

# Профиль, к которому подключён проект.
# Порядок: ZEN_PROFILE → сохранённый при установке → тот, что открывает Zen.
detect_profile() {
  if [ -n "${ZEN_PROFILE:-}" ]; then
    printf '%s\n' "$ZEN_PROFILE"; return 0
  fi
  if [ -f "$KIT_STATE/profile" ]; then
    cat "$KIT_STATE/profile"; return 0
  fi
  active_profile
}

# Профиль, который Zen открывает при запуске: installs.ini → profiles.ini.
# Может отличаться от сохранённого, если Zen переключился на другой профиль
# (например, после переустановки появился «Default (release)»).
active_profile() {
  if [ -n "${ZEN_PROFILE:-}" ]; then
    printf '%s\n' "$ZEN_PROFILE"; return 0
  fi
  local dir rel
  while IFS= read -r dir; do
    [ -d "$dir" ] || continue
    if [ -f "$dir/installs.ini" ]; then
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

# Папка с программой Zen, куда кладутся файлы fx-autoconfig.
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
    local bin
    bin="$(command -v zen 2>/dev/null || true)"
    if [ -n "$bin" ]; then
      while [ -L "$bin" ]; do
        local target; target="$(readlink "$bin")"
        case "$target" in /*) bin="$target" ;; *) bin="$(dirname "$bin")/$target" ;; esac
      done
      printf '%s\n' "$(cd "$(dirname "$bin")" && pwd -P)"; return 0
    fi
    [ -d /opt/zen ] && { printf '%s\n' /opt/zen; return 0; }
  fi
  return 1
}

# Версия установленного Zen (если удаётся узнать).
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
    pgrep -x zen >/dev/null 2>&1 || pgrep -x zen-bin >/dev/null 2>&1
  fi
}

# Папка startupCache профиля (её чистят после изменений JS).
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

# Читаемое имя из заголовка css-файла (@name ...).
css_meta() {
  sed -n "s/^ *\* *@$2 *\(.*\)$/\1/p" "$1" | head -n 1
}

# Имена css-файлов вида (themes, mods, sites) из базы и личного слоя.
kit_names() {
  local f
  for f in "$KIT_KIT_DIR/$1"/*.css "$ZENDO_USER/$1"/*.css; do
    [ -e "$f" ] || continue
    case "$(basename "$f")" in ._*) continue ;; esac
    basename "$f" .css
  done | sort -u
}

# Путь к css-файлу вида: личный заменяет одноимённый базовый.
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

# Пишет ли в профиль этот проект: ссылка на базу или личный слой, папка из
# одних таких ссылок или user.js, собранный bin/sync. Остальное — чужое,
# bin/install убирает его в бэкап.
SYNC_MARK="// Сгенерировано bin/sync"
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
