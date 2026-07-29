"""Serve a pre-built Boardex UI from the runner (single-origin deployment).

Off by default: the runner only serves files when it is launched with
``BOARDEX_SERVE_UI=<dir>`` pointing at a built UI bundle (``index.html`` +
``assets/``). The ``boardex`` distribution's ``boardex up`` passes the bundle it
embeds; a bare ``boardex-runner`` process is byte-for-byte unchanged.

Three rules, in this order:

1. **API routes keep priority.** ``add_ui_routes`` registers ONE catch-all GET
   and must be called last: aiohttp matches resources in registration order, so
   every §5.3 route already registered wins over the catch-all.
2. **A real file is served as itself**, with an explicit MIME type (the stdlib
   table is incomplete on some hosts, and a wrong ``Content-Type`` on the module
   bundle is a blank page).
3. **Anything else falls back to ``index.html`` only for a browser navigation**
   (``Accept: text/html``). A non-HTML request for an unknown path still gets a
   JSON 404 — the UI feature-detects optional routes (§5.3 / the v2.5 proposals)
   by their 404, and answering those with HTML would turn "absent capability"
   into a parse error.
"""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path

from aiohttp import web

# Explicit types for everything a Vite bundle emits. mimetypes' table varies by
# host (Windows reads it from the registry, where .js has been seen as
# text/plain) and lacks the font types on older Pythons.
_MIME_TYPES = {
    ".css": "text/css",
    ".gif": "image/gif",
    ".html": "text/html",
    ".ico": "image/vnd.microsoft.icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".map": "application/json",
    ".mjs": "text/javascript",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".txt": "text/plain",
    ".webmanifest": "application/manifest+json",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}

# Vite content-hashes everything under assets/, so those files are immutable;
# index.html names them and must never be cached, or a reload after an upgrade
# serves an old document pointing at bundles that no longer exist.
_IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
_NO_CACHE = "no-cache"


def ui_root_from_env(environ: "os._Environ[str] | dict[str, str] | None" = None) -> Path | None:
    """The UI bundle directory from ``BOARDEX_SERVE_UI``, or None when unset.

    A path that does not hold an ``index.html`` is a configuration error, not a
    silent no-op: serving nothing while the operator believes the UI is up is
    worse than refusing to start.
    """
    env = os.environ if environ is None else environ
    raw = env.get("BOARDEX_SERVE_UI", "").strip()
    if not raw:
        return None
    root = Path(raw).expanduser().resolve()
    if not (root / "index.html").is_file():
        raise SystemExit(
            f"BOARDEX_SERVE_UI={raw} does not contain an index.html "
            "(expected a built UI bundle directory)"
        )
    return root


def content_type_for(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in _MIME_TYPES:
        return _MIME_TYPES[suffix]
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def _resolve(root: Path, relative: str) -> Path | None:
    """The file ``relative`` names inside ``root``, or None.

    None covers every not-a-file case including traversal: the candidate is
    resolved and re-checked against the root, so ``../../etc/passwd`` — which
    reaches here as a real ``../`` segment, since the router hands over the
    DECODED path and ``%2e%2e%2f`` survives client-side normalization — or a
    symlink pointing out of the bundle resolves outside and is refused.

    Hostile inputs that the filesystem itself rejects are also just "no such
    file": a ``%00`` in the path raises ValueError (embedded null byte) and an
    over-long segment raises OSError (ENAMETOOLONG). Neither is a server fault,
    so neither may become a 500 with a traceback in the log.
    """
    if not relative:
        return None
    try:
        candidate = (root / relative).resolve()
        if candidate != root and root not in candidate.parents:
            return None
        return candidate if candidate.is_file() else None
    except (OSError, ValueError):
        return None


def add_ui_routes(app: web.Application, ui_root: Path) -> None:
    """Register the single catch-all GET that serves ``ui_root``. Call LAST."""
    root = ui_root.resolve()
    index = root / "index.html"

    def _file_response(path: Path, cache: str) -> web.FileResponse:
        return web.FileResponse(
            path,
            headers={"Content-Type": content_type_for(path), "Cache-Control": cache},
        )

    async def serve_ui(request: web.Request) -> web.StreamResponse:
        relative = request.match_info.get("path", "")
        found = _resolve(root, relative)
        if found is not None:
            immutable = "assets" in Path(relative).parts and found != index
            return _file_response(found, _IMMUTABLE_CACHE if immutable else _NO_CACHE)
        # SPA fallback: a client route (/runs/..., /demo, /settings) is not a
        # file, so a browser navigation gets the document and the router takes
        # it from there. Anything not asking for HTML gets an honest 404 —
        # except `/`, which is the app's front door whoever is asking.
        if not relative or "text/html" in request.headers.get("Accept", ""):
            return _file_response(index, _NO_CACHE)
        return web.json_response({"error": "not found"}, status=404)

    app.router.add_get("/{path:.*}", serve_ui)
