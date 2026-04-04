#!/usr/bin/env python3
"""
nexus-fs JSON-RPC bridge for Koi agents.

Thin stdin/stdout JSON-RPC 2.0 bridge over SlimNexusFS.
Ships with @koi/fs-nexus. No HTTP server needed.

Protocol:
  - One JSON-RPC request per line on stdin
  - One JSON-RPC response per line on stdout
  - Out-of-band notifications (no `id`) on stdout during auth flows
  - First message on stdout is {"ready": true} after mount completes
  - All logging goes to stderr — stdout is the JSON-RPC channel only

Usage:
  python bridge.py <mount_uri> [mount_uri2 ...]
  python bridge.py local:///workspace
  python bridge.py local://./data s3://my-bucket/agents
"""

import asyncio
import json
import os
import re
import sys

# CRITICAL: stdout is the JSON-RPC channel.
# Redirect ALL print() / library output to stderr BEFORE importing nexus.fs
# so no library debug output corrupts the newline-delimited JSON stream.
_real_stdout = sys.stdout
sys.stdout = sys.stderr

# JSON-RPC error codes — must match RPC_CODE_MAP in @koi/fs-nexus/src/errors.ts
FILE_NOT_FOUND = -32000
INVALID_PATH = -32002
VALIDATION_ERROR = -32005
CONFLICT = -32006
AUTH_TIMEOUT = -32007   # user did not complete OAuth within NEXUS_AUTH_TIMEOUT_MS
METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603

# Auth polling config
AUTH_POLL_INTERVAL_S = 2          # poll get_token() every 2 seconds
AUTH_PROGRESS_INTERVAL_S = 15     # send auth_progress every 15 seconds
AUTH_MAX_ATTEMPTS = 2             # max OAuth round-trips before giving up


class ConflictError(Exception):
    """Raised when if_match fails (optimistic concurrency violation)."""


def _write(obj: dict) -> None:
    """Write one JSON line to the real stdout (the JSON-RPC channel)."""
    _real_stdout.write(json.dumps(obj, default=str) + "\n")
    _real_stdout.flush()


def _notify(method: str, params: dict) -> None:
    """Send a JSON-RPC notification (no `id`) to the Koi transport."""
    _write({"jsonrpc": "2.0", "method": method, "params": params})


async def handle_auth(fs, exc) -> bool:
    """
    Inline OAuth flow triggered by AuthenticationError.

    Sends auth_required notification with the OAuth URL, then polls
    nexus.get_token() every AUTH_POLL_INTERVAL_S seconds until the
    token appears or NEXUS_AUTH_TIMEOUT_MS elapses.

    Sends auth_progress every AUTH_PROGRESS_INTERVAL_S seconds so the
    user sees the agent is still waiting (not hung).

    Returns True if auth succeeded, False if it timed out.
    Raises on unexpected errors.
    """
    provider = getattr(exc, "provider", "unknown")
    user_email = getattr(exc, "user_email", "")
    auth_url = getattr(exc, "auth_url", "")

    if not auth_url:
        # nexus-fs didn't provide a URL — cannot drive inline auth
        return False

    timeout_ms = int(os.environ.get("NEXUS_AUTH_TIMEOUT_MS", "300000"))
    timeout_s = timeout_ms / 1000

    _notify("auth_required", {
        "provider": provider,
        "user_email": user_email,
        "auth_url": auth_url,
        "message": f"Authorize {provider} to continue",
    })

    elapsed = 0.0
    last_progress_at = 0.0

    while elapsed < timeout_s:
        await asyncio.sleep(AUTH_POLL_INTERVAL_S)
        elapsed += AUTH_POLL_INTERVAL_S

        # Send progress heartbeat every AUTH_PROGRESS_INTERVAL_S seconds
        if elapsed - last_progress_at >= AUTH_PROGRESS_INTERVAL_S:
            last_progress_at = elapsed
            _notify("auth_progress", {
                "provider": provider,
                "elapsed_seconds": int(elapsed),
                "message": f"Still waiting for {provider} authorization...",
            })

        # Check if the token has appeared
        try:
            token = await fs.get_token(provider, user_email) if user_email else await fs.get_token(provider)
        except Exception:
            token = None

        if token:
            _notify("auth_complete", {
                "provider": provider,
                "user_email": user_email,
            })
            return True

    # Timed out — user did not complete OAuth
    return False


