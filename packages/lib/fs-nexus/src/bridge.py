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
import secrets
import socket
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Event, Thread

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

# Auth config
AUTH_MAX_ATTEMPTS = 2   # max OAuth round-trips before giving up
AUTH_PROGRESS_INTERVAL_S = 15  # send auth_progress heartbeat every N seconds

# Queue for auth code submissions from the remote paste flow.
# When Koi receives a pasted redirect URL it sends auth_submit to the bridge
# stdin, which the concurrent stdin reader puts here.
_auth_submit_queue: asyncio.Queue[str] = asyncio.Queue()


class ConflictError(Exception):
    """Raised when if_match fails (optimistic concurrency violation)."""


def _write(obj: dict) -> None:
    """Write one JSON line to the real stdout (the JSON-RPC channel)."""
    _real_stdout.write(json.dumps(obj, default=str) + "\n")
    _real_stdout.flush()


def _notify(method: str, params: dict) -> None:
    """Send a JSON-RPC notification (no `id`) to the Koi transport."""
    _write({"jsonrpc": "2.0", "method": method, "params": params})


# ---------------------------------------------------------------------------
# Environment detection
# ---------------------------------------------------------------------------

def _can_open_browser() -> bool:
    """
    Return True when a browser redirect to localhost is reachable.

    False when running in SSH, headless Linux (no DISPLAY), or any
    environment where the user's browser can't reach localhost on this host.
    """
    if os.environ.get("SSH_CLIENT") or os.environ.get("SSH_TTY"):
        return False
    if (
        sys.platform not in ("darwin", "win32")
        and not os.environ.get("DISPLAY")
        and not os.environ.get("WAYLAND_DISPLAY")
    ):
        return False
    return True


# ---------------------------------------------------------------------------
# Free port selection
# ---------------------------------------------------------------------------

