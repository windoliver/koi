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
import inspect
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
PERMISSION_ERROR = -32004  # authorized but access denied (e.g. insufficient OAuth scope)
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


# Authoritative connector identity for paths the current bridge process
# committed via add_mount. Populated from the source URI's scheme at
# add_mount time so subsequent describe_mount can return the correct
# connector type for aliased mounts (e.g. `gdrive://x` at `/team/docs`
# preserves connector "gdrive" instead of guessing "team" from the path).
# Best-effort only — paths committed before this process started, or by
# another process, fall back to the path-prefix heuristic which may lie
# for aliased mounts. Operators should treat the connector field as
# advisory unless the path clearly carries the scheme as its first
# segment.
_SESSION_MOUNT_CONNECTORS: dict[str, str] = {}


def _mount_connector_from_path(path: str) -> str:
    cached = _SESSION_MOUNT_CONNECTORS.get(path)
    if cached is not None:
        return cached
    parts = [part for part in path.split("/") if part]
    return parts[0] if parts else "unknown"


def _parse_frontmatter_value(frontmatter: str, key: str) -> str | None:
    pattern = re.compile(rf"^{re.escape(key)}\s*:\s*(.+)$", re.MULTILINE)
    match = pattern.search(frontmatter)
    if match is None:
        return None
    value = match.group(1).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        return value[1:-1]
    return value


def _extract_description_from_readme(readme: str) -> str | None:
    if readme.startswith("---\n"):
        end = readme.find("\n---\n", 4)
        if end != -1:
            frontmatter = readme[4:end]
            for key in ("description", "summary", "title"):
                value = _parse_frontmatter_value(frontmatter, key)
                if value:
                    return value
    for line in readme.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped[:200]
    return None


async def _maybe_await(value):
    if inspect.isawaitable(value):
        return await value
    return value


async def _call_first(targets, names, *args, **kwargs):
    for target in targets:
        if target is None:
            continue
        for name in names:
            fn = getattr(target, name, None)
            if callable(fn):
                return await _maybe_await(fn(*args, **kwargs))
    raise NotImplementedError(f"Backend does not support any of: {', '.join(names)}")


def _mount_targets(fs):
    return (
        fs,
        getattr(fs, "backend", None),
        getattr(fs, "_backend", None),
        getattr(fs, "facade", None),
    )


async def _list_mounts_scoped(fs):
    """List mounts visible through the scoped filesystem wrapper.

    Critical for trust-boundary enforcement on describe_mount and
    remove_mount: this MUST NOT walk through to inner raw backends via
    _mount_targets(). A scoped wrapper that does not expose list_mounts
    has no authoritative scope-aware view, so callers must fail closed
    rather than fall through to the raw backend (which would let scoped
    sessions describe or remove sibling/tenant mounts).

    Returns the list reported by `fs.list_mounts()` itself, or None when
    the scoped fs does not expose `list_mounts` (caller must reject).
    """
    list_fn = getattr(fs, "list_mounts", None)
    if not callable(list_fn):
        return None
    return await _maybe_await(list_fn())


async def _generate_mount_readme(fs, path: str) -> str | None:
    targets = _mount_targets(fs)
    try:
        readme = await _call_first(targets, ("generate_readme",), path)
    except NotImplementedError:
        return None
    if readme is None:
        return None
    if isinstance(readme, bytes):
        return readme.decode("utf-8")
    return str(readme)


