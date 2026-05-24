#!/usr/bin/env bash
# scripts/setup.sh — interactive, idempotent first-time setup for
# digestseo-mcp on Cloudflare Workers.
#
# Re-running this script is safe: every step checks whether it's already
# done and skips if so. Engine API keys can be added later by re-running
# and leaving previously-set ones blank.
#
# Reads/writes:
#   - wrangler.jsonc          (created from wrangler.example.jsonc)
#   - .dev.vars               (created from .dev.vars.example)
# Talks to:
#   - wrangler CLI            (must be installed and logged in)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

WRANGLER_JSONC="${REPO_ROOT}/wrangler.jsonc"
WRANGLER_EXAMPLE="${REPO_ROOT}/wrangler.example.jsonc"
DEV_VARS="${REPO_ROOT}/.dev.vars"
DEV_VARS_EXAMPLE="${REPO_ROOT}/.dev.vars.example"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }

confirm() {
  local prompt="$1"
  local reply
  read -r -p "${prompt} [y/N] " reply
  case "${reply}" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

prompt_value() {
  # Usage: prompt_value VAR_NAME "Display label"
  # Reads a value silently (no echo) from the user. Empty input is
  # treated as "skip this".
  local var_name="$1"
  local label="$2"
  local val
  printf '  %s (blank to skip): ' "${label}" >&2
  read -r -s val
  printf '\n' >&2
  printf '%s' "${val}"
}

run_wrangler() {
  # Prefer the locally-installed wrangler. Fall back to npx so a global
  # install is not required.
  if command -v wrangler >/dev/null 2>&1; then
    wrangler "$@"
  else
    npx --yes wrangler "$@"
  fi
}

# Cross-platform in-place sed. GNU sed (Linux) accepts -i with no arg;
# BSD sed (macOS) needs -i '' for no backup.
sed_inplace() {
  local pattern="$1"
  local file="$2"
  if sed --version >/dev/null 2>&1; then
    sed -i -e "${pattern}" "${file}"
  else
    sed -i '' -e "${pattern}" "${file}"
  fi
}

# Escape a string for safe use on the right side of a sed s/// pattern.
sed_escape() {
  printf '%s' "$1" | sed -e 's/[\/&]/\\&/g'
}

bold "==> digestseo-mcp setup"
echo "Repo root: ${REPO_ROOT}"
echo

# ---------------------------------------------------------------------
# 1. wrangler available?
# ---------------------------------------------------------------------
bold "==> Checking for wrangler"
if ! command -v wrangler >/dev/null 2>&1 && ! command -v npx >/dev/null 2>&1; then
  red "Neither 'wrangler' nor 'npx' is on PATH."
  red "Install Node 18+ (which ships with npx), or install wrangler globally:"
  red "  npm install -g wrangler"
  exit 1
fi
if ! command -v wrangler >/dev/null 2>&1; then
  yellow "wrangler not installed globally — will use 'npx wrangler' instead."
  if confirm "Install wrangler globally now? (npm install -g wrangler)"; then
    npm install -g wrangler
  fi
fi
green "OK"
echo

# ---------------------------------------------------------------------
# 2. wrangler whoami
# ---------------------------------------------------------------------
bold "==> Checking wrangler login"
if ! run_wrangler whoami >/dev/null 2>&1; then
  yellow "Not logged in to wrangler. Opening browser…"
  run_wrangler login
fi
green "OK ($(run_wrangler whoami 2>/dev/null | head -1))"
echo

# ---------------------------------------------------------------------
# 3. wrangler.jsonc + .dev.vars from templates
# ---------------------------------------------------------------------
bold "==> Bootstrapping config files"
if [[ ! -f "${WRANGLER_JSONC}" ]]; then
  if [[ ! -f "${WRANGLER_EXAMPLE}" ]]; then
    red "wrangler.example.jsonc is missing — cannot bootstrap wrangler.jsonc."
    exit 1
  fi
  cp "${WRANGLER_EXAMPLE}" "${WRANGLER_JSONC}"
  green "Created wrangler.jsonc from template."
else
  echo "wrangler.jsonc already exists — leaving it alone."
fi

if [[ ! -f "${DEV_VARS}" ]]; then
  if [[ -f "${DEV_VARS_EXAMPLE}" ]]; then
    cp "${DEV_VARS_EXAMPLE}" "${DEV_VARS}"
    green "Created .dev.vars from template."
  fi
else
  echo ".dev.vars already exists — leaving it alone."
fi
echo

# ---------------------------------------------------------------------
# 4. KV namespaces (OAUTH_KV, RATE_LIMIT)
# ---------------------------------------------------------------------
bold "==> Creating KV namespaces"

create_kv_if_placeholder() {
  local binding="$1"
  local placeholder="$2"
  if ! grep -q "${placeholder}" "${WRANGLER_JSONC}"; then
    echo "KV ${binding}: already has an id — skipping create."
    return 0
  fi
  echo "Creating KV namespace ${binding}…"
  local output
  output="$(run_wrangler kv namespace create "${binding}" 2>&1 || true)"
  local id
  id="$(printf '%s\n' "${output}" | grep -oE '"id":\s*"[a-f0-9]+"' | head -1 | grep -oE '[a-f0-9]{20,}')"
  if [[ -z "${id}" ]]; then
    red "Could not parse a KV id from wrangler output:"
    red "${output}"
    return 1
  fi
  sed_inplace "s/${placeholder}/$(sed_escape "${id}")/g" "${WRANGLER_JSONC}"
  green "  → ${binding} id: ${id}"
}

create_kv_if_placeholder OAUTH_KV   YOUR_OAUTH_KV_ID
create_kv_if_placeholder RATE_LIMIT YOUR_RATE_LIMIT_KV_ID
echo

# ---------------------------------------------------------------------
# 5. D1 database (digestseo-db)
# ---------------------------------------------------------------------
bold "==> Creating D1 database"
if ! grep -q "YOUR_D1_DATABASE_ID" "${WRANGLER_JSONC}"; then
  echo "D1 database id already set — skipping create."
else
  echo "Creating D1 database 'digestseo-db'…"
  d1_output="$(run_wrangler d1 create digestseo-db 2>&1 || true)"
  d1_id="$(printf '%s\n' "${d1_output}" | grep -oE '"database_id":\s*"[^"]+"' | head -1 | grep -oE '[a-f0-9-]{30,}')"
  if [[ -z "${d1_id}" ]]; then
    d1_id="$(printf '%s\n' "${d1_output}" | grep -oE 'database_id\s*=\s*"[^"]+"' | head -1 | grep -oE '[a-f0-9-]{30,}')"
  fi
  if [[ -z "${d1_id}" ]]; then
    red "Could not parse a D1 database_id from wrangler output:"
    red "${d1_output}"
    exit 1
  fi
  sed_inplace "s/YOUR_D1_DATABASE_ID/$(sed_escape "${d1_id}")/g" "${WRANGLER_JSONC}"
  green "  → digestseo-db database_id: ${d1_id}"
fi
echo

# ---------------------------------------------------------------------
# 6. Secrets — engine API keys + SEED_SECRET
# ---------------------------------------------------------------------
bold "==> Configuring secrets"
echo "Each engine is opt-in. Leave any prompt blank to skip that engine."
echo "Values are written to .dev.vars (for 'wrangler dev') AND installed"
echo "as encrypted Worker secrets (for production)."
echo

set_secret_pair() {
  # Usage: set_secret_pair VAR_NAME "Display label"
  local var_name="$1"
  local label="$2"
  local val
  val="$(prompt_value "${var_name}" "${label}")"
  if [[ -z "${val}" ]]; then
    echo "  ${var_name}: skipped"
    return 0
  fi
  # Write into .dev.vars (overwrite previous line if present).
  if [[ -f "${DEV_VARS}" ]]; then
    if grep -q "^${var_name}=" "${DEV_VARS}"; then
      sed_inplace "s|^${var_name}=.*|${var_name}=$(sed_escape "${val}")|" "${DEV_VARS}"
    else
      printf '%s=%s\n' "${var_name}" "${val}" >> "${DEV_VARS}"
    fi
  else
    printf '%s=%s\n' "${var_name}" "${val}" > "${DEV_VARS}"
  fi
  # Install as a Worker secret.
  printf '%s' "${val}" | run_wrangler secret put "${var_name}" >/dev/null
  green "  ${var_name}: stored (.dev.vars + Worker secret)"
}

set_secret_pair OPENAI_API_KEY        "OpenAI API key (ChatGPT engine)"
set_secret_pair ANTHROPIC_API_KEY     "Anthropic API key (Claude engine + prompt gen)"
set_secret_pair GEMINI_API_KEY        "Google Gemini API key"
set_secret_pair PERPLEXITY_API_KEY    "Perplexity API key"
set_secret_pair SERPAPI_API_KEY       "SerpAPI key (Google AI Overviews)"
echo
echo "SEED_SECRET is required — it gates the /admin/* routes."
set_secret_pair SEED_SECRET           "SEED_SECRET (pick any high-entropy string)"
echo

# ---------------------------------------------------------------------
# 7. Apply migrations to remote D1
# ---------------------------------------------------------------------
bold "==> Applying D1 migrations (remote)"
if confirm "Apply migrations now to remote D1?"; then
  run_wrangler d1 migrations apply digestseo-db --remote || {
    yellow "migrations apply failed — falling back to direct file execution."
    for f in migrations/*.sql; do
      echo "  → ${f}"
      run_wrangler d1 execute digestseo-db --remote --file="${f}" || true
    done
  }
fi
echo

# ---------------------------------------------------------------------
# 8. Next steps
# ---------------------------------------------------------------------
bold "==> Done"
echo
echo "Next steps:"
echo "  1. Deploy the Worker:"
echo "       npx wrangler deploy"
echo
echo "  2. Note the URL it prints. It looks like:"
echo "       https://digestseo-mcp.<your-subdomain>.workers.dev"
echo
echo "  3. Smoke-test:"
echo "       curl https://<your-url>/healthz"
echo "       # → ok"
echo
echo "  4. Seed your first brand:"
echo "       curl -X POST https://<your-url>/admin/seed \\"
echo "         -H 'X-Seed-Secret: <SEED_SECRET>' \\"
echo "         -H 'Content-Type: application/json' \\"
echo "         -d '{\"brand_id\":\"acme\",\"name\":\"Acme\",\"domain\":\"acme.com\",\"category\":\"...\",\"competitors\":[\"asana.com\"]}'"
echo
echo "  5. Connect in Claude.ai: Settings → Connectors → Add custom connector,"
echo "     paste:  https://<your-url>/mcp"
echo
green "See README.md and SETUP.md for the full reference."