async def dispatch(fs, method, params):
    """Route a JSON-RPC method to the corresponding SlimNexusFS call."""
    path = params.get("path", "/")

    if method == "read":
        data = await fs.read(path)
        content = data.decode("utf-8") if isinstance(data, bytes) else str(data)
        stat = await fs.stat(path) or {}
        return {"content": content, "metadata": stat}

    if method == "write":
        content = params.get("content", "")
        if_match = params.get("if_match")
        raw = content.encode("utf-8") if isinstance(content, str) else content

        # Enforce optimistic concurrency: if if_match is set,
        # verify the current etag matches before writing.
        # Treat missing file or missing etag as conflict — prevents
        # resurrecting deleted files with stale content.
        if if_match is not None:
            current_stat = await fs.stat(path)
            if current_stat is None:
                raise ConflictError(
                    f"Conflict: file was deleted (expected etag {if_match}, file no longer exists)"
                )
            current_etag = current_stat.get("etag")
            if current_etag is None:
                raise ConflictError(
                    f"Conflict: backend does not provide etag for {path}, cannot verify if_match"
                )
            if current_etag != if_match:
                raise ConflictError(
                    f"Conflict: file was modified (expected etag {if_match}, got {current_etag})"
                )

        result = await fs.write(path, raw) or {}
        size = len(raw)
        return {"bytes_written": size, "size": size, **result}

    if method == "edit":
        edits = params.get("edits", [])
        preview = params.get("preview", False)
        if_match = params.get("if_match")

        # Capture etag before read for OCC guard on write.
        # Fail closed: if the backend doesn't provide etags, refuse
        # to perform a non-preview edit (can't detect concurrent mods).
        pre_stat = await fs.stat(path)
        pre_etag = pre_stat.get("etag") if pre_stat else None

        if not preview and pre_etag is None:
            raise ValueError(
                f"Edit requires ETag for concurrency protection, but stat({path}) "
                f"did not return one. Use a backend that provides ETags."
            )

        # Honor caller-supplied if_match (from composite fallback)
        if if_match is not None:
            if pre_etag is None:
                raise ConflictError(
                    f"Conflict: cannot verify if_match — no etag available for {path}"
                )
            if pre_etag != if_match:
                raise ConflictError(
                    f"Conflict: file was modified before edit (expected etag {if_match}, got {pre_etag})"
                )

        data = await fs.read(path)
        content = data.decode("utf-8") if isinstance(data, bytes) else str(data)

        applied = 0
        for edit in edits:
            if isinstance(edit, (list, tuple)):
                old_text, new_text = edit[0], edit[1]
            else:
                old_text = edit.get("old_text", edit.get("oldText", ""))
                new_text = edit.get("new_text", edit.get("newText", ""))

            if old_text not in content:
                raise ValueError(f'Edit hunk not found: "{old_text[:50]}"')
            content = content.replace(old_text, new_text, 1)
            applied += 1

        if not preview:
            # OCC guard: verify file hasn't changed since our read.
            # Note: SlimNexusFS.write() doesn't support if_match, so
            # there is a small TOCTOU window between stat and write.
            # This is best-effort — true atomic CAS requires if_match
            # support on the facade (tracked for nexus-fs enhancement).
            # For the HTTP transport, Nexus server handles if_match
            # atomically, so this gap only affects the local bridge.
            post_stat = await fs.stat(path)
            post_etag = post_stat.get("etag") if post_stat else None
            if post_etag is None:
                raise ConflictError(
                    f"Conflict: etag disappeared during edit for {path}"
                )
            if post_etag != pre_etag:
                raise ConflictError(
                    f"Conflict: file was modified during edit (etag changed from {pre_etag} to {post_etag})"
                )
            await fs.write(path, content.encode("utf-8"))

        return {"edits_applied": applied}

    if method == "list":
        detail = params.get("details", params.get("detail", False))
        recursive = params.get("recursive", True)
        entries = await fs.ls(path, detail=detail, recursive=recursive)

        if detail and entries and isinstance(entries[0], dict):
            files = entries
        else:
            files = [{"path": p, "size": 0, "is_directory": False} for p in (entries or [])]

        return {"files": files, "has_more": False}

    if method == "grep":
        import fnmatch

        pattern_str = params.get("pattern", "")
        search_path = params.get("path", "/")
        ignore_case = params.get("ignore_case", False)
        max_results = params.get("max_results", 100)
        file_pattern = params.get("file_pattern")  # glob filter from caller

        flags = re.IGNORECASE if ignore_case else 0
        regex = re.compile(pattern_str, flags)

        file_list = await fs.ls(search_path, detail=False, recursive=True)
        results = []

        for fp in file_list or []:
            if len(results) >= max_results:
                break
            # Honor file_pattern: skip files that don't match the glob
            if file_pattern and not fnmatch.fnmatch(fp, file_pattern):
                continue
            try:
                data = await fs.read(fp)
                text = data.decode("utf-8") if isinstance(data, bytes) else str(data)
                for i, line in enumerate(text.split("\n"), 1):
                    if regex.search(line):
                        results.append({"path": fp, "line_number": i, "line_text": line})
                        if len(results) >= max_results:
                            break
            except Exception:
                continue

        return {"results": results}

    if method == "delete":
        await fs.delete(path)
        return {"deleted": True}

    if method == "rename":
        old_path = params.get("old_path", "")
        new_path = params.get("new_path", "")
        await fs.rename(old_path, new_path)
        return {"renamed": True}

    if method == "stat":
        result = await fs.stat(path)
        return {"metadata": result or {}}

    if method == "mkdir":
        parents = params.get("parents", True)
        await fs.mkdir(path, parents=parents)
        return {"created": True}

    raise NotImplementedError(f"Unknown method: {method}")


