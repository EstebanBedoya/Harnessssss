#!/usr/bin/env bash
# Instala harness-core en esta máquina (una vez). Idempotente. Uso: bash install.sh [--uninstall]
set -euo pipefail
CORE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SKILL_LINK="${HARNESS_SKILLS_DIR:-$HOME/.claude/skills}/harness"
BIN_LINK="${HARNESS_BIN_DIR:-$HOME/.local/bin}/harness"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

link() { # link <destino-real> <enlace>
  local target="$1" link="$2"
  mkdir -p "$(dirname "$link")"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then say "ok      $link (ya enlazado)"; return; fi
  if [ -e "$link" ] || [ -L "$link" ]; then die "$link ya existe y apunta a otra cosa; muévelo y vuelve a correr"; fi
  ln -s "$target" "$link"; say "enlazado $link -> $target"
}
unlink_ours() {
  local target="$1" link="$2"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then rm "$link"; say "quitado $link"; else say "omitido $link (no es nuestro)"; fi
}

if [ "${1:-}" = "--uninstall" ]; then
  unlink_ours "$CORE/skill" "$SKILL_LINK"; unlink_ours "$CORE/bin/harness.mjs" "$BIN_LINK"
  say "listo. node_modules y .harness de cada proyecto no se tocaron."; exit 0
fi

command -v node >/dev/null || die "falta node (>= 20)"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "node >= 20 requerido (tienes $(node -v))"
command -v pnpm >/dev/null || die "falta pnpm (brew install pnpm)"

say "== dependencias (pnpm)"
(cd "$CORE" && pnpm install --frozen-lockfile)
chmod +x "$CORE/bin/harness.mjs"

say "== enlaces"
link "$CORE/skill" "$SKILL_LINK"          # comando /harness en Claude Code
link "$CORE/bin/harness.mjs" "$BIN_LINK"  # comando harness en la terminal
case ":$PATH:" in *":$(dirname "$BIN_LINK"):"*) ;; *) say "aviso: $(dirname "$BIN_LINK") no está en tu PATH";; esac

say "== comprobación"
"$BIN_LINK" doctor >/dev/null && say "ok      harness doctor"
say "listo. En un proyecto: /harness init   (o: harness init)"
