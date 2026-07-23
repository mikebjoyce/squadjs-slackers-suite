#!/usr/bin/env bash
#
# SquadJS Slacker's Suite — Install Script (Bash)
#
# Assembles selected plugins into a deployable `out/` folder matching
# SquadJS's expected `squad-server/` layout.
#
# Usage:
#   ./install.sh --plugin=<name> [--output=<path>] [--with-tools] [--with-testing]
#                [--clean] [--force]
#
#   --plugin     s3 | team-balancer | elo-tracker | smart-assign | switch | all
#                (S3 is always auto-included — every consumer plugin depends on it)
#   --output     Output directory (default: ./out)
#   --with-tools      Also copy tools/ directories
#   --with-testing    Also copy testing/ directories
#   --clean           Wipe output directory before copying (destructive — use with care)
#   --force, -f       Skip overwrite confirmation prompt
#
# Examples:
#   ./install.sh --plugin=s3
#   ./install.sh --plugin=team-balancer
#   ./install.sh --plugin=all --with-tools
#   ./install.sh --plugin=switch,smart-assign --output=../my-squadjs/squad-server --force

set -euo pipefail

# ─── Constants ───────────────────────────────────────────────────────────────

MONOREPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
ALL_PLUGINS=("s3" "team-balancer" "elo-tracker" "smart-assign" "switch")
ALWAYS_DIRS=("plugins" "utils")
OPT_IN_DIRS=("testing" "tools")

# ─── Argument Parsing ────────────────────────────────────────────────────────

PLUGINS_RAW=""
OUTPUT_DIR="$MONOREPO_ROOT/out"
WITH_TOOLS=false
WITH_TESTING=false
CLEAN=false
FORCE=false

print_help() {
  cat <<EOF

SquadJS Slacker's Suite — Install Script

Usage:
  ./install.sh --plugin=<name> [--output=<path>] [--with-tools] [--with-testing]
               [--clean] [--force]

Options:
  --plugin=<name>   Plugin(s) to install: s3, team-balancer, elo-tracker,
                    smart-assign, switch, or all (comma-separated).
                    S3 is always auto-included.
  --output=<path>   Output directory (default: ./out)
  --with-tools      Also copy tools/ directories
  --with-testing    Also copy testing/ directories
  --clean           Wipe output directory before copying.
                    WARNING: This deletes ALL files in the output directory,
                    including non-Slacker files. Only use with a dedicated
                    output directory, NOT a live SquadJS install.
  --force, -f       Skip the overwrite confirmation prompt. Required when
                    the output directory already contains files that would
                    be overwritten.
  --help, -h        Show this help

Examples:
  ./install.sh --plugin=s3
  ./install.sh --plugin=team-balancer
  ./install.sh --plugin=all --with-tools
  ./install.sh --plugin=switch,smart-assign --output=../my-squadjs/squad-server --force
EOF
}

