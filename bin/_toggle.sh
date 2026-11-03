# shellcheck shell=bash
# Общая логика для bin/mod и bin/site: включение и выключение css-файлов.
# Перед подключением задать:
#   TOGGLE_KIND   — папка внутри kit/ (mods или sites)
#   TOGGLE_CMD    — имя команды для подсказок (mod или site)
#   TOGGLE_TITLE  — заголовок списка

# Файлы — в базе (kit/<вид>) и личном слое ($ZENDO_USER/<вид>), выбор —
# в $ZENDO_USER/current/<вид>.css. Пути в нём — от папки kit/ профиля, где
# bin/sync собирает оба слоя вместе.
TOGGLE_INDEX="$ZENDO_USER/current/$TOGGLE_KIND.css"

toggle_enabled() {
  [ -f "$TOGGLE_INDEX" ] || return 0
  sed -n "s|^@import url(\"$TOGGLE_KIND/\(.*\)\.css\");$|\1|p" "$TOGGLE_INDEX"
}

toggle_all() {
  kit_names "$TOGGLE_KIND"
}

toggle_write() {
  # $@ — имена включённых, по одному на строку через stdin
  local names tmp
  names="$(sort -u)"
  mkdir -p "$(dirname "$TOGGLE_INDEX")"
  tmp="$TOGGLE_INDEX.tmp.$$"
  {
    printf '/* Сгенерировано bin/%s — руками не правь. */\n' "$TOGGLE_CMD"
    if [ -z "$names" ]; then
      printf '/* Ничего не включено. */\n'
    else
      printf '%s\n' "$names" | while IFS= read -r n; do
        [ -n "$n" ] && printf '@import url("%s/%s.css");\n' "$TOGGLE_KIND" "$n"
      done
    fi
  } > "$tmp"
  mv "$tmp" "$TOGGLE_INDEX"
}

toggle_list() {
  local enabled name file title desc mark any=0
  enabled="$(toggle_enabled)"
  info "${C_BOLD}$TOGGLE_TITLE${C_RESET}"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    any=1
    file="$(kit_file "$TOGGLE_KIND" "$name")"
    title="$(css_meta "$file" name)"
    desc="$(css_meta "$file" description)"
    case "$file" in "$ZENDO_USER"/*) title="$title ${C_DIM}(personal)${C_RESET}" ;; esac
    if printf '%s\n' "$enabled" | grep -qx "$name"; then
      mark="${C_GREEN}●${C_RESET}"
    else
      mark="${C_DIM}○${C_RESET}"
    fi
    printf '  %s %-24s %s\n' "$mark" "$name" "${title:-}"
    [ -n "$desc" ] && printf '    %s%s%s\n' "$C_DIM" "$desc" "$C_RESET"
  done <<EOF
$(toggle_all)
EOF
  [ "$any" = 1 ] || info "  (empty — add .css files to $ZENDO_USER/$TOGGLE_KIND/)"
  # Включённые, но удалённые файлы
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    kit_file "$TOGGLE_KIND" "$name" >/dev/null || warn "$name is enabled, but $TOGGLE_KIND/$name.css is missing — disable it: bin/$TOGGLE_CMD off $name"
  done <<EOF
$enabled
EOF
}

toggle_main() {
  local action="${1:-list}"
  [ $# -gt 0 ] && shift
  case "$action" in
    list|ls) toggle_list ;;
    on|enable)
      [ $# -gt 0 ] || die "Specify a name: bin/$TOGGLE_CMD on <name>"
      local n
      for n in "$@"; do
        n="${n%.css}"
        kit_file "$TOGGLE_KIND" "$n" >/dev/null || die "Not found: $TOGGLE_KIND/$n.css (list: bin/$TOGGLE_CMD)"
      done
      "$KIT_ROOT/bin/sync" --quiet || true # новый личный файл — в профиль
      { toggle_enabled; for n in "$@"; do printf '%s\n' "${n%.css}"; done; } | toggle_write
      ok "Enabled: $*"
      ;;
    off|disable)
      [ $# -gt 0 ] || die "Specify a name: bin/$TOGGLE_CMD off <name>"
      local keep drop
      keep="$(toggle_enabled)"
      for drop in "$@"; do
        keep="$(printf '%s\n' "$keep" | grep -vx "${drop%.css}" || true)"
      done
      printf '%s\n' "$keep" | toggle_write
      ok "Disabled: $*"
      ;;
    -h|--help|help)
      info "bin/$TOGGLE_CMD                  — list, ● enabled"
      info "bin/$TOGGLE_CMD on <name> [...]  — enable"
      info "bin/$TOGGLE_CMD off <name> [...] — disable"
      ;;
    *) die "Unknown command: $action (bin/$TOGGLE_CMD help)" ;;
  esac
}
