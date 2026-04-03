#!/usr/bin/env bash
# Koi installer — downloads the appropriate standalone binary for the current
# platform and places it on PATH.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/windoliver/koi/main/scripts/install.sh | bash
#
# Environment variables:
#   KOI_INSTALL_DIR   Override install directory (default: ~/.local/bin or /usr/local/bin)
#   KOI_VERSION       Override version to install (default: latest)

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REPO="windoliver/koi"
VERSION="${KOI_VERSION:-latest}"
BASE_URL="https://github.com/${REPO}/releases"

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

detect_platform() {
  local os arch

  os="$(uname -s)"
  case "${os}" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *)
      echo "Error: unsupported OS: ${os}" >&2
      echo "Koi supports macOS (darwin) and Linux." >&2
      exit 1
      ;;
  esac

  arch="$(uname -m)"
  case "${arch}" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      echo "Error: unsupported architecture: ${arch}" >&2
      echo "Koi supports x64 and arm64." >&2
      exit 1
      ;;
  esac

  echo "${os}-${arch}"
}

# ---------------------------------------------------------------------------
# Install directory
# ---------------------------------------------------------------------------

detect_install_dir() {
  if [ -n "${KOI_INSTALL_DIR:-}" ]; then
    echo "${KOI_INSTALL_DIR}"
    return
  fi

  # Prefer ~/.local/bin if it exists or if /usr/local/bin is not writable
  if [ -d "${HOME}/.local/bin" ] || ! [ -w "/usr/local/bin" ]; then
    echo "${HOME}/.local/bin"
  else
    echo "/usr/local/bin"
  fi
}

# ---------------------------------------------------------------------------
# Download URL
# ---------------------------------------------------------------------------

resolve_download_url() {
  local platform="$1"
  local binary_name="koi-${platform}"

  if [ "${VERSION}" = "latest" ]; then
    echo "${BASE_URL}/latest/download/${binary_name}"
  else
    echo "${BASE_URL}/download/${VERSION}/${binary_name}"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  local platform install_dir download_url target_path

  echo "Koi installer"
  echo

  platform="$(detect_platform)"
  echo "  Platform: ${platform}"

  install_dir="$(detect_install_dir)"
  echo "  Install directory: ${install_dir}"

  download_url="$(resolve_download_url "${platform}")"
  echo "  Download URL: ${download_url}"
  echo

  # Ensure install directory exists
  mkdir -p "${install_dir}"

  target_path="${install_dir}/koi"

  echo "Downloading koi-${platform}..."

  if command -v curl >/dev/null 2>&1; then
    curl -fSL --progress-bar -o "${target_path}" "${download_url}"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --show-progress -O "${target_path}" "${download_url}"
  else
    echo "Error: neither curl nor wget found. Install one and retry." >&2
    exit 1
  fi

  chmod +x "${target_path}"

  echo
  echo "Koi installed to ${target_path}"

  # Check if install dir is on PATH
  case ":${PATH}:" in
    *":${install_dir}:"*)
      echo "Run 'koi --help' to get started."
      ;;
    *)
      echo
      echo "NOTE: ${install_dir} is not in your PATH."
      echo "Add it with:"
      echo
      echo "  export PATH=\"${install_dir}:\${PATH}\""
      echo
      echo "Then run 'koi --help' to get started."
      ;;
  esac
}

main
