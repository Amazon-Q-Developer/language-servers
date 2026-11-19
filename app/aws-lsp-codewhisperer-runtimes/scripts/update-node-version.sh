#!/bin/bash

# Checks nodejs.org for a newer release of the Node.js line pinned in download-node.sh.
# If one exists, rewrites NODE_SEMVER in that script. Used by .github/workflows/bump-bundled-node.yml.
# Prints current, latest, updated and security_versions, and appends them to $GITHUB_OUTPUT when set.

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOWNLOAD_SCRIPT="$SCRIPT_DIR/download-node.sh"
# Overridable for local testing, for example with a file:// URL.
NODE_INDEX_URL="${NODE_INDEX_URL:-https://nodejs.org/dist/index.json}"

major=$(sed -n -E 's/^NODE_VERSION="([0-9]+)"$/\1/p' "$DOWNLOAD_SCRIPT")
current=$(sed -n -E 's/^NODE_SEMVER="([0-9]+\.[0-9]+\.[0-9]+)"$/\1/p' "$DOWNLOAD_SCRIPT")

# Each pattern must match exactly one line, so a multi-line result fails these checks.
if ! [[ "$major" =~ ^[0-9]+$ ]] || ! [[ "$current" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: expected one NODE_VERSION line and one NODE_SEMVER line in $DOWNLOAD_SCRIPT" >&2
    exit 1
fi
if [ "${current%%.*}" != "$major" ]; then
    echo "Error: NODE_SEMVER $current is not on the NODE_VERSION $major line" >&2
    exit 1
fi

# Treat the index as untrusted input: only plain x.y.z versions on the pinned major line count.
# \A and \z anchor the whole string: in jq, $ also matches before a trailing newline.
result=$(curl -fsSL "$NODE_INDEX_URL" | jq -r --arg current "$current" --argjson major "$major" '
    def semver: split(".") | map(tonumber);
    if type != "array" then error("the index is not a JSON array") else . end
    | ($current | semver) as $cur
    | [ .[]
        | select((.version | type) == "string"
            and (.version | test("\\Av(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\z")))
        | (.version | ltrimstr("v")) as $version
        | { version: $version, key: ($version | semver), security: (.security == true) }
        | select(.key[0] == $major) ]
    | max_by(.key) as $latest
    | if $latest == null then error("no \($major).x releases in the index") else . end
    | [ .[] | select(.key > $cur and .key <= $latest.key and .security) ] as $security
    | "\($latest.version) \($latest.key > $cur) \($security | sort_by(.key) | map(.version) | join(" "))"
')

read -r latest newer security_versions <<< "$result"
if ! [[ "$latest" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: unexpected latest version '$latest'" >&2
    exit 1
fi

updated=false
if [ "$newer" = "true" ]; then
    tmp_file=$(mktemp)
    trap 'rm -f "$tmp_file"' EXIT
    sed -E "s/^NODE_SEMVER=\"${current//./\\.}\"$/NODE_SEMVER=\"$latest\"/" "$DOWNLOAD_SCRIPT" > "$tmp_file"
    if [ "$(grep -c "^NODE_SEMVER=\"$latest\"$" "$tmp_file")" -ne 1 ]; then
        echo "Error: failed to update NODE_SEMVER in $DOWNLOAD_SCRIPT" >&2
        exit 1
    fi
    # Overwrite in place so the script keeps its executable mode.
    cat "$tmp_file" > "$DOWNLOAD_SCRIPT"
    updated=true
fi

{
    echo "current=$current"
    echo "latest=$latest"
    echo "updated=$updated"
    echo "security_versions=$security_versions"
} | tee -a "${GITHUB_OUTPUT:-/dev/null}"