async def _describe_mount(fs, path: str) -> dict:
    readme = await _generate_mount_readme(fs, path)
    description = _extract_description_from_readme(readme) if readme is not None else None
    result = {
        "path": path,
        "connector": _mount_connector_from_path(path),
    }
    if description:
        result["description"] = description
    if readme:
        result["readme"] = readme
    return result


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
        server_exc: list[BaseException] = []  # captures thread-level failures
        done = Event()

        def _server_target(sock, codes, evt):
            try:
                _run_callback_server(sock, codes, evt)
            except BaseException as _e:  # noqa: BLE001
                server_exc.append(_e)
                evt.set()  # unblock the wait loop so handle_auth sees the failure

        server_thread = Thread(
            target=_server_target,
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

        # Re-raise real infrastructure failures instead of masking them as
        # user timeout — an empty code_holder from a server crash is not
        # the same as a genuine auth abandonment.
        if server_exc:
            raise server_exc[0]

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
    # Bound the exchange to 30s — a hung provider token endpoint would otherwise
    # block indefinitely because auth_required already cleared the per-call timer.
    EXCHANGE_TIMEOUT_S = 30
    try:
        await asyncio.wait_for(
            exchange_auth_code(
                provider,
                user_email,
                code,
                redirect_uri,
                code_verifier=verifier,
            ),
            timeout=EXCHANGE_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        return False  # bridge will return AUTH_TIMEOUT to caller

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
        for i, edit in enumerate(edits):
            if isinstance(edit, (list, tuple)):
                if len(edit) < 2:
                    raise ValueError(f"Edit entry {i}: sequence must have at least 2 elements (old_text, new_text), got {len(edit)}")
                old_text, new_text = edit[0], edit[1]
                if not isinstance(old_text, str) or not isinstance(new_text, str):
                    raise ValueError(f"Edit entry {i}: old_text and new_text must be strings")
            elif isinstance(edit, dict):
                old_text = edit.get("old_text", edit.get("oldText"))
                new_text = edit.get("new_text", edit.get("newText"))
                if not isinstance(old_text, str) or not isinstance(new_text, str):
                    raise ValueError(f"Edit entry {i}: missing or non-string old_text/new_text fields")
            else:
                raise ValueError(f"Edit entry {i}: must be a list/tuple or dict, got {type(edit).__name__}")

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
        skipped = []

        for fp in file_list or []:
            if len(results) >= max_results:
                break
            # Honor file_pattern: skip files that don't match the glob
            if file_pattern and not fnmatch.fnmatch(fp, file_pattern):
                continue
            try:
                data = await fs.read(fp)
                # Only skip binary/non-decodable files; re-raise other errors.
                try:
                    text = data.decode("utf-8") if isinstance(data, bytes) else str(data)
                except (UnicodeDecodeError, ValueError):
                    skipped.append({"path": fp, "reason": "not utf-8"})
                    continue
                for i, line in enumerate(text.split("\n"), 1):
                    if regex.search(line):
                        results.append({"path": fp, "line_number": i, "line_text": line})
                        if len(results) >= max_results:
                            break
            except (UnicodeDecodeError, ValueError):
                skipped.append({"path": fp, "reason": "not utf-8"})
            except FileNotFoundError:
                skipped.append({"path": fp, "reason": "not found"})
            # All other exceptions (permission errors, backend faults) propagate
            # so the caller gets a real error instead of silent incomplete results.

        return {"results": results, "skipped": skipped}

    if method == "semantic_search":
        query = params.get("query", "")
        search_path = params.get("path", "/")
        limit = params.get("limit", 10)
        search_mode = params.get("search_mode", "hybrid")
        results = await fs.semantic_search(
            query,
            path=search_path,
            limit=limit,
            search_mode=search_mode,
        )
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

    if method == "list_mounts":
        # Trust-boundary enforcement: list_mounts is exposed via JSON-RPC and
        # any scoped client could otherwise enumerate sibling/tenant mounts
        # by reading the raw inner backend. Use _list_mounts_scoped which
        # calls fs.list_mounts() ONLY (never walks to inner backends). If
        # the scoped wrapper does not expose list_mounts, fail closed — we
        # cannot prove the result respects scope.
        scoped_live = await _list_mounts_scoped(fs)
        if scoped_live is None:
            raise ValueError(
                "list_mounts refused: scoped filesystem does not expose list_mounts; "
                "cannot return a scope-respecting mount list"
            )
        return {"mounts": list(scoped_live)}

    if method == "describe_mount":
        mount_path = params.get("path")
        if not isinstance(mount_path, str) or len(mount_path) == 0:
          raise ValueError("describe_mount requires a non-empty string path")
        # Trust-boundary enforcement: validate `mount_path` against the
        # scope-aware list_mounts() ONLY. Walking through to raw backends
        # via _mount_targets() would let a scoped session describe sibling
        # or tenant mounts that the wrapper would otherwise hide, since
        # the underlying _describe_mount also bypasses the wrapper to
        # invoke generate_readme().
        try:
            scoped_live = await _list_mounts_scoped(fs)
        except Exception as exc:
            raise ValueError(
                f"describe_mount cannot verify path {mount_path!r}: list_mounts failed ({exc})"
            ) from exc
        if scoped_live is None:
            raise ValueError(
                "describe_mount refused: scoped filesystem does not expose list_mounts; "
                "cannot prove path is in scope"
            )
        if mount_path not in scoped_live:
            raise ValueError(
                f"describe_mount refused: path {mount_path!r} is not in the scoped mount set"
            )
        return await _describe_mount(fs, mount_path)

    if method == "add_mount":
        uri = params.get("uri")
        at = params.get("at")
        if not isinstance(uri, str) or len(uri) == 0:
            raise ValueError("add_mount requires a non-empty string uri")
        if at is not None and (not isinstance(at, str) or len(at) == 0):
            raise ValueError("add_mount at must be a non-empty string when provided")
        # Snapshot mounts before mutation so we can diff to discover the
        # resulting path when `at` was not specified. If list_mounts fails
        # before mutation, fall back to an empty snapshot — the actual
        # mutation can still proceed and we'll handle missing diff below.
        # Trust-boundary enforcement: resolve add_mount against the scoped
        # filesystem wrapper ONLY. Walking through to fs.backend / fs._backend /
        # fs.facade would let a scoped session reach raw backend mount logic
        # and add mounts outside its visible namespace. The wrapper either
        # implements add_mount/mount (scope is applied inside it) or it does
        # not (fail closed). Callers that need raw backend mutations must do
        # so outside the scoped boundary.
        scoped_add = getattr(fs, "add_mount", None)
        scoped_mount = getattr(fs, "mount", None)
        if not callable(scoped_add) and not callable(scoped_mount):
            raise ValueError(
                "add_mount refused: scoped filesystem does not expose add_mount/mount; "
                "raw backend mount mutations are not reachable through this session"
            )
        # Use scope-aware listing for the pre-mutation snapshot so the
        # diff that resolves the committed path stays inside the scope
        # boundary (and matches what the runtime guard sees).
        try:
            before_listed = await _list_mounts_scoped(fs)
            before = set(before_listed) if before_listed is not None else set()
        except Exception:
            before = set()
        if at is None:
            if callable(scoped_add):
                await _maybe_await(scoped_add(uri))
            else:
                await _maybe_await(scoped_mount(uri))
        else:
            if callable(scoped_add):
                try:
                    await _maybe_await(scoped_add(uri, at=at))
                except NotImplementedError:
                    if callable(scoped_mount):
                        await _maybe_await(scoped_mount(uri, at))
                    else:
                        raise
            else:
                await _maybe_await(scoped_mount(uri, at))
        # The mount has now been committed. Everything below here is
        # post-commit enrichment and MUST NOT raise — surfacing an error
        # would trick callers into retrying a non-idempotent mutation that
        # already succeeded. Each enrichment step is wrapped so its failure
        # degrades the response payload rather than the call result.
        #
        # Resolve the committed path authoritatively from `list_mounts`,
        # not from the caller-supplied `at`. The backend may normalize the
        # mount target (e.g. strip trailing slash, add a leading slash, or
        # collapse duplicate slashes), so echoing `at` verbatim would let
        # the client cache and advertise an identifier that does not match
        # the real live mount. A subsequent /unmount keyed off the wrong
        # identifier would silently miss the live mount, and the prompt
        # middleware's strict path allowlist might drop the entry entirely.
        resolved_path: str | None = None
        try:
            after_listed = await _list_mounts_scoped(fs)
            after = list(after_listed) if after_listed is not None else []
            new_mounts = [mount for mount in after if mount not in before]
            if len(new_mounts) == 1:
                resolved_path = new_mounts[0]
        except Exception:
            resolved_path = None
        if resolved_path is None:
            # Mutation IS committed but the bridge cannot determine the new
            # path. Returning the source URI as `path` would let callers treat
            # it as canonical and call /unmount on a non-path. Surface the
            # partial state explicitly so callers can prompt the user to run
            # list_mounts and recover.
            scheme = uri.split("://", 1)[0] if "://" in uri else "unknown"
            return {
                "path": "",
                "connector": scheme,
                "pathUnknown": True,
            }
        # Do NOT await _describe_mount here. Description / README generation
        # may hang on slow OAuth or large remote connectors and can exceed the
        # client's per-RPC timeout. The mount IS committed at this point, and
        # surfacing a timeout error to the caller would invite a retry against
        # a non-idempotent mutation. Return the minimal canonical payload now;
        # callers refresh enriched descriptions on demand via describe_mount.
        # Use the URI scheme as the canonical connector identity instead of
        # guessing from the resolved path. An aliased mount like
        # `gdrive://foo` at `/team/docs` would otherwise be reported as
        # connector "team", which lies about the connector type to both
        # the model and the operator. Track URI -> connector for any later
        # describe_mount lookup against this path so the bridge can return
        # the same authoritative value without re-deriving from the path.
        connector_scheme = uri.split("://", 1)[0] if "://" in uri else "unknown"
        _SESSION_MOUNT_CONNECTORS[resolved_path] = connector_scheme
        return {
            "path": resolved_path,
            "connector": connector_scheme,
        }

    if method == "remove_mount":
        mount_path = params.get("path")
        if not isinstance(mount_path, str) or len(mount_path) == 0:
            raise ValueError("remove_mount requires a non-empty string path")
        # Trust-boundary enforcement: a scoped session must not be able to
        # unmount sibling/tenant mounts outside its scope. Validate the
        # target against the scope-aware list_mounts() ONLY (do not walk
        # through to inner backends, which would bypass scope filtering).
        # If the scoped fs cannot authoritatively list, fail closed.
        try:
            scoped_live = await _list_mounts_scoped(fs)
        except Exception as exc:
            raise ValueError(
                f"remove_mount cannot verify path {mount_path!r}: list_mounts failed ({exc})"
            ) from exc
        if scoped_live is None:
            raise ValueError(
                "remove_mount refused: scoped filesystem does not expose list_mounts; "
                "cannot prove path is in scope"
            )
        if mount_path not in scoped_live:
            raise ValueError(
                f"remove_mount refused: path {mount_path!r} is not in the scoped mount set"
            )
        # Snapshot before mutation so we can diff to identify the
        # authoritative removed path. The caller-supplied `mount_path` may
        # be a non-canonical form (trailing slash, missing leading slash);
        # echoing it verbatim would let client caches drift from list_mounts.
        before = set(scoped_live)
        # Trust-boundary enforcement: route the actual removal through the
        # scoped wrapper ONLY. Walking through to inner backends via
        # _mount_targets would bypass scope filtering on the mutation path
        # (the visibility check above would still pass, but the mutation
        # itself would land on raw backend state).
        scoped_remove = getattr(fs, "remove_mount", None)
        scoped_unmount = getattr(fs, "unmount", None)
        if callable(scoped_remove):
            await _maybe_await(scoped_remove(mount_path))
        elif callable(scoped_unmount):
            await _maybe_await(scoped_unmount(mount_path))
        else:
            raise ValueError(
                "remove_mount refused: scoped filesystem does not expose remove_mount/unmount; "
                "raw backend mount mutations are not reachable through this session"
            )
        # Resolve the actual path that disappeared. If exactly one mount was
        # removed, return its authoritative form; otherwise fall back to the
        # caller-supplied path (best effort — the cache update on the TS
        # side already canonicalizes via canonicalizeMountPath()).
        resolved_path = mount_path
        try:
            after_listed = await _list_mounts_scoped(fs)
            after = set(after_listed) if after_listed is not None else set()
            removed = [m for m in before if m not in after]
            if len(removed) == 1:
                resolved_path = removed[0]
        except Exception:
            pass
        # Drop the URI-scheme cache for the removed path so a future
        # add_mount at the same path with a different connector cannot
        # carry stale identity from the previous mount.
        _SESSION_MOUNT_CONNECTORS.pop(mount_path, None)
        _SESSION_MOUNT_CONNECTORS.pop(resolved_path, None)
        return {"path": resolved_path, "removed": True}

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
                    # allowed auth round-trip — the token was granted but access
                    # is still denied (e.g. wrong OAuth scope). This is a permanent
                    # authorization failure, not a timeout — use PERMISSION_ERROR
                    # so clients don't misapply timeout-specific retry behavior.
                    return {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {
                            "code": PERMISSION_ERROR,
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

    # Signal ready with mount info. Also build path -> connector-scheme
    # mapping from the original URIs so the TS seed layer can advertise
    # the correct connector type for aliased mounts (e.g. gdrive://x at
    # /team/docs reports connector "gdrive", not "team"). Best-effort
    # ordinal pairing: nexus.fs.mount() commits URIs in argv order, and
    # list_mounts() should return them in the same order. When counts
    # mismatch we leave the cache empty for the unmatched paths and
    # fall back to the path-prefix heuristic.
    mounts = fs.list_mounts()
    mount_connectors: dict[str, str] = {}
    for idx, path in enumerate(mounts):
        if idx < len(mount_uris):
            uri = mount_uris[idx]
            scheme = uri.split("://", 1)[0] if "://" in uri else "unknown"
            mount_connectors[path] = scheme
            _SESSION_MOUNT_CONNECTORS[path] = scheme
    _write({"ready": True, "mounts": mounts, "mount_connectors": mount_connectors})

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
