#!/bin/bash

# Downloads node distibutions and places them in 
# build/node-assets, which is picked up 
# by src/scripts/copy-node-assets.ts, to produce the final bundle.

set -eo pipefail
# Node.js major line to bundle. .github/workflows/bump-bundled-node.yml opens a draft pull request
# when Node.js publishes a newer release of this line.
# shellcheck disable=SC2034 # read by update-node-version.sh
NODE_VERSION="24"
# Exact version to bundle, pinned for reproducible builds.
NODE_SEMVER="24.22.2"
BASE_URL="https://nodejs.org/download/release/v$NODE_SEMVER"
SHASUMS_FILE="SHASUMS256.txt"
ASSETS_DIR="build/node-assets"

# Prints the SHA-256 of a file. macOS has shasum instead of sha256sum.
sha256_of() {
    if command -v sha256sum > /dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

# Download SHASUMS256.txt, and remove it when the script exits, including on failure.
trap 'rm -f "$SHASUMS_FILE"' EXIT
curl -fsSL "$BASE_URL/$SHASUMS_FILE" -o "$SHASUMS_FILE"

# Extract exact Node.js version from any entry in SHASUMS256.txt
# NODE_SEMVER=$(grep -o 'node-v[0-9]*\.[0-9]*\.[0-9]*' SHASUMS256.txt | head -1 | cut -d'v' -f2)

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

# Download each expected file and verify it against SHASUMS256.txt.
# A missing entry fails the build: a release without every platform cannot be bundled.
for actual_file in "${EXPECTED_FILES[@]}"; do
    expected_sum=$(awk -v name="$actual_file" '$2 == name {print $1}' "$SHASUMS_FILE")
    if [ -z "$expected_sum" ]; then
        echo "Error: $actual_file not found in $SHASUMS_FILE" >&2
        exit 1
    fi

    filepath="$ASSETS_DIR/$actual_file"
    echo "Found $actual_file with shasum: $expected_sum"

    echo "Updating $actual_file"
    mkdir -p "$(dirname "$filepath")"
    curl -fsSL "$BASE_URL/$actual_file" -o "$filepath"

    actual_sum=$(sha256_of "$filepath")
    if [ "$actual_sum" != "$expected_sum" ]; then
        echo "Error: SHA-256 mismatch for $actual_file (expected $expected_sum, got $actual_sum)" >&2
        exit 1
    fi
done

# Fetch and escape the license text
LICENSE_URL="https://raw.githubusercontent.com/nodejs/node/v${NODE_SEMVER}/LICENSE"
LICENSE_FILE="$ASSETS_DIR/LICENSE"

echo "Fetching Node.js license from $LICENSE_URL"
curl -fsSL "$LICENSE_URL" -o "$LICENSE_FILE"

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
