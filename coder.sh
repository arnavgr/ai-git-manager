#!/bin/bash
# =============================================================================
#  coder.sh — Headless Gemini coding agent for CI/CD pipelines
#
#  Lives in the private manager repo alongside agent.yml and gemini.md.
#  Called directly by agent.yml after checkout — no curl, no external deps.
#
#  Required secret (GH Actions):
#    GEMINI_API_KEY
#
#  Optional secrets (for KV status logging on your CloudPhone):
#    CF_ACCOUNT_ID
#    CF_API_TOKEN
#    KV_NAMESPACE_ID
# =============================================================================

VERSION="0.1.0"

# --- Config ------------------------------------------------------------------
MODEL="gemini-3.1-flash-lite-preview"
MAX_FILE_SIZE_KB=100   # skip individual files larger than this
MAX_TOTAL_KB=400       # stop slurping once codebase exceeds this

# Extensions to include when reading the target repo
INCLUDE_EXTS="js|ts|jsx|tsx|py|sh|bash|rb|go|rs|c|cpp|h|java|php|css|html|json|yaml|yml|toml|md|txt|env\.example"

# Paths to always skip
SKIP_PATTERNS="node_modules|\.git|\.next|dist|build|__pycache__|\.pyc|package-lock\.json|yarn\.lock|pnpm-lock"

# --- Runtime state -----------------------------------------------------------
REPO_PATH="."
PROMPT=""
DRY_RUN=false
OUTPUT_MODE="bash"   # bash | patch
RULES_FILE=""

# =============================================================================
#  HELPERS
# =============================================================================
log() { echo "[coder] $*" >&2; }
die() { echo "[coder] FATAL: $*" >&2; exit 1; }

# =============================================================================
#  KV STATUS LOGGING
#  Posts progress to Cloudflare KV so you can poll it from your CloudPhone.
#  Silently skips if CF secrets are not set — agent still works without KV.
# =============================================================================
log_status() {
    local msg="$1"
    log "Status: $msg"

    [ -z "$CF_ACCOUNT_ID" ]   && return
    [ -z "$CF_API_TOKEN" ]    && return
    [ -z "$KV_NAMESPACE_ID" ] && return

    curl -s -X PUT \
        "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/agent_status" \
        -H "Authorization: Bearer ${CF_API_TOKEN}" \
        -H "Content-Type: text/plain" \
        -d "$msg" > /dev/null 2>&1 || true
}