async def handle_request(fs, request):
    """
    Process one JSON-RPC request and return the response dict.

    On AuthenticationError: drives the inline OAuth flow (auth_required
    notification → poll for token → retry). Max AUTH_MAX_ATTEMPTS round-trips.
    If auth times out, returns AUTH_TIMEOUT (-32007) error.
    """
    req_id = request.get("id")
    method = request.get("method", "")
    params = request.get("params", {})

    # Attempt the operation up to AUTH_MAX_ATTEMPTS times to handle
    # the case where the first token is invalid (e.g., wrong OAuth scope).
    # Issue 14-A: cap retries to prevent infinite auth loops.
    attempts = 0

    while True:
        try:
            result = await dispatch(fs, method, params)
            return {"jsonrpc": "2.0", "id": req_id, "result": result}

        except ConflictError as e:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": CONFLICT, "message": str(e)}}
        except FileNotFoundError as e:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": FILE_NOT_FOUND, "message": str(e)}}
        except NotImplementedError as e:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": METHOD_NOT_FOUND, "message": str(e)}}
        except (ValueError, TypeError) as e:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": VALIDATION_ERROR, "message": str(e)}}

        except Exception as e:
            # Check for AuthenticationError from nexus-fs (requires nexus-fs >= auth-inline).
            # AuthenticationError must provide: .provider, .user_email, .auth_url
            auth_exc_type = getattr(
                sys.modules.get("nexus.fs", None), "AuthenticationError", None
            )
            is_auth_error = (
                auth_exc_type is not None and isinstance(e, auth_exc_type)
            )

            if is_auth_error:
                if attempts >= AUTH_MAX_ATTEMPTS:
                    # dispatch() has failed with AuthenticationError after every
                    # allowed auth round-trip — the token exists but access is still
                    # denied (e.g. wrong OAuth scope).
                    return {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {
                            "code": AUTH_TIMEOUT,
                            "message": (
                                "Authorization succeeded but access was still denied. "
                                "The OAuth grant may have insufficient scope. "
                                "Try re-authorizing with broader permissions."
                            ),
                        },
                    }

                attempts += 1
                auth_ok = await handle_auth(fs, e)

                if not auth_ok:
                    # User did not complete OAuth within the timeout
                    return {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {
                            "code": AUTH_TIMEOUT,
                            "message": (
                                "OAuth authorization timed out. "
                                "Complete the authorization in your browser and try again."
                            ),
                        },
                    }

                # Auth completed — always retry dispatch regardless of attempt count.
                # If dispatch throws AuthenticationError again, the loop re-enters
                # and hits the attempts >= AUTH_MAX_ATTEMPTS guard above.
                continue

            # Not an auth error — map to standard codes
            msg = str(e).lower()
            if "not found" in msg or "not mounted" in msg or "does not exist" in msg:
                return {"jsonrpc": "2.0", "id": req_id, "error": {"code": FILE_NOT_FOUND, "message": str(e)}}
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": INTERNAL_ERROR, "message": str(e)}}


async def main():
    import nexus.fs

    mount_uris = sys.argv[1:] if len(sys.argv) > 1 else ["local://."]
    fs = await nexus.fs.mount(*mount_uris)

    # Signal ready with mount info
    mounts = fs.list_mounts()
    _write({"ready": True, "mounts": mounts})

    # Read stdin line by line using asyncio thread-safe approach
    loop = asyncio.get_event_loop()

    while True:
        # Read one line from stdin in a thread (blocking I/O)
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break

        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue

        response = await handle_request(fs, request)
        _write(response)

    await fs.close()


if __name__ == "__main__":
    asyncio.run(main())
