#!/bin/bash

# Downloads node distibutions and places them in 
# build/node-assets, which is picked up 
# by src/scripts/copy-node-assets.ts, to produce the final bundle.

set -eo pipefail
NODE_VERSION="24"
BASE_URL="https://nodejs.org/download/release/v24.9.0"
SHASUMS_FILE="SHASUMS256.txt"
ASSETS_DIR="build/node-assets"

# Remove the checksum list on exit, including failures, so it never lingers in the package folder.
trap 'rm -f "$SHASUMS_FILE"' EXIT

# Pick a SHA-256 tool: sha256sum on Linux/CI and Git Bash, shasum -a 256 on macOS.
if command -v sha256sum >/dev/null 2>&1; then
    sha256_of() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
    sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }
else
    echo "No SHA-256 tool found (need sha256sum or shasum)"
    exit 1
fi

# Download a URL to a path, failing on HTTP errors and removing a partial file.
# Timeouts turn a stalled transfer into a retryable error; redirects stay on HTTPS.
download() {
    local url="$1" dest="$2"
    if ! curl -fsSL --retry 3 \
        --connect-timeout 30 --speed-limit 1024 --speed-time 60 \
        --proto-redir '=https' \
        "$url" -o "$dest"; then
        echo "Failed to download $url"
        rm -f "$dest"
        exit 1
    fi
}

# Download SHASUMS256.txt
download "$BASE_URL/$SHASUMS_FILE" "$SHASUMS_FILE"

# Extract exact Node.js version from any entry in SHASUMS256.txt
# NODE_SEMVER=$(grep -o 'node-v[0-9]*\.[0-9]*\.[0-9]*' SHASUMS256.txt | head -1 | cut -d'v' -f2)

# temporarily lock node.js version to 24.9.0 due to https://github.com/nodejs/node/issues/60176
NODE_SEMVER="24.9.0"

if [ -z "$NODE_SEMVER" ]; then
    echo "Failed to extract Node.js version from SHASUMS256.txt"
    exit 1
fi

echo "Found latest Node.js version: $NODE_SEMVER"

echo "Downloading assets for node version $NODE_SEMVER"

# Remove all files from ASSETS directory
rm -rf "$ASSETS_DIR" && mkdir "$ASSETS_DIR"

# Define expected files
EXPECTED_FILES=(
    "win-x64/node.exe"
    "node-v$NODE_SEMVER-linux-x64.tar.gz"
    "node-v$NODE_SEMVER-darwin-arm64.tar.gz"
    "node-v$NODE_SEMVER-linux-arm64.tar.gz"
    "node-v$NODE_SEMVER-darwin-x64.tar.gz"
)

# Process each expected file
for actual_file in "${EXPECTED_FILES[@]}"; do
    # Look up the expected checksum by exact file name in SHASUMS256.txt
    expected_sum=$(awk -v f="$actual_file" '$2 == f {print $1}' "$SHASUMS_FILE")
    if [ -z "$expected_sum" ]; then
        echo "Error: $actual_file not found in $SHASUMS_FILE"
        exit 1
    fi

    filepath="$ASSETS_DIR/$actual_file"
    echo "Found $actual_file with shasum: $expected_sum"

    echo "Updating $actual_file"
    mkdir -p "$(dirname "$filepath")"
    download "$BASE_URL/$actual_file" "$filepath"

    # Verify the download against its published checksum
    actual_sum=$(sha256_of "$filepath")
    if [ "$actual_sum" != "$expected_sum" ]; then
        echo "Error: checksum mismatch for $actual_file"
        echo "  expected: $expected_sum"
        echo "  actual:   $actual_sum"
        rm -f "$filepath"
        exit 1
    fi
    echo "Verified $actual_file"
done

# Fetch and escape the license text
LICENSE_URL="https://raw.githubusercontent.com/nodejs/node/v${NODE_SEMVER}/LICENSE"
LICENSE_FILE="$ASSETS_DIR/LICENSE"

echo "Fetching Node.js license from $LICENSE_URL"
download "$LICENSE_URL" "$LICENSE_FILE"

# Verify the license file was downloaded successfully
if [ ! -s "$LICENSE_FILE" ]; then
    echo "Downloaded license file is empty"
    rm -f "$LICENSE_FILE"
    exit 1
fi

echo "License file has been updated in $LICENSE_FILE"

# Update the attribution overrides file
ATTRIBUTION_FILE="../../attribution/overrides.json"

# Create attribution file with empty JSON object if it doesn't exist
if [ ! -f "$ATTRIBUTION_FILE" ]; then
    mkdir -p "$(dirname "$ATTRIBUTION_FILE")"
    echo "{}" > "$ATTRIBUTION_FILE"
fi

# Update version and licenseText fields using jq
# jq also escapes text by default
jq --indent 4 \
   --arg name "Node.js" \
   --arg version "$NODE_SEMVER" \
   --rawfile licenseText "$LICENSE_FILE" \
   --arg url "https://github.com/nodejs/node" \
   --arg license "MIT" \
   '.node.name = $name | .node.version = $version | .node.url = $url | .node.license = $license | .node.licenseText = $licenseText' \
   "$ATTRIBUTION_FILE" > "$ATTRIBUTION_FILE.tmp"

mv "$ATTRIBUTION_FILE.tmp" "$ATTRIBUTION_FILE"
echo "Successfully updated Node.js version and license in $ATTRIBUTION_FILE"

# Cleanup
rm -f "$SHASUMS_FILE"