# =============================================================================
#  DEPENDENCY CHECK
# =============================================================================
check_deps() {
    local missing=()
    for cmd in curl jq find du; do
        command -v "$cmd" &>/dev/null || missing+=("$cmd")
    done
    [ ${#missing[@]} -gt 0 ] && die "Missing required tools: ${missing[*]}"
}

# =============================================================================
#  API KEY — GH Actions secret only, no file fallback
# =============================================================================
load_api_key() {
    [ -z "$GEMINI_API_KEY" ] && die "GEMINI_API_KEY secret is not set in this repo's settings"
    API_KEY="$GEMINI_API_KEY"
}

# =============================================================================
#  CODEBASE SLURP
#  Reads actual file contents into a single string for the prompt.
#  README is always included first so Gemini has project context.
# =============================================================================
slurp_codebase() {
    log "Scanning $REPO_PATH ..."

    local total_kb=0
    local file_count=0
    local output=""

    # README first — gives Gemini project context before any code
    for readme in README.md readme.md README.txt; do
        local rpath="$REPO_PATH/$readme"
        if [ -f "$rpath" ]; then
            output+="=== FILE: $readme ===\n"
            output+="$(cat "$rpath")\n\n"
            log "  Included: $readme (README)"
            break
        fi
    done

    while IFS= read -r filepath; do
        local relpath="${filepath#$REPO_PATH/}"

        # Skip unwanted paths
        echo "$relpath" | grep -qE "($SKIP_PATTERNS)" && continue

        # Skip non-matching extensions
        echo "$filepath" | grep -qE "\.($INCLUDE_EXTS)$" || continue

        # Skip files that are too large
        local size_kb
        size_kb=$(du -k "$filepath" 2>/dev/null | cut -f1)
        if [ "${size_kb:-0}" -gt "$MAX_FILE_SIZE_KB" ]; then
            log "  Skipped (${size_kb}KB, over limit): $relpath"
            continue
        fi

        total_kb=$(( total_kb + ${size_kb:-0} ))

        if [ "$total_kb" -gt "$MAX_TOTAL_KB" ]; then
            log "  Total size cap (${MAX_TOTAL_KB}KB) reached, stopping slurp"
            break
        fi

        output+="=== FILE: $relpath ===\n"
        output+="$(cat "$filepath")\n\n"
        file_count=$(( file_count + 1 ))

    done < <(find "$REPO_PATH" -type f | sort)

    log "Slurped $file_count files (~${total_kb}KB total)"
    printf '%b' "$output"
}

# =============================================================================
#  PROMPT BUILDER
#  Uses gemini.md as rules when --rules is passed (agent.yml always passes it).
#  Falls back to inline defaults if the file is somehow missing.
# =============================================================================
build_prompt() {
    local codebase="$1"
    local rules=""

    if [ -n "$RULES_FILE" ] && [ -f "$RULES_FILE" ]; then
        rules=$(cat "$RULES_FILE")
        log "Using rules from: $RULES_FILE"
    else
        log "Rules file not found, using inline defaults"
        if [ "$OUTPUT_MODE" = "patch" ]; then
            rules='You are a headless coding agent in a CI/CD pipeline.
OUTPUT FORMAT: unified diff (patch -p1 format) ONLY.
RULES:
1. Output ONLY a valid unified diff. No explanation, no markdown, no bash.
2. If the task is impossible, output exactly: IMPOSSIBLE
3. Diffs must be applicable with: patch -p1 < file.patch
4. Always include correct a/ b/ prefixes and line counts in diff headers.'
        else
            rules='You are a headless coding agent in a CI/CD pipeline.
OUTPUT FORMAT: raw executable bash commands ONLY.
RULES:
1. NO explanations. NO markdown. NO ```bash blocks. Raw text only.
2. Use sed, awk, cat, tee, mv to modify files. Prefer cat > file for full rewrites.
3. All file paths must be relative (e.g. src/index.js not /home/runner/src/index.js).
4. If the task is impossible, output exactly: exit 1
5. End with a newline.'
        fi
    fi

    printf '%s\n\nCODEBASE:\n%s\n\nTASK: %s' "$rules" "$codebase" "$PROMPT"
}

# =============================================================================
#  GEMINI API CALL  (non-streaming — simpler and reliable for CI)
# =============================================================================
call_gemini() {
    local prompt="$1"

    local payload
    payload=$(jq -n --arg p "$prompt" \
        '{contents: [{role: "user", parts: [{text: $p}]}],
          generationConfig: {temperature: 0.2, maxOutputTokens: 8192}}')

    local url="https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}"

    local response
    response=$(curl -s -X POST "$url" \
        -H "Content-Type: application/json" \
        -d "$payload" \
        --max-time 120)

    local api_err
    api_err=$(echo "$response" | jq -r '.error.message // empty' 2>/dev/null)
    if [ -n "$api_err" ]; then
        log_status "❌ FAILED: Gemini API error — $api_err"
        die "Gemini API error: $api_err"
    fi

    local text
    text=$(echo "$response" | jq -r '.candidates[0].content.parts[0].text // empty' 2>/dev/null)

    if [ -z "$text" ]; then
        log "Raw API response: $response"
        log_status "❌ FAILED: Empty response from Gemini"
        die "Empty response from Gemini"
    fi

    printf '%s' "$text"
}

# =============================================================================
#  APPLY CHANGES
# =============================================================================
apply_bash() {
    local script="$1"

    # Strip any accidental markdown fences
    script=$(printf '%s' "$script" | sed '/^```/d')

    if echo "$script" | grep -q "^exit 1$"; then
        log_status "❌ FAILED: Gemini flagged task as impossible"
        die "Gemini flagged the task as impossible"
    fi

    log "--- Generated Script ---"
    printf '%s\n' "$script" >&2
    log "------------------------"

    if [ "$DRY_RUN" = true ]; then
        log "DRY RUN — script logged above, not executed"
        return
    fi

    cd "$REPO_PATH" || die "Cannot cd to $REPO_PATH"
    printf '%s' "$script" > /tmp/coder_execute.sh
    bash /tmp/coder_execute.sh
    local exit_code=$?
    rm -f /tmp/coder_execute.sh

    if [ $exit_code -ne 0 ]; then
        log_status "❌ FAILED: Generated script exited with code $exit_code"
        die "Script exited with code $exit_code"
    fi
}

apply_patch() {
    local patch_content="$1"

    patch_content=$(printf '%s' "$patch_content" | sed '/^```/d')

    if echo "$patch_content" | grep -q "^IMPOSSIBLE$"; then
        log_status "❌ FAILED: Gemini flagged task as impossible"
        die "Gemini flagged the task as impossible"
    fi

    if ! echo "$patch_content" | grep -q "^---"; then
        log "Gemini output was not a valid patch:"
        printf '%s\n' "$patch_content" >&2
        log_status "❌ FAILED: Gemini did not return a valid patch"
        die "Invalid patch output — try --mode bash or rephrase the task"
    fi

    log "--- Generated Patch ---"
    printf '%s\n' "$patch_content" >&2
    log "-----------------------"

    if [ "$DRY_RUN" = true ]; then
        log "DRY RUN — patch logged above, not applied"
        return
    fi

    cd "$REPO_PATH" || die "Cannot cd to $REPO_PATH"
    printf '%s' "$patch_content" | patch -p1
    local exit_code=$?

    if [ $exit_code -ne 0 ]; then
        log_status "❌ FAILED: patch command failed with code $exit_code"
        die "patch failed with exit code $exit_code"
    fi
}

# =============================================================================
#  HELP
# =============================================================================
show_help() {
    cat <<EOF
coder.sh v${VERSION} — Headless Gemini coding agent

USAGE
  bash coder.sh --prompt "your task" [flags]

FLAGS
  --prompt <text>       Task for the agent (required)
  --repo-path <dir>     Path to the repo to modify (default: .)
  --mode <bash|patch>   Output mode: bash commands or unified diff (default: bash)
  --rules <file>        Path to rules/system prompt file (default: inline)
  --dry-run             Log generated changes without applying them
  --model <name>        Override the Gemini model (default: $MODEL)
  --help                Show this help

REQUIRED SECRET (set in this repo's GH Actions settings)
  GEMINI_API_KEY

OPTIONAL SECRETS (for KV status logging)
  CF_ACCOUNT_ID
  CF_API_TOKEN
  KV_NAMESPACE_ID
EOF
}

# =============================================================================
#  ENTRY POINT
# =============================================================================
check_deps

while [[ $# -gt 0 ]]; do
    case "$1" in
        --prompt)    PROMPT="$2";      shift 2 ;;
        --repo-path) REPO_PATH="$2";   shift 2 ;;
        --mode)      OUTPUT_MODE="$2"; shift 2 ;;
        --rules)     RULES_FILE="$2";  shift 2 ;;
        --dry-run)   DRY_RUN=true;     shift   ;;
        --model)     MODEL="$2";       shift 2 ;;
        --help|-h)   show_help;        exit 0  ;;
        *) die "Unknown flag: $1 (try --help)" ;;
    esac
done

[ -z "$PROMPT" ]      && die "No --prompt given. Try --help."
[ ! -d "$REPO_PATH" ] && die "Repo path not found: $REPO_PATH"

load_api_key

# --- Pipeline ----------------------------------------------------------------

log_status "⏳ READING: Scanning codebase..."
CODEBASE=$(slurp_codebase)

log_status "🧠 THINKING: Gemini (${MODEL}) is working..."
FULL_PROMPT=$(build_prompt "$CODEBASE")
RESULT=$(call_gemini "$FULL_PROMPT")

log_status "🛠️ EXECUTING: Applying ${OUTPUT_MODE} changes..."
if [ "$OUTPUT_MODE" = "patch" ]; then
    apply_patch "$RESULT"
else
    apply_bash "$RESULT"
fi

if [ "$DRY_RUN" = true ]; then
    log_status "👁️ DRY RUN complete — no files modified"
else
    log_status "✅ SUCCESS: Changes applied. Waiting for commit..."
fi

log "Done."