def _bind_free_port() -> tuple[socket.socket, int]:
    """
    Bind to port 0, let the OS pick a free port, and return BOTH the bound
    socket and the port number.

    The caller MUST keep the socket open (with SO_REUSEPORT/SO_REUSEADDR)
    until the HTTP server has taken ownership of the port.  Releasing it
    first leaves a TOCTOU race where another process can claim the port
    between the `close()` and the `HTTPServer.__init__()` bind.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", 0))
    return s, s.getsockname()[1]


# ---------------------------------------------------------------------------
# Localhost callback server (local flow)
# ---------------------------------------------------------------------------

def _run_callback_server(
    pre_bound_sock: socket.socket, code_holder: list, done: Event
) -> None:
    """
    Run a one-shot HTTP server using a pre-bound socket, capturing ?code=...
    from the OAuth redirect.

    The caller passes the already-bound socket to eliminate the TOCTOU race
    between port selection and HTTPServer.__init__().  The socket is closed
    once the HTTP server takes over.
    """
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            code_list = params.get("code", [])
            if code_list:
                code_holder.append(code_list[0])
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            msg = b"<h1>Authorization complete. You can close this tab.</h1>"
            self.wfile.write(msg)
            done.set()

        def log_message(self, *args):  # suppress HTTP request logs
            pass

    # HTTPServer takes over the pre-bound socket; close our reference so the
    # server holds the only handle.  Wrap in try/finally so the socket is
    # always closed even if HTTPServer construction or request handling fails.
    try:
        httpd = HTTPServer(("127.0.0.1", 0), Handler)
        httpd.socket.close()
        httpd.socket = pre_bound_sock
        pre_bound_sock.listen(1)
        httpd.timeout = 1.0
        while not done.is_set():
            httpd.handle_request()
        httpd.server_close()
    except Exception:
        try:
            pre_bound_sock.close()
        except Exception:
            pass
        done.set()  # unblock handle_auth if server failed
        raise


# ---------------------------------------------------------------------------
# Auth flow
# ---------------------------------------------------------------------------

async def handle_auth(fs, exc) -> bool:
    """
    Inline OAuth flow triggered by AuthenticationError.

    Supports two modes selected automatically:
    - Local  (browser reachable): PKCE + localhost callback — instant, no polling.
    - Remote (SSH/headless):      PKCE + paste redirect URL — user pastes the full
                                  redirect URL into the Koi conversation; Koi sends
                                  it back as an auth_submit JSON-RPC request.

    Requires nexus-fs to expose:
      nexus.fs.generate_auth_url(provider, user_email, redirect_uri, code_verifier)
      nexus.fs.exchange_auth_code(provider, code, redirect_uri, code_verifier)

    Returns True if auth succeeded, False if timed out or user abandoned.
    Raises on unexpected errors.
    """
    provider = getattr(exc, "provider", "unknown")
    user_email = getattr(exc, "user_email", "")

    timeout_ms = int(os.environ.get("NEXUS_AUTH_TIMEOUT_MS", "300000"))
    timeout_s = timeout_ms / 1000

    local = _can_open_browser()
    if local:
        # Keep the bound socket alive until the callback server takes ownership.
        _sock, port = _bind_free_port()
    else:
        _sock, port = None, None
    redirect_uri = f"http://127.0.0.1:{port}/callback" if local else "urn:ietf:wg:oauth:2.0:oob"

    # Ask nexus-fs for the auth URL and code_verifier.
    # nexus-fs owns PKCE — it returns the verifier (or None for providers that
    # don't use PKCE). We pass it back in exchange_auth_code.
    # Requires nexus-fs >= auth-programmatic (PR #3629).
    nexus_fs_mod = sys.modules.get("nexus.fs")
    generate_auth_url = getattr(nexus_fs_mod, "generate_auth_url", None)
    exchange_auth_code = getattr(nexus_fs_mod, "exchange_auth_code", None)

    if generate_auth_url is None or exchange_auth_code is None:
        # nexus-fs does not yet expose the programmatic OAuth API
        return False

    auth_url, verifier = generate_auth_url(provider, redirect_uri)

    if local:
        # ---------------------------------------------------------------
        # Local flow: start callback server, send auth_required, await code
        # ---------------------------------------------------------------
        code_holder: list[str] = []
        done = Event()
        server_thread = Thread(
            target=_run_callback_server,
            args=(_sock, code_holder, done),
            daemon=True,
        )
        server_thread.start()
        # Socket ownership transferred to server thread; clear our reference.
        _sock = None

        _notify("auth_required", {
            "provider": provider,
            "user_email": user_email,
            "auth_url": auth_url,
            "message": f"Authorize {provider} to continue",
            "mode": "local",
        })

        # Wait for the callback, sending progress heartbeats
        elapsed = 0.0
        last_progress_at = 0.0
        while elapsed < timeout_s and not done.is_set():
            await asyncio.sleep(1)
            elapsed += 1
            if elapsed - last_progress_at >= AUTH_PROGRESS_INTERVAL_S:
                last_progress_at = elapsed
                _notify("auth_progress", {
                    "provider": provider,
                    "elapsed_seconds": int(elapsed),
                    "message": f"Waiting for {provider} authorization in browser...",
                })

        done.set()  # stop server even if we timed out
        server_thread.join(timeout=2)

        if not code_holder:
            return False

        code = code_holder[0]

    else:
        # ---------------------------------------------------------------
        # Remote flow: show URL, wait for user to paste redirect URL back
        # via auth_submit JSON-RPC request from Koi.
        #
        # A correlation ID is included in auth_required and must be echoed
        # back in auth_submit to prevent stale or out-of-order pastes from
        # being consumed by the wrong auth attempt.
        # ---------------------------------------------------------------
        # Drain any stale submissions from previous attempts before waiting.
        while not _auth_submit_queue.empty():
            try:
                _auth_submit_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

        correlation_id = secrets.token_hex(8)
        _notify("auth_required", {
            "provider": provider,
            "user_email": user_email,
            "auth_url": auth_url,
            "message": f"Authorize {provider} to continue",
            "mode": "remote",
            "correlation_id": correlation_id,
            "instructions": (
                "Open the URL in your browser. "
                "When the page shows a connection error, copy the full URL "
                "from the address bar and paste it into the conversation."
            ),
        })

        code = None
        deadline = asyncio.get_event_loop().time() + timeout_s
        while asyncio.get_event_loop().time() < deadline:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                break
            try:
                # Poll in 30s chunks to send progress heartbeats, but always
                # continue the loop on timeout — only the outer deadline exits.
                submission = await asyncio.wait_for(
                    _auth_submit_queue.get(), timeout=min(remaining, 30)
                )
            except asyncio.TimeoutError:
                # 30s chunk elapsed — send progress and keep waiting
                elapsed_s = int(timeout_s - remaining + 30)
                _notify("auth_progress", {
                    "provider": provider,
                    "elapsed_seconds": elapsed_s,
                    "message": f"Still waiting for {provider} authorization (paste the redirect URL)...",
                })
                continue

            # Validate correlation ID — reject submissions for other flows.
            sub_id = submission.get("correlation_id") if isinstance(submission, dict) else None
            if sub_id != correlation_id:
                continue  # stale — keep waiting

            redirect_url = submission.get("redirect_url", "") if isinstance(submission, dict) else submission
            parsed = urllib.parse.urlparse(redirect_url)
            params = urllib.parse.parse_qs(parsed.query)
            codes = params.get("code", [])
            if codes:
                code = codes[0]
                break

        if not code:
            return False

    # Exchange the authorization code for a stored token.
    # code_verifier is None for providers that don't use PKCE (e.g. Google);
    # non-None for providers that do (e.g. X/Twitter).
    await exchange_auth_code(
        provider,
        user_email,
        code,
        redirect_uri,
        code_verifier=verifier,
    )

    _notify("auth_complete", {
        "provider": provider,
        "user_email": user_email,
    })
    return True


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
            # Check for AuthenticationError from nexus-fs.
            # Lives in nexus.contracts.exceptions (not on nexus.fs directly).
            # AuthenticationError provides: .provider, .user_email, .auth_url
            try:
                from nexus.contracts.exceptions import AuthenticationError as _AuthErr
                auth_exc_type: type | None = _AuthErr
            except ImportError:
                auth_exc_type = None
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

    loop = asyncio.get_event_loop()

    # Concurrent stdin reader — puts lines into a queue so that auth_submit
    # requests can arrive while handle_request() is blocked in handle_auth().
    # Without this, the bridge would deadlock waiting for handle_auth() to
    # finish before reading the auth_submit that would unblock it.
    stdin_queue: asyncio.Queue[str] = asyncio.Queue()

    async def _read_stdin() -> None:
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                await stdin_queue.put("")  # sentinel — EOF
                return
            line = line.strip()
            if line:
                await stdin_queue.put(line)

    asyncio.ensure_future(_read_stdin())

    while True:
        line = await stdin_queue.get()
        if not line:
            break  # EOF

        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            # Malformed line — fatal protocol error (see local-transport.ts)
            break

        method = request.get("method", "")

        # auth_submit: Koi forwarded the user's pasted redirect URL (remote flow).
        # Route as a structured dict so handle_auth() can validate correlation_id.
        # No response needed — this is a one-way signal.
        if method == "auth_submit":
            params = request.get("params", {})
            await _auth_submit_queue.put({
                "redirect_url": params.get("redirect_url", ""),
                "correlation_id": params.get("correlation_id"),
            })
            continue

        response = await handle_request(fs, request)
        _write(response)

    await fs.close()


if __name__ == "__main__":
    asyncio.run(main())