for arg in "$@"; do
  case "$arg" in
    --plugin=*)
      PLUGINS_RAW="${arg#--plugin=}"
      ;;
    --output=*)
      OUTPUT_DIR="${arg#--output=}"
      # Resolve relative paths
      if [[ "$OUTPUT_DIR" != /* ]]; then
        OUTPUT_DIR="$MONOREPO_ROOT/$OUTPUT_DIR"
      fi
      ;;
    --with-tools)
      WITH_TOOLS=true
      ;;
    --with-testing)
      WITH_TESTING=true
      ;;
    --clean)
      CLEAN=true
      ;;
    --force|-f)
      FORCE=true
      ;;
    --help|-h)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg"
      print_help
      exit 1
      ;;
  esac
done

# ─── Validation ──────────────────────────────────────────────────────────────

if [[ -z "$PLUGINS_RAW" ]]; then
  echo "Error: --plugin is required."
  print_help
  exit 1
fi

# Parse comma-separated plugin list
declare -A RESOLVED_PLUGINS
IFS=',' read -ra REQUESTED <<< "$PLUGINS_RAW"

for name in "${REQUESTED[@]}"; do
  name="$(echo "$name" | xargs | tr '[:upper:]' '[:lower:]')"
  if [[ "$name" == "all" ]]; then
    for p in "${ALL_PLUGINS[@]}"; do
      RESOLVED_PLUGINS["$p"]=1
    done
  else
    found=false
    for p in "${ALL_PLUGINS[@]}"; do
      if [[ "$p" == "$name" ]]; then
        RESOLVED_PLUGINS["$p"]=1
        found=true
        break
      fi
    done
    if [[ "$found" == false ]]; then
      echo "Error: Unknown plugin \"$name\". Valid options: ${ALL_PLUGINS[*]}, all"
      exit 1
    fi
  fi
done

# S3 is always included — every consumer plugin depends on it.
RESOLVED_PLUGINS["s3"]=1

# Build sorted plugin list (s3 first, then alphabetical)
PLUGINS=("s3")
for p in "${ALL_PLUGINS[@]}"; do
  if [[ "$p" != "s3" && -n "${RESOLVED_PLUGINS[$p]:-}" ]]; then
    PLUGINS+=("$p")
  fi
done

echo "Plugins selected: ${PLUGINS[*]}"
echo "Output directory: $OUTPUT_DIR"
if [[ "$WITH_TOOLS" == true ]]; then echo "  (including tools/)"; fi
if [[ "$WITH_TESTING" == true ]]; then echo "  (including testing/)"; fi
if [[ "$CLEAN" == true ]]; then echo "  (--clean: will wipe output directory first)"; fi
echo ""

# ─── File Discovery & Collision Detection ────────────────────────────────────

# Build list of directories to copy
DIRS_TO_COPY=("${ALWAYS_DIRS[@]}")
if [[ "$WITH_TOOLS" == true ]]; then DIRS_TO_COPY+=("tools"); fi
if [[ "$WITH_TESTING" == true ]]; then DIRS_TO_COPY+=("testing"); fi

# Temporary file to track collisions
COLLISION_FILE="$(mktemp)"
trap 'rm -f "$COLLISION_FILE"' EXIT

declare -A SEEN_FILES  # relPath → pluginName

for plugin in "${PLUGINS[@]}"; do
  plugin_dir="$MONOREPO_ROOT/$plugin"

  if [[ ! -d "$plugin_dir" ]]; then
    echo "Error: Plugin directory not found: $plugin_dir"
    exit 1
  fi

  for dir_name in "${DIRS_TO_COPY[@]}"; do
    dir_path="$plugin_dir/$dir_name"
    if [[ ! -d "$dir_path" ]]; then
      continue
    fi

    # Find all .js, .mjs, .cjs, .json files, excluding README files
    while IFS= read -r -d '' file_path; do
      # Skip README files
      basename_lower="$(basename "$file_path" | tr '[:upper:]' '[:lower:]')"
      if [[ "$basename_lower" == "readme.md" || "$basename_lower" == "readme.mdx" ]]; then
        continue
      fi

      # Get relative path from plugin root
      rel_path="${file_path#$plugin_dir/}"

      if [[ -n "${SEEN_FILES[$rel_path]:-}" ]]; then
        existing_plugin="${SEEN_FILES[$rel_path]}"
        echo ""
        echo "Collision detected: \"$rel_path\""
        echo "  → $existing_plugin/$rel_path"
        echo "  → $plugin/$rel_path"
        echo ""
        echo "Rename one of the files to resolve the conflict before retrying."
        exit 1
      fi

      SEEN_FILES["$rel_path"]="$plugin"
      echo "$plugin|$file_path|$rel_path" >> "$COLLISION_FILE"
    done < <(find "$dir_path" -type f \( -name "*.js" -o -name "*.mjs" -o -name "*.cjs" -o -name "*.json" \) -print0)
  done
done

# ─── Copy ────────────────────────────────────────────────────────────────────

# Count lines in collision file to check if we have files
file_count=$(wc -l < "$COLLISION_FILE" 2>/dev/null || echo 0)
if [[ "$file_count" -eq 0 ]]; then
  echo "No files to copy."
  exit 0
fi

# --clean mode: wipe the entire output directory first (opt-in destructive)
if [[ "$CLEAN" == true && -d "$OUTPUT_DIR" ]]; then
  echo "--clean specified: removing existing output directory..."
  rm -rf "$OUTPUT_DIR"
fi

# Check for files that would be overwritten (only if not using --clean,
# since --clean already removed everything)
if [[ "$CLEAN" != true ]]; then
  overwrites=()
  while IFS='|' read -r _plugin _source_path rel_path; do
    dest="$OUTPUT_DIR/$rel_path"
    if [[ -f "$dest" ]]; then
      overwrites+=("$rel_path")
    fi
  done < "$COLLISION_FILE"

  if [[ ${#overwrites[@]} -gt 0 ]]; then
    echo "The following ${#overwrites[@]} existing file(s) will be overwritten in ${OUTPUT_DIR}/:"
    for f in "${overwrites[@]}"; do
      echo "  $f"
    done
    echo ""

    if [[ "$FORCE" != true ]]; then
      echo "To proceed, re-run with --force to overwrite these files,"
      echo "or use --clean to wipe the output directory first."
      echo ""
      echo "WARNING: --clean will delete ALL files in the output directory,"
      echo "including non-Slacker files. Do NOT use --clean when pointing at"
      echo "a live SquadJS install."
      exit 1
    fi

    echo "--force specified: proceeding with overwrite..."
    echo ""
  fi
fi

copied=0
while IFS='|' read -r _plugin source_path rel_path; do
  dest="$OUTPUT_DIR/$rel_path"
  mkdir -p "$(dirname "$dest")"
  cp "$source_path" "$dest"
  ((copied++))
done < "$COLLISION_FILE"

echo "Done — $copied files written to $OUTPUT_DIR/"
echo ""
echo "Next steps:"
echo "  1. Copy the contents of $OUTPUT_DIR/ into your SquadJS squad-server/ directory"
echo "  2. Add the plugins to your config.json (S3 must be first in the plugins array)"
echo "  3. Restart SquadJS"