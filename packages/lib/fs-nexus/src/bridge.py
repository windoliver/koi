#!/usr/bin/env python3
"""
nexus-fs JSON-RPC bridge for Koi agents.

Thin stdin/stdout JSON-RPC 2.0 bridge over SlimNexusFS.
Ships with @koi/fs-nexus. No HTTP server needed.

Protocol:
  - One JSON-RPC request per line on stdin
  - One JSON-RPC response per line on stdout
  - First message on stdout is {"ready": true} after mount completes

Usage:
  python bridge.py <mount_uri> [mount_uri2 ...]
  python bridge.py local:///workspace
  python bridge.py local://./data s3://my-bucket/agents
"""

import asyncio
import json
import re
import sys

# JSON-RPC error codes (match Nexus server conventions)
FILE_NOT_FOUND = -32000
INVALID_PATH = -32002
VALIDATION_ERROR = -32005
METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603


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
        raw = content.encode("utf-8") if isinstance(content, str) else content
        result = await fs.write(path, raw) or {}
        size = len(raw)
        return {"bytes_written": size, "size": size, **result}

    if method == "edit":
        edits = params.get("edits", [])
        preview = params.get("preview", False)

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
        pattern_str = params.get("pattern", "")
        search_path = params.get("path", "/")
        ignore_case = params.get("ignore_case", False)
        max_results = params.get("max_results", 100)

        flags = re.IGNORECASE if ignore_case else 0
        regex = re.compile(pattern_str, flags)

        file_list = await fs.ls(search_path, detail=False, recursive=True)
        results = []

        for fp in file_list or []:
            if len(results) >= max_results:
                break
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
    """Process one JSON-RPC request and return the response dict."""
    req_id = request.get("id")
    method = request.get("method", "")
    params = request.get("params", {})

    try:
        result = await dispatch(fs, method, params)
        return {"jsonrpc": "2.0", "id": req_id, "result": result}
    except FileNotFoundError as e:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": FILE_NOT_FOUND, "message": str(e)}}
    except NotImplementedError as e:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": METHOD_NOT_FOUND, "message": str(e)}}
    except (ValueError, TypeError) as e:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": VALIDATION_ERROR, "message": str(e)}}
    except Exception as e:
        # Nexus raises PathNotMountedError, FileNotFoundError variants, etc.
        # Map "not found" messages to FILE_NOT_FOUND code.
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
    sys.stdout.write(json.dumps({"ready": True, "mounts": mounts}) + "\n")
    sys.stdout.flush()

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
        sys.stdout.write(json.dumps(response, default=str) + "\n")
        sys.stdout.flush()

    await fs.close()


if __name__ == "__main__":
    asyncio.run(main())
