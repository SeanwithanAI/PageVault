#!/usr/bin/env python3
"""
PageVault - a tiny self-hosted home for your HTML pages.

* Sign in (multi-user, first account becomes admin)
* Upload a single .html file or a .zip of a whole site
* Admins upload apps and create accounts; people sign in and pick from their apps
* Every app gets a stable link:  /a/<app-name>/
* Pages can save data on the server, kept separately for each signed-in user.
  Pages that use localStorage work unchanged - it is transparently redirected
  to server storage.

Pure Python standard library. No pip installs needed.
"""
import base64
import calendar
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "2026-11-11 mk4"   # bump with every update: date of the update, mk2/mk3... for more that day

# --------------------------------------------------------------------------- config
DATA_DIR = os.environ.get("DATA_DIR", "/data")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))
MAX_UPLOAD = int(os.environ.get("MAX_UPLOAD_MB", "100")) * 1024 * 1024
MAX_UNZIPPED = int(os.environ.get("MAX_UNZIPPED_MB", "500")) * 1024 * 1024
MAX_ZIP_FILES = int(os.environ.get("MAX_ZIP_FILES", "5000"))
STORE_QUOTA = int(os.environ.get("STORE_QUOTA_MB", "200")) * 1024 * 1024
MAX_VALUE = int(os.environ.get("MAX_VALUE_MB", "10")) * 1024 * 1024
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "0") == "1"
SESSION_DAYS = int(os.environ.get("SESSION_DAYS", "30"))
VIEW_TOKEN_HOURS = int(os.environ.get("VIEW_TOKEN_HOURS", "24"))

APP_DIR = os.path.dirname(os.path.realpath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
# Apps (uploaded HTML) and user data can live on different datasets if you like.
PAGES_DIR = os.environ.get("APPS_DIR") or os.path.join(DATA_DIR, "pages")
TMP_DIR = os.path.join(PAGES_DIR, ".tmp")  # same filesystem as PAGES_DIR so swaps are atomic
ICON_DIR = os.path.join(PAGES_DIR, ".icons")  # custom app images
FILES_DIR = os.path.join(DATA_DIR, "files")   # files apps save for each person (e.g. receipts)
MAX_FILE = int(os.environ.get("MAX_FILE_MB", "25")) * 1024 * 1024
MAX_ICON = int(os.environ.get("MAX_IMAGE_MB", "5")) * 1024 * 1024
ICON_TYPES = {"png": "image/png", "jpg": "image/jpeg", "gif": "image/gif",
              "webp": "image/webp", "svg": "image/svg+xml"}
DB_PATH = os.path.join(DATA_DIR, "pagevault.db")

GITHUB_API = os.environ.get("GITHUB_API", "https://api.github.com").rstrip("/")

COOKIE = "pv_session"
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{1,31}$")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
VISIBILITIES = ("private", "selected", "users", "public")

# Uploaded pages run in a sandbox with an opaque origin, so they can never
# touch the dashboard, your session cookie, or another page's data.
PAGE_CSP = ("sandbox allow-scripts allow-forms allow-popups "
            "allow-popups-to-escape-sandbox allow-modals allow-downloads")
APP_CSP = ("default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
           "script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

for ext, typ in ((".wasm", "application/wasm"), (".mjs", "text/javascript"),
                 (".js", "text/javascript"), (".webmanifest", "application/manifest+json"),
                 (".svg", "image/svg+xml"), (".json", "application/json"),
                 (".woff2", "font/woff2"), (".woff", "font/woff")):
    mimetypes.add_type(typ, ext)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pw TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0, must_change INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pages(
  id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'selected',
  entry TEXT NOT NULL, files INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS page_access(
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(page_id, user_id));
CREATE TABLE IF NOT EXISTS kv(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  k TEXT NOT NULL, v TEXT NOT NULL, updated INTEGER NOT NULL, ver INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(user_id, page_id, k));
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS page_files(
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS update_log(
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, page_id INTEGER, title TEXT NOT NULL,
  version TEXT NOT NULL, path TEXT NOT NULL, how TEXT NOT NULL);
"""


class HTTPError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code, self.msg = code, msg


# --------------------------------------------------------------------------- helpers
def db():
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    return c


def init_storage():
    for d in (DATA_DIR, PAGES_DIR, TMP_DIR, ICON_DIR, FILES_DIR):
        os.makedirs(d, exist_ok=True)
    for name in os.listdir(TMP_DIR):  # leftovers from a crash
        shutil.rmtree(os.path.join(TMP_DIR, name), ignore_errors=True)
    c = db()
    c.execute("PRAGMA journal_mode=WAL")
    c.executescript(SCHEMA)
    # upgrade databases created by earlier versions
    for table, col, ddl in (("users", "must_change", "INTEGER NOT NULL DEFAULT 0"),
                            ("kv", "ver", "INTEGER NOT NULL DEFAULT 1"),
                            ("pages", "icon", "TEXT NOT NULL DEFAULT ''"),
                            ("pages", "source_key", "TEXT NOT NULL DEFAULT ''"),
                            ("pages", "source_path", "TEXT NOT NULL DEFAULT ''"),
                            ("pages", "source_sha", "TEXT NOT NULL DEFAULT ''"),
                            ("pages", "source_version", "TEXT NOT NULL DEFAULT ''")):
        if col not in [r[1] for r in c.execute("PRAGMA table_info(%s)" % table)]:
            c.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, col, ddl))
    c.commit()
    c.close()
    key = os.path.join(DATA_DIR, "secret.key")
    if not os.path.exists(key):
        with open(key, "wb") as f:
            f.write(secrets.token_bytes(32))
        os.chmod(key, 0o600)
    with open(key, "rb") as f:
        return f.read()


SECRET = b""


def now():
    return int(time.time())


def next_ver(old):
    """Version stamp for a saved value: always increases, never reused after a delete."""
    return max((old or 0) + 1, int(time.time() * 1000))


def hash_pw(pw):
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return "scrypt$%s$%s" % (salt.hex(), h.hex())


def check_pw(pw, stored):
    try:
        _, salt, h = stored.split("$")
        calc = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2 ** 14, r=8, p=1, dklen=32)
        return hmac.compare_digest(calc.hex(), h)
    except Exception:
        return False


def b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def make_view_token(uid, pid):
    payload = "%d.%d.%d" % (uid, pid, now() + VIEW_TOKEN_HOURS * 3600)
    sig = b64(hmac.new(SECRET, payload.encode(), hashlib.sha256).digest()[:18])
    return payload + "." + sig


def parse_view_token(tok):
    """Returns (uid, pid, expired) or None if forged."""
    parts = tok.split(".")
    if len(parts) != 4 or not all(p.isdigit() for p in parts[:3]):
        return None
    payload = ".".join(parts[:3])
    good = b64(hmac.new(SECRET, payload.encode(), hashlib.sha256).digest()[:18])
    if not hmac.compare_digest(good, parts[3]):
        return None
    return int(parts[0]), int(parts[1]), int(parts[2]) < now()


def sniff_image(b):
    """Identify an image by its first bytes (never trust the file name)."""
    if b.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if b.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if b[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "webp"
    head = b[:4096].lstrip().lower()
    if head.startswith((b"<?xml", b"<svg", b"<!--")) and b"<svg" in head:
        return "svg"
    return None


def parse_multipart(ctype, body):
    """Minimal, binary-safe multipart/form-data parser -> (fields, files)."""
    m = re.search(r'boundary="?([^";]+)"?', ctype or "")
    if not m:
        raise HTTPError(400, "bad form")
    sep = b"--" + m.group(1).encode()
    fields, files = {}, {}
    for chunk in body.split(sep)[1:]:
        if chunk.startswith(b"--"):
            break
        if chunk.startswith(b"\r\n"):
            chunk = chunk[2:]
        head, _, data = chunk.partition(b"\r\n\r\n")
        if data.endswith(b"\r\n"):
            data = data[:-2]
        h = head.decode("utf-8", "replace")
        name = re.search(r'(?<![a-z])name="([^"]*)"', h)
        if not name:
            continue
        fn = re.search(r'filename="([^"]*)"', h)
        ct = re.search(r'(?im)^content-type:\s*([^\r\n;]+)', h)
        if fn:
            files[name.group(1)] = (fn.group(1), (ct.group(1).strip() if ct else "application/octet-stream"), data)
        else:
            fields[name.group(1)] = data.decode("utf-8", "replace")
    return fields, files


def usage(conn, uid, pid=None):
    """Bytes a person has saved (data + files), overall or for one app."""
    q, a = ("", (uid,)) if pid is None else (" AND page_id=?", (uid, pid))
    data = conn.execute("SELECT COALESCE(SUM(LENGTH(k)+LENGTH(v)),0) FROM kv WHERE user_id=?" + q, a).fetchone()[0]
    files = conn.execute("SELECT COALESCE(SUM(size),0) FROM page_files WHERE user_id=?" + q, a).fetchone()[0]
    return data + files


def file_path(uid, pid, fid):
    return os.path.join(FILES_DIR, str(int(uid)), str(int(pid)), fid)


def drop_files(conn, uid=None, pid=None):
    """Delete stored files for a person and/or an app (rows are removed by the caller or cascade)."""
    if uid is not None and pid is not None:
        shutil.rmtree(os.path.join(FILES_DIR, str(int(uid)), str(int(pid))), ignore_errors=True)
    elif uid is not None:
        shutil.rmtree(os.path.join(FILES_DIR, str(int(uid))), ignore_errors=True)
    elif pid is not None and os.path.isdir(FILES_DIR):
        for u in os.listdir(FILES_DIR):
            shutil.rmtree(os.path.join(FILES_DIR, u, str(int(pid))), ignore_errors=True)


SAFE_INLINE = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/heic",
               "application/pdf", "text/plain", "text/csv", "image/svg+xml"}


def remove_icon_files(pid):
    for ext in ICON_TYPES:
        try:
            os.unlink(os.path.join(ICON_DIR, "%d.%s" % (int(pid), ext)))
        except FileNotFoundError:
            pass


def strip_byline(stem):
    """'A_Better_Ledger_2026-11-11_mk5_by_SeanwithanAI' -> 'A_Better_Ledger_2026-11-11_mk5'"""
    return re.sub(r"[-_ .]+by[-_ .]+[^-_ .][^/]*$", "", stem, flags=re.I)


def pretty_name(filename):
    """'A-Better-PTO-Tracker-2026-11-11-mk2.html' -> 'A Better PTO Tracker'"""
    stem = strip_byline(os.path.splitext(os.path.basename(filename))[0])
    stem = re.sub(r"[-_ .]*\d{4}-\d{2}-\d{2}([-_ .]*mk\d+)?$", "", stem, flags=re.I)  # date version
    stem = re.sub(r"[-_ .]*(v|ver|version)?[-_ ]?\d+(\.\d+)+$", "", stem, flags=re.I)  # v1.2.3
    stem = re.sub(r"[-_ .]*(mk|rev)\d+$", "", stem, flags=re.I)
    name = re.sub(r"\s+", " ", re.sub(r"[-_]+", " ", stem)).strip()
    if name and name == name.lower():
        name = name.title()
    return name or "Untitled app"


def slugify(s):
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:64].strip("-") or "page"


def can_view(conn, user, page):
    """public: anyone | users: any signed-in person | selected: people you picked | private: admins only"""
    if page["visibility"] == "public":
        return True
    if user is None:
        return False
    if user["is_admin"] or page["visibility"] == "users":
        return True
    if page["visibility"] == "selected":
        return conn.execute("SELECT 1 FROM page_access WHERE page_id=? AND user_id=?",
                            (page["id"], user["id"])).fetchone() is not None
    return False


def page_dir(pid):
    return os.path.join(PAGES_DIR, str(int(pid)))


def get_setting(conn, k, default=""):
    r = conn.execute("SELECT v FROM settings WHERE k=?", (k,)).fetchone()
    return r["v"] if r else default


def set_setting(conn, k, v):
    conn.execute("INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, v))


def pick_entry(rels):
    lower = {r.lower(): r for r in rels}
    for name in ("index.html", "index.htm"):
        if name in lower:
            return lower[name]
    htmls = [r for r in rels if r.lower().endswith((".html", ".htm"))]
    if not htmls:
        raise HTTPError(400, "The zip has no .html file in it.")
    htmls.sort(key=lambda r: (r.count("/"), "index" not in r.lower(), r.lower()))
    return htmls[0]


def extract_zip(src, dest):
    try:
        z = zipfile.ZipFile(src)
    except zipfile.BadZipFile:
        raise HTTPError(400, "That file is not a valid zip.")
    with z:
        items = []
        for info in z.infolist():
            if info.is_dir():
                continue
            name = info.filename.replace("\\", "/")
            parts = [p for p in name.split("/") if p not in ("", ".")]
            if not parts or parts[0] == "__MACOSX" or parts[-1] == ".DS_Store" or parts[-1].startswith("._"):
                continue
            if name.startswith("/") or ".." in parts or ":" in parts[0]:
                raise HTTPError(400, "The zip contains an unsafe file path.")
            items.append((info, parts))
        if not items:
            raise HTTPError(400, "The zip is empty.")
        if len(items) > MAX_ZIP_FILES:
            raise HTTPError(400, "The zip has too many files.")
        # Strip a single wrapping folder (e.g. my-site/index.html -> index.html)
        if len({p[0] for _, p in items}) == 1 and all(len(p) > 1 for _, p in items):
            items = [(i, p[1:]) for i, p in items]
        written = 0
        for info, parts in items:
            out = os.path.join(dest, *parts)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with z.open(info) as r, open(out, "wb") as w:
                while True:
                    chunk = r.read(1 << 16)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > MAX_UNZIPPED:
                        raise HTTPError(400, "The zip is too large once unpacked.")
                    w.write(chunk)
        rels = ["/".join(p) for _, p in items]
        return pick_entry(rels), len(items), written


def inject_sdk(html, cfg, data, vers):
    boot = json.dumps({"cfg": cfg, "data": data, "vers": vers}).replace("<", "\\u003c")
    snippet = ('<script>window.__PV=%s;</script><script src="/sdk.js"></script>' % boot).encode()
    for pat in (rb"<head(?:\s[^>]*)?>", rb"<html(?:\s[^>]*)?>", rb"<!doctype[^>]*>"):
        m = re.search(pat, html[:65536], re.I)
        if m:
            return html[:m.end()] + snippet + html[m.end():]
    return snippet + html


def unique_slug(conn, base, exclude=None):
    slug, n = base, 2
    while conn.execute("SELECT 1 FROM pages WHERE slug=? AND id IS NOT ?", (slug, exclude)).fetchone():
        suffix = "-%d" % n
        slug = base[:64 - len(suffix)] + suffix
        n += 1
    return slug


def install_bundle(conn, src, ext, size, page_id=None, new=None):
    """Install an uploaded/downloaded .html or .zip as a new app (new=dict) or over page_id.
    Updates keep the link, image, access and everyone's saved data. Returns the app id."""
    staging = tempfile.mkdtemp(dir=TMP_DIR)
    try:
        if ext == ".zip":
            entry, nfiles, nbytes = extract_zip(src, staging)
        else:
            shutil.copyfile(src, os.path.join(staging, "index.html"))
            entry, nfiles, nbytes = "index.html", 1, size
        ts = now()
        if page_id:
            conn.execute("UPDATE pages SET entry=?, files=?, bytes=?, updated=? WHERE id=?",
                         (entry, nfiles, nbytes, ts, page_id))
            pid = page_id
        else:
            cur = conn.execute(
                "INSERT INTO pages(owner_id,slug,title,description,visibility,entry,files,bytes,created,updated) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (new["owner_id"], unique_slug(conn, slugify(new.get("slug") or new["title"])), new["title"],
                 new.get("description", ""), new.get("visibility", "selected"), entry, nfiles, nbytes, ts, ts))
            pid = cur.lastrowid
            for uid in new.get("access") or []:
                conn.execute("INSERT OR IGNORE INTO page_access(page_id,user_id) SELECT ?, id FROM users WHERE id=?",
                             (pid, int(uid)))
        final = page_dir(pid)
        old = None
        if os.path.exists(final):
            old = final + ".old-" + secrets.token_hex(4)
            os.rename(final, old)
        os.rename(staging, final)
        conn.commit()
        if old:
            shutil.rmtree(old, ignore_errors=True)
        return pid
    finally:
        shutil.rmtree(staging, ignore_errors=True)


# --------------------------------------------------------------------------- GitHub updates
VERSION_RE = re.compile(r"(\d{4}-\d{2}-\d{2})(?:[-_ .]*mk(\d+))?$", re.I)
UPDATE_LOCK = threading.RLock()


class UpdateError(Exception):
    pass


def parse_version(filename):
    """'A-Better-PTO-Tracker-2026-11-11-mk2.html' -> ('2026-11-11 mk2', ('2026-11-11', 2))"""
    stem = strip_byline(os.path.splitext(os.path.basename(filename))[0])
    m = VERSION_RE.search(stem)
    if not m:
        return "", ("", 0)
    mk = int(m.group(2) or 1)
    return m.group(1) + (" mk%d" % mk if m.group(2) else ""), (m.group(1), mk)


def version_key(label):
    m = re.match(r"(\d{4}-\d{2}-\d{2})(?: mk(\d+))?$", label or "")
    return (m.group(1), int(m.group(2) or 1)) if m else ("", 0)


def gh_config(conn):
    g = lambda k, d="": get_setting(conn, "gh_" + k, d)
    return {"repo": g("repo"), "repos": [r for r in g("repo").split() if r],
            "branch": g("branch", "main") or "main", "folder": g("folder"),
            "token": g("token"), "auto": g("auto", "0") == "1", "interval": int(g("interval", "60") or 60)}


GH_TOKENS_URL = "https://github.com/settings/personal-access-tokens"
TOKEN_SEEN = {}   # what GitHub last told us about the token: {"expires": ts or None, "rejected": bool}


def note_token_headers(headers):
    """GitHub sends the token's expiry date with every reply; remember it."""
    raw = headers.get("GitHub-Authentication-Token-Expiration") if headers else None
    if raw:
        try:
            TOKEN_SEEN["expires"] = calendar.timegm(time.strptime(raw.replace(" UTC", "").strip(), "%Y-%m-%d %H:%M:%S"))
        except ValueError:
            pass


def gh_request(cfg, path, raw=False):
    req = urllib.request.Request(GITHUB_API + path, headers={
        "Authorization": "Bearer " + cfg["token"],
        "Accept": "application/vnd.github.raw+json" if raw else "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "PageVault"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            note_token_headers(r.headers)
            TOKEN_SEEN["rejected"] = False
            return r.read()
    except urllib.error.HTTPError as e:
        note_token_headers(e.headers)
        if e.code == 401:
            TOKEN_SEEN["rejected"] = True
        raise UpdateError({
            401: "GitHub rejected the token. It may have expired - create a new one.",
            403: "The token isn't allowed to read this repo. Check its repository access and 'Contents: Read'.",
            404: "Repo or branch not found. Check the spelling, and that the token has access to this repo.",
        }.get(e.code, "GitHub returned error %d." % e.code))
    except (urllib.error.URLError, OSError) as e:
        raise UpdateError("Can't reach GitHub (%s)." % getattr(e, "reason", e))


def repo_versions(cfg):
    """Group every .html/.zip in the repo(s) by app name, newest version first."""
    folder = cfg["folder"].strip("/")
    groups = {}
    for repo in cfg["repos"]:
        try:
            tree = json.loads(gh_request(cfg, "/repos/%s/git/trees/%s?recursive=1" % (
                repo, urllib.parse.quote(cfg["branch"], safe=""))))
        except UpdateError as e:
            raise UpdateError("%s: %s" % (repo, e))
        collect_versions(repo, tree, folder, groups)
    for g in groups.values():
        g["versions"].sort(key=lambda v: (v["vkey"], v["path"]), reverse=True)
    return sorted(groups.values(), key=lambda g: g["name"].lower())


def collect_versions(repo, tree, folder, groups):
    for item in tree.get("tree", []):
        path = item.get("path", "")
        if item.get("type") != "blob" or not path.lower().endswith((".html", ".htm", ".zip")):
            continue
        if folder and not path.startswith(folder + "/"):
            continue
        name = pretty_name(path)
        label, vkey = parse_version(path)
        g = groups.setdefault(name.lower(), {"key": name.lower(), "name": name, "versions": []})
        g["versions"].append({"repo": repo, "path": path, "sha": item["sha"], "version": label or item["sha"][:7],
                              "vkey": vkey, "size": item.get("size", 0)})


def linked_app(conn, key, name):
    r = conn.execute("SELECT * FROM pages WHERE source_key=? ORDER BY id LIMIT 1", (key,)).fetchone()
    if r:
        return r
    return conn.execute("SELECT * FROM pages WHERE source_key='' AND (lower(title)=? OR slug=?) ORDER BY id LIMIT 1",
                        (key, slugify(name))).fetchone()


def build_report(conn, groups):
    report = []
    for g in groups:
        latest = g["versions"][0]
        app = linked_app(conn, g["key"], g["name"])
        status = "new"
        if app:
            if app["source_sha"] == latest["sha"]:
                status = "current"
            elif not app["source_sha"] and app["source_version"] and \
                    version_key(app["source_version"]) >= latest["vkey"] > ("", 0):
                status = "current"
            else:
                status = "update"
        report.append({
            "key": g["key"], "name": g["name"], "status": status,
            "latest": {k: latest[k] for k in ("repo", "path", "sha", "version")},
            "versions": [{k: v[k] for k in ("repo", "path", "sha", "version")} for v in g["versions"]],
            "app": {"id": app["id"], "title": app["title"],
                    "version": app["source_version"] or "unknown"} if app else None})
    return report


def install_from_repo(conn, cfg, group_key, sha, page_id=None, owner_id=None, how="manual"):
    """Download one version from GitHub and install it (as an update, or as a new hidden app)."""
    groups = {g["key"]: g for g in repo_versions(cfg)}
    g = groups.get(group_key)
    ver = next((v for v in (g["versions"] if g else []) if v["sha"] == sha), None)
    if not ver:
        raise UpdateError("That version is no longer in the repo. Check again.")
    data = gh_request(cfg, "/repos/%s/git/blobs/%s" % (ver["repo"], sha), raw=True)
    ext = os.path.splitext(ver["path"].lower())[1]
    if ext == ".htm":
        ext = ".html"
    fd, tmp = tempfile.mkstemp(dir=TMP_DIR)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    try:
        if page_id is None:
            app = linked_app(conn, g["key"], g["name"])
            page_id = app["id"] if app else None
        new = None if page_id else {"owner_id": owner_id, "title": g["name"], "visibility": "private"}
        pid = install_bundle(conn, tmp, ext, len(data), page_id=page_id, new=new)
    finally:
        os.unlink(tmp)
    conn.execute("UPDATE pages SET source_key=?, source_path=?, source_sha=?, source_version=? WHERE id=?",
                 (g["key"], ver["path"], sha, ver["version"], pid))
    title = conn.execute("SELECT title FROM pages WHERE id=?", (pid,)).fetchone()[0]
    conn.execute("INSERT INTO update_log(ts,page_id,title,version,path,how) VALUES(?,?,?,?,?,?)",
                 (now(), pid, title, ver["version"], ver["path"], "new" if new else how))
    conn.execute("DELETE FROM update_log WHERE id NOT IN (SELECT id FROM update_log ORDER BY id DESC LIMIT 100)")
    conn.commit()
    return pid


def run_update_check(conn, auto_install):
    """Check GitHub; when auto_install, install every available update for apps already linked."""
    cfg = gh_config(conn)
    if not cfg["repos"] or not cfg["token"]:
        raise UpdateError("Add your repo and token first.")
    with UPDATE_LOCK:
        set_setting(conn, "gh_last_check", str(now()))
        TOKEN_SEEN.clear()
        try:
            groups = repo_versions(cfg)
            installed = []
            if auto_install:
                for item in build_report(conn, groups):
                    if item["status"] == "update":
                        install_from_repo(conn, cfg, item["key"], item["latest"]["sha"],
                                          page_id=item["app"]["id"], how="auto")
                        installed.append(item["name"])
            report = build_report(conn, groups)
            set_setting(conn, "gh_last_error", "")
            set_setting(conn, "gh_report", json.dumps(report))
            save_token_state(conn)
            conn.commit()
            return report, installed
        except UpdateError as e:
            set_setting(conn, "gh_last_error", str(e))
            save_token_state(conn)
            conn.commit()
            raise


def save_token_state(conn):
    if "expires" in TOKEN_SEEN:
        set_setting(conn, "gh_token_expires", str(TOKEN_SEEN["expires"]))
    if "rejected" in TOKEN_SEEN:
        set_setting(conn, "gh_token_rejected", "1" if TOKEN_SEEN["rejected"] else "0")


def token_alert(conn, ignore_snooze=False):
    """None, or what to warn the admin about: the GitHub token is expiring, expired or rejected."""
    if not get_setting(conn, "gh_token"):
        return None
    expires = int(get_setting(conn, "gh_token_expires", "0") or 0)
    rejected = get_setting(conn, "gh_token_rejected", "0") == "1"
    t = now()
    if expires and expires <= t:
        state = "expired"                      # past the date GitHub gave us
    elif rejected:
        state = "rejected"                     # GitHub refused it (expired early, deleted or regenerated)
    elif expires and expires - t <= 7 * 86400:
        state = "expiring"                     # a week's warning
    else:
        return None
    if not ignore_snooze and int(get_setting(conn, "gh_alert_snooze", "0") or 0) > t:
        return None
    return {"state": state, "expires": expires or None,
            "days_left": max(0, (expires - t) // 86400) if expires else None,
            "github_url": GH_TOKENS_URL}


def update_loop():
    """Background: every few minutes, see whether an automatic check is due."""
    while True:
        time.sleep(60)
        conn = None
        try:
            conn = db()
            cfg = gh_config(conn)
            last = int(get_setting(conn, "gh_last_check", "0") or 0)
            if cfg["auto"] and cfg["repos"] and cfg["token"] and now() - last >= max(5, cfg["interval"]) * 60:
                _, installed = run_update_check(conn, auto_install=True)
                if installed:
                    print("Auto-updated: %s" % ", ".join(installed), flush=True)
        except UpdateError as e:
            print("Update check failed: %s" % e, flush=True)
        except Exception:
            traceback.print_exc()
        finally:
            if conn:
                conn.close()


LOGIN_FAILS = {}
LOGIN_LOCK = threading.Lock()


def too_many_fails(ip):
    with LOGIN_LOCK:
        recent = [t for t in LOGIN_FAILS.get(ip, []) if t > time.time() - 300]
        LOGIN_FAILS[ip] = recent
        return len(recent) >= 10


def record_fail(ip):
    with LOGIN_LOCK:
        LOGIN_FAILS.setdefault(ip, []).append(time.time())


# --------------------------------------------------------------------------- handler
class Handler(BaseHTTPRequestHandler):
    server_version = "PageVault/1.0"
    sys_version = ""

    def log_message(self, fmt, *args):
        sys.stdout.write("%s %s\n" % (self.address_string(), fmt % args))

    # ---- verbs
    def do_GET(self): self.dispatch("GET")
    def do_HEAD(self): self.dispatch("HEAD")
    def do_POST(self): self.dispatch("POST")
    def do_PUT(self): self.dispatch("PUT")
    def do_PATCH(self): self.dispatch("PATCH")
    def do_DELETE(self): self.dispatch("DELETE")
    def do_OPTIONS(self): self.dispatch("OPTIONS")

    def dispatch(self, method):
        self.extra_headers = {}
        self.conn = None
        self.form_rid = None
        try:
            u = urllib.parse.urlsplit(self.path)
            self.query = u.query
            self.qs = urllib.parse.parse_qs(u.query)
            self.conn = db()
            self.route(method, u.path)
        except HTTPError as e:
            self.send_json({"error": e.msg}, e.code)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            try:
                self.send_json({"error": "Internal server error"}, 500)
            except Exception:
                pass
        finally:
            if self.conn:
                self.conn.close()

    # ---- responses
    def respond(self, code, body=b"", ctype="text/plain; charset=utf-8", headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in {**self.extra_headers, **(headers or {})}.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, obj, code=200, headers=None):
        rid = getattr(self, "form_rid", None)
        if rid:  # request came from the form fallback: hand the answer to the app with postMessage
            page = ('<!doctype html><meta charset="utf-8"><script>parent.postMessage({pvForm:%s,status:%d,body:%s},"*")</script>'
                    % (json.dumps(rid), code, json.dumps(obj).replace("<", "\\u003c"))).encode()
            return self.respond(200, page, "text/html; charset=utf-8",
                                {"Content-Security-Policy": "sandbox allow-scripts", "Cache-Control": "no-store"})
        self.respond(code, json.dumps(obj).encode(), "application/json", headers)

    def form_mode(self):
        """Set up the form fallback (used when a browser blocks fetch(), e.g. Brave on iPhone)."""
        self.form_rid = None
        if self.q("via") == "form" and re.fullmatch(r"[A-Za-z0-9_]{1,48}", self.q("rid") or ""):
            self.form_rid = self.q("rid")
        return self.form_rid

    def redirect(self, location, code=302):
        self.respond(code, b"", headers={"Location": location, "Cache-Control": "no-store"})

    def not_found(self):
        self.respond(404, b"Not found", headers={"Cache-Control": "no-store"})

    def send_static(self, rel):
        path = os.path.realpath(os.path.join(STATIC_DIR, rel))
        if not path.startswith(STATIC_DIR + os.sep) or not os.path.isfile(path):
            return self.not_found()
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        with open(path, "rb") as f:
            body = f.read()
        self.respond(200, body, ctype, {"Cache-Control": "no-cache", "Content-Security-Policy": APP_CSP,
                                        "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin"})

    # ---- request input
    def body_length(self, limit):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise HTTPError(400, "Bad Content-Length")
        if n > limit:
            raise HTTPError(413, "Too large (limit %d MB)" % (limit // 1048576))
        return n

    def read_body(self, limit=1 << 20):
        n = self.body_length(limit)
        return self.rfile.read(n) if n else b""

    def read_json(self, limit=1 << 20):
        raw = self.read_body(limit)
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            raise HTTPError(400, "Invalid JSON")

    def body_to_tempfile(self, limit):
        n = self.body_length(limit)
        if not n:
            raise HTTPError(400, "Empty upload")
        fd, path = tempfile.mkstemp(dir=TMP_DIR)
        with os.fdopen(fd, "wb") as f:
            left = n
            while left:
                chunk = self.rfile.read(min(left, 1 << 16))
                if not chunk:
                    break
                f.write(chunk)
                left -= len(chunk)
        return path, n

    def q(self, k):
        return (self.qs.get(k) or [""])[0]

    # ---- auth
    def current_user(self):
        raw = self.headers.get("Cookie") or ""
        tok = None
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE:
                tok = v
        if not tok:
            return None
        h = hashlib.sha256(tok.encode()).hexdigest()
        return self.conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?",
            (h, now())).fetchone()

    def start_session(self, uid):
        tok = secrets.token_urlsafe(32)
        self.conn.execute("DELETE FROM sessions WHERE expires<?", (now(),))
        self.conn.execute("INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)",
                          (hashlib.sha256(tok.encode()).hexdigest(), uid, now() + SESSION_DAYS * 86400))
        self.conn.commit()
        cookie = "%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d" % (COOKIE, tok, SESSION_DAYS * 86400)
        if COOKIE_SECURE:
            cookie += "; Secure"
        self.extra_headers["Set-Cookie"] = cookie

    # ---- routing
    def route(self, method, path):
        if path == "/healthz":
            return self.respond(200, b"ok")
        if path.startswith("/v/"):
            return self.route_view(method, path)
        if path.startswith("/a/"):
            return self.route_public(method, path)
        if path.startswith("/api/"):
            return self.route_api(method, path)
        if method not in ("GET", "HEAD"):
            raise HTTPError(405, "Method not allowed")
        if path == "/sdk.js":
            return self.send_static("sdk.js")
        if path.startswith("/static/"):
            return self.send_static(path[len("/static/"):])
        m = re.fullmatch(r"/icon/(\d+)", path)
        if m:
            return self.serve_icon(int(m.group(1)))
        if path == "/favicon.ico":
            return self.send_static("favicon.svg")
        if path in ("/login", "/login/"):
            return self.send_static("login.html")
        if path == "/":
            if not self.current_user():
                return self.redirect("/login")
            return self.send_static("app.html")
        return self.not_found()

    # ---- page viewing
    PAGE_SELECT = "SELECT p.*, u.username AS owner FROM pages p LEFT JOIN users u ON u.id=p.owner_id "

    def page_by_slug(self, slug):
        return self.conn.execute(self.PAGE_SELECT + "WHERE p.slug=?", (slug,)).fetchone()

    def page_by_id(self, pid):
        return self.conn.execute(self.PAGE_SELECT + "WHERE p.id=?", (pid,)).fetchone()

    def serve_icon(self, pid):
        page = self.page_by_id(pid)
        if not page or not page["icon"] or not can_view(self.conn, self.current_user(), page):
            return self.not_found()
        ext = page["icon"].split(".")[0]
        try:
            with open(os.path.join(ICON_DIR, "%d.%s" % (pid, ext)), "rb") as f:
                body = f.read()
        except FileNotFoundError:
            return self.not_found()
        self.respond(200, body, ICON_TYPES.get(ext, "application/octet-stream"), {
            "Cache-Control": "private, max-age=31536000, immutable",  # URL changes when the image does
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        })

    def route_public(self, method, path):
        if method not in ("GET", "HEAD"):
            raise HTTPError(405, "Method not allowed")
        m = re.fullmatch(r"/a/([^/]+)(/.*)?", path)
        if not m:
            return self.not_found()
        slug, rest = m.groups()
        page = self.page_by_slug(slug)
        if not page:
            return self.not_found()
        qs = ("?" + self.query) if self.query else ""
        if rest is None:
            return self.redirect(path + "/" + qs, 301)
        rel = rest[1:]
        viewer = self.current_user()
        if viewer and viewer["must_change"]:
            return self.redirect("/")
        if viewer and can_view(self.conn, viewer, page):
            tok = make_view_token(viewer["id"], page["id"])
            return self.redirect("/v/%s/%s%s" % (tok, rel, qs))
        if page["visibility"] == "public":
            return self.serve_page_file(page, rel, None, None)
        if not viewer:
            return self.redirect("/login?next=" + urllib.parse.quote(path + qs))
        return self.not_found()

    def route_view(self, method, path):
        m = re.fullmatch(r"/v/([^/]+)(/.*)?", path)
        if not m:
            return self.not_found()
        token, rest = m.groups()
        tok = parse_view_token(token)
        if rest is None:
            return self.redirect(path + "/")
        rel = rest[1:]
        if rel == "__store__" or rel.startswith("__store__/"):
            self.form_mode()
            return self.route_store(method, tok, rel[len("__store__"):].lstrip("/"))
        if rel == "__files__" or rel.startswith("__files__/"):
            if self.form_mode() and method == "POST" and self.q("_method") == "DELETE":
                method = "DELETE"
            return self.route_files(method, tok, rel[len("__files__"):].lstrip("/"))
        if method not in ("GET", "HEAD"):
            raise HTTPError(405, "Method not allowed")
        if not tok:
            return self.not_found()
        uid, pid, expired = tok
        page = self.page_by_id(pid)
        if not page:
            return self.not_found()
        if expired:  # bounce through /a/ to get a fresh link
            qs = ("?" + self.query) if self.query else ""
            return self.redirect("/a/%s/%s%s" % (page["slug"], rel, qs))
        viewer = self.conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not viewer or not can_view(self.conn, viewer, page):
            return self.not_found()
        self.serve_page_file(page, rel, token, viewer)

    def serve_page_file(self, page, rel, token, viewer):
        base = os.path.realpath(page_dir(page["id"]))
        rel = urllib.parse.unquote(rel)
        if rel == "" and page["entry"] != "index.html":
            return self.redirect(urllib.parse.quote(page["entry"]))
        path = os.path.realpath(os.path.join(base, rel))
        if path != base and not path.startswith(base + os.sep):
            return self.not_found()
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")
        if not os.path.isfile(path):
            return self.not_found()
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            body = f.read()
        if ctype == "text/html":
            data, vers = {}, {}
            if token:
                rows = self.conn.execute("SELECT k, v, ver FROM kv WHERE user_id=? AND page_id=?",
                                         (viewer["id"], page["id"])).fetchall()
                data = {r["k"]: r["v"] for r in rows}
                vers = {r["k"]: r["ver"] for r in rows}
            cfg = {"persist": bool(token),
                   "store": "/v/%s/__store__" % token if token else None,
                   "files": "/v/%s/__files__" % token if token else None,
                   "user": viewer["username"] if viewer else None,
                   "page": page["slug"],
                   "home": "/a/%s/" % page["slug"]}
            body = inject_sdk(body, cfg, data, vers)
        if ctype.startswith("text/") or ctype.endswith("javascript") or ctype.endswith("json"):
            ctype += "; charset=utf-8"
        self.respond(200, body, ctype, {
            "Content-Security-Policy": PAGE_CSP,
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store" if ctype.startswith("text/html") else "no-cache",
        })

    # ---- per-user files (attachments) saved by an app, e.g. receipts
    def route_files(self, method, tok, fid):
        self.extra_headers.update({
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Filename",
            "Access-Control-Max-Age": "86400",
        })
        if method == "OPTIONS":
            return self.respond(204)
        if not tok:
            raise HTTPError(401, "invalid")
        uid, pid, expired = tok
        if expired:
            raise HTTPError(401, "expired")
        page = self.page_by_id(pid)
        viewer = self.conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not page or not viewer or viewer["must_change"] or not can_view(self.conn, viewer, page):
            raise HTTPError(403, "forbidden")
        c = self.conn
        if fid and not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", fid):
            raise HTTPError(404, "not found")
        if method == "POST" and not fid and (self.headers.get("Content-Type") or "").startswith("multipart/form-data"):
            _, files = parse_multipart(self.headers.get("Content-Type"), self.read_body(MAX_FILE + 65536))
            if "file" not in files or not files["file"][2]:
                raise HTTPError(400, "empty file")
            name, ctype, data = files["file"]
            if len(data) > MAX_FILE:
                raise HTTPError(413, "file too large")
            if usage(c, uid) + len(data) > STORE_QUOTA:
                raise HTTPError(413, "storage quota exceeded")
            fid = secrets.token_urlsafe(12)
            name = (self.q("name") or name or "file")[:200]
            ctype = (ctype or "application/octet-stream").lower()[:100]
            dest = file_path(uid, pid, fid)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as f:
                f.write(data)
            c.execute("INSERT INTO page_files(id,user_id,page_id,name,type,size,created) VALUES(?,?,?,?,?,?,?)",
                      (fid, uid, pid, name, ctype, len(data), now()))
            c.commit()
            return self.send_json({"id": fid, "name": name, "type": ctype, "size": len(data)})
        if method == "POST" and not fid:
            n = self.body_length(MAX_FILE)
            if not n:
                raise HTTPError(400, "empty file")
            if usage(c, uid) + n > STORE_QUOTA:
                raise HTTPError(413, "storage quota exceeded")
            fid = secrets.token_urlsafe(12)
            name = urllib.parse.unquote(self.headers.get("X-Filename") or "file")[:200]
            ctype = (self.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip().lower()[:100]
            dest = file_path(uid, pid, fid)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest + ".part", "wb") as f:
                left = n
                while left:
                    chunk = self.rfile.read(min(left, 1 << 16))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
            if left:
                os.unlink(dest + ".part")
                raise HTTPError(400, "upload interrupted")
            os.rename(dest + ".part", dest)
            c.execute("INSERT INTO page_files(id,user_id,page_id,name,type,size,created) VALUES(?,?,?,?,?,?,?)",
                      (fid, uid, pid, name, ctype, n, now()))
            c.commit()
            return self.send_json({"id": fid, "name": name, "type": ctype, "size": n})
        row = c.execute("SELECT * FROM page_files WHERE id=? AND user_id=? AND page_id=?", (fid, uid, pid)).fetchone()
        if not row:
            raise HTTPError(404, "not found")
        if method == "DELETE":
            c.execute("DELETE FROM page_files WHERE id=?", (fid,))
            c.commit()
            try:
                os.unlink(file_path(uid, pid, fid))
            except FileNotFoundError:
                pass
            return self.send_json({"ok": True})
        if method not in ("GET", "HEAD"):
            raise HTTPError(405, "Method not allowed")
        try:
            with open(file_path(uid, pid, fid), "rb") as f:
                body = f.read()
        except FileNotFoundError:
            raise HTTPError(404, "not found")
        ctype = row["type"] if row["type"] in SAFE_INLINE else "application/octet-stream"
        disp = "inline" if ctype in SAFE_INLINE else "attachment"
        headers = {"Content-Disposition": "%s; filename*=UTF-8''%s" % (disp, urllib.parse.quote(row["name"])),
                   "Cache-Control": "private, max-age=86400", "Referrer-Policy": "no-referrer"}
        if ctype != "application/pdf":  # PDFs need the browser's viewer; everything else is sandboxed
            headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"
        self.respond(200, body, ctype, headers)

    # ---- per-user page storage (called by sdk.js from inside the sandboxed page)
    def route_store(self, method, tok, key):
        self.extra_headers.update({
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400",
            "Cache-Control": "no-store",
        })
        if method == "OPTIONS":
            return self.respond(204)
        if not tok:
            raise HTTPError(401, "invalid")
        uid, pid, expired = tok
        if expired:
            raise HTTPError(401, "expired")
        page = self.page_by_id(pid)
        viewer = self.conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not page or not viewer or viewer["must_change"] or not can_view(self.conn, viewer, page):
            raise HTTPError(403, "forbidden")
        key = urllib.parse.unquote(key)
        if len(key) > 512:
            raise HTTPError(400, "key too long")
        c, ts = self.conn, now()

        if method in ("GET", "HEAD"):
            if not key:
                rows = c.execute("SELECT k, v FROM kv WHERE user_id=? AND page_id=?", (uid, pid)).fetchall()
                return self.send_json({r["k"]: r["v"] for r in rows})
            r = c.execute("SELECT v FROM kv WHERE user_id=? AND page_id=? AND k=?", (uid, pid, key)).fetchone()
            if not r:
                raise HTTPError(404, "not found")
            return self.respond(200, r["v"].encode(), "text/plain; charset=utf-8")

        if method == "PUT" and key:
            value = self.read_body(MAX_VALUE).decode("utf-8", "replace")
            ops = {"set": {key: value}}
        elif method == "DELETE":
            ops = {"remove": [key]} if key else {"clear": True}
        elif method == "POST" and not key:
            if (self.headers.get("Content-Type") or "").startswith("multipart/form-data"):
                fields, _ = parse_multipart(self.headers.get("Content-Type"), self.read_body(MAX_VALUE * 4))
                try:
                    ops = json.loads(fields.get("pv_body") or "{}")
                except ValueError:
                    raise HTTPError(400, "Invalid JSON")
            else:
                ops = self.read_json(MAX_VALUE * 4)
            if not isinstance(ops, dict):
                raise HTTPError(400, "bad batch")
        else:
            raise HTTPError(405, "Method not allowed")

        # Conflict protection: if the app says which version it last saw ("base"), refuse
        # the write when the server copy has changed since (another tab/device saved first).
        c.execute("BEGIN IMMEDIATE")
        base = ops.get("base")
        if isinstance(base, dict):
            touched = set(map(str, (ops.get("set") or {}).keys())) | set(map(str, ops.get("remove") or []))
            current = {r["k"]: r["ver"] for r in c.execute(
                "SELECT k, ver FROM kv WHERE user_id=? AND page_id=?", (uid, pid))}
            conflicts = [k for k in touched if current.get(k, 0) != int(base.get(k, 0) or 0)]
            if conflicts:
                c.rollback()
                return self.send_json({"error": "conflict", "conflicts": conflicts[:50]}, 409)
        if ops.get("clear"):
            c.execute("DELETE FROM kv WHERE user_id=? AND page_id=?", (uid, pid))
        for k in ops.get("remove") or []:
            c.execute("DELETE FROM kv WHERE user_id=? AND page_id=? AND k=?", (uid, pid, str(k)[:512]))
        new_vers = {}
        for k, v in (ops.get("set") or {}).items():
            k = str(k)[:512]
            v = v if isinstance(v, str) else json.dumps(v)
            if len(v) > MAX_VALUE:
                c.rollback()
                raise HTTPError(413, "value too large")
            old = c.execute("SELECT ver FROM kv WHERE user_id=? AND page_id=? AND k=?", (uid, pid, k)).fetchone()
            ver = next_ver(old[0] if old else 0)
            c.execute("INSERT INTO kv(user_id,page_id,k,v,updated,ver) VALUES(?,?,?,?,?,?) "
                      "ON CONFLICT(user_id,page_id,k) DO UPDATE SET v=excluded.v, updated=excluded.updated, "
                      "ver=excluded.ver", (uid, pid, k, v, ts, ver))
            new_vers[k] = ver
        used = usage(c, uid)
        if used > STORE_QUOTA:
            c.rollback()
            raise HTTPError(413, "storage quota exceeded")
        c.commit()
        self.send_json({"ok": True, "vers": new_vers})

    # ---- dashboard API
    def route_api(self, method, path):
        if method not in ("GET", "HEAD"):
            # CSRF protection: custom header + same-origin check
            if self.headers.get("X-PV") != "1":
                raise HTTPError(403, "Missing X-PV header")
            origin = self.headers.get("Origin")
            if origin and urllib.parse.urlsplit(origin).netloc != self.headers.get("Host"):
                raise HTTPError(403, "Cross-origin request refused")
        c = self.conn

        if path == "/api/me":
            u = self.current_user()
            users = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            return self.send_json({
                "user": {"id": u["id"], "username": u["username"], "is_admin": bool(u["is_admin"]),
                         "must_change": bool(u["must_change"])} if u else None,
                "first_run": users == 0,
                "registration_open": users == 0 or get_setting(c, "registration_open", "0") == "1",
                "token_alert": token_alert(c) if u and u["is_admin"] and not u["must_change"] else None,
                "version": VERSION,
            })

        if path == "/api/login" and method == "POST":
            ip = self.client_address[0]
            if too_many_fails(ip):
                raise HTTPError(429, "Too many attempts. Try again in a few minutes.")
            d = self.read_json()
            u = c.execute("SELECT * FROM users WHERE username=?",
                          (str(d.get("username", "")).strip().lower(),)).fetchone()
            if not u or not check_pw(str(d.get("password", "")), u["pw"]):
                record_fail(ip)
                raise HTTPError(401, "Wrong username or password.")
            self.start_session(u["id"])
            return self.send_json({"ok": True})

        if path == "/api/register" and method == "POST":
            d = self.read_json()
            count = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            if count and get_setting(c, "registration_open", "0") != "1":
                raise HTTPError(403, "Sign-ups are closed. Ask the admin for an account.")
            uid = self.create_user(d.get("username"), d.get("password"), is_admin=(count == 0))
            self.start_session(uid)
            return self.send_json({"ok": True})

        if path == "/api/logout" and method == "POST":
            raw = self.headers.get("Cookie") or ""
            for part in raw.split(";"):
                k, _, v = part.strip().partition("=")
                if k == COOKIE:
                    c.execute("DELETE FROM sessions WHERE token=?", (hashlib.sha256(v.encode()).hexdigest(),))
                    c.commit()
            self.extra_headers["Set-Cookie"] = "%s=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" % COOKIE
            return self.send_json({"ok": True})

        user = self.current_user()
        if not user:
            raise HTTPError(401, "Please sign in.")
        if user["must_change"] and path != "/api/account/password":
            raise HTTPError(403, "Please choose a new password first.")

        # ---- everyone: the app launcher
        if path == "/api/apps" and method in ("GET", "HEAD"):
            return self.api_list_apps(user)

        m = re.fullmatch(r"/api/apps/(\d+)/data", path)
        if m:
            page = self.page_by_id(int(m.group(1)))
            if not page or not can_view(self.conn, user, page):
                raise HTTPError(404, "App not found")
            return self.api_page_data(method, user, page)

        if path == "/api/account/password" and method == "POST":
            d = self.read_json()
            # right after signing in with a temporary password we don't ask for it again
            if not user["must_change"] and not check_pw(str(d.get("current", "")), user["pw"]):
                raise HTTPError(400, "Current password is wrong.")
            if check_pw(str(d.get("new", "")), user["pw"]):
                raise HTTPError(400, "Pick a password different from your current one.")
            self.set_password(user["id"], d.get("new"))
            return self.send_json({"ok": True})

        if path.startswith("/api/admin/"):
            if not user["is_admin"]:
                raise HTTPError(403, "Admins only")
            return self.route_admin(method, path, user)

        raise HTTPError(404, "Unknown API endpoint")

    def create_user(self, username, password, is_admin=False, must_change=False):
        username = str(username or "").strip().lower()
        if not USERNAME_RE.match(username):
            raise HTTPError(400, "Username must be 2-32 characters: letters, numbers, dot, dash or underscore.")
        password = str(password or "")
        if len(password) < 8:
            raise HTTPError(400, "Password must be at least 8 characters.")
        try:
            cur = self.conn.execute("INSERT INTO users(username,pw,is_admin,must_change,created) VALUES(?,?,?,?,?)",
                                    (username, hash_pw(password), 1 if is_admin else 0, 1 if must_change else 0, now()))
        except sqlite3.IntegrityError:
            raise HTTPError(409, "That username is taken.")
        self.conn.commit()
        return cur.lastrowid

    def set_password(self, uid, password, must_change=False):
        password = str(password or "")
        if len(password) < 8:
            raise HTTPError(400, "Password must be at least 8 characters.")
        self.conn.execute("UPDATE users SET pw=?, must_change=? WHERE id=?",
                          (hash_pw(password), 1 if must_change else 0, uid))
        self.conn.commit()

    def page_json(self, p, user, admin=False):
        keys = self.conn.execute("SELECT COUNT(*) FROM kv WHERE user_id=? AND page_id=?",
                                 (user["id"], p["id"])).fetchone()[0]
        used = (usage(self.conn, user["id"], p["id"]), keys)
        d = {"id": p["id"], "title": p["title"], "slug": p["slug"], "description": p["description"],
             "visibility": p["visibility"], "files": p["files"], "bytes": p["bytes"],
             "created": p["created"], "updated": p["updated"], "url": "/a/%s/" % p["slug"],
             "data_bytes": used[0], "data_keys": used[1],
             "icon": "/icon/%d?v=%s" % (p["id"], p["icon"].split(".")[-1]) if p["icon"] else None}
        if admin:
            d["uploaded_by"] = p["owner"]
            d["entry"] = p["entry"]
            d["version"] = p["source_version"]
            d["access"] = [r[0] for r in self.conn.execute(
                "SELECT user_id FROM page_access WHERE page_id=?", (p["id"],))]
        return d

    def api_list_apps(self, user):
        rows = self.conn.execute(self.PAGE_SELECT + "ORDER BY p.title COLLATE NOCASE").fetchall()
        apps = [self.page_json(p, user) for p in rows if can_view(self.conn, user, p)]
        used = usage(self.conn, user["id"])
        self.send_json({"apps": apps, "storage": {"used": used, "quota": STORE_QUOTA}})

    def unique_slug(self, base, exclude=None):
        return unique_slug(self.conn, base, exclude)

    def set_access(self, pid, user_ids):
        self.conn.execute("DELETE FROM page_access WHERE page_id=?", (pid,))
        for uid in user_ids:
            self.conn.execute("INSERT OR IGNORE INTO page_access(page_id,user_id) "
                              "SELECT ?, id FROM users WHERE id=?", (pid, int(uid)))

    def api_upload(self, user):
        fname = urllib.parse.unquote(self.headers.get("X-Filename") or "")
        ext = os.path.splitext(fname.lower())[1]
        if ext not in (".html", ".htm", ".zip"):
            raise HTTPError(400, "Upload an .html file or a .zip of your site.")
        replace = self.q("replace")
        page = None
        if replace:
            page = self.page_by_id(int(replace)) if replace.isdigit() else None
            if not page:
                raise HTTPError(404, "App not found")
        vis = self.q("visibility") or "selected"
        if vis not in VISIBILITIES:
            raise HTTPError(400, "Bad visibility")
        try:
            access = [int(x) for x in self.q("access").split(",") if x.strip()]
        except ValueError:
            raise HTTPError(400, "Bad access list")
        upload, size = self.body_to_tempfile(MAX_UPLOAD)
        try:
            new = None
            if not page:
                new = {"owner_id": user["id"], "title": (self.q("title").strip() or pretty_name(fname))[:120],
                       "slug": self.q("slug"), "description": self.q("description").strip()[:300],
                       "visibility": vis, "access": access}
            pid = install_bundle(self.conn, upload, ext if ext != ".htm" else ".html", size,
                                 page_id=page["id"] if page else None, new=new)
            # remember which file this came from, so GitHub updates can find it later
            label, _ = parse_version(fname)
            key = (page["source_key"] if page and page["source_key"] else "") or pretty_name(fname).lower()
            self.conn.execute("UPDATE pages SET source_key=?, source_path=?, source_sha='', source_version=? "
                              "WHERE id=?", (key, fname, label, pid))
            self.conn.commit()
            self.send_json(self.page_json(self.page_by_id(pid), user, admin=True))
        finally:
            os.unlink(upload)

    def api_edit_page(self, user, page):
        d = self.read_json()
        title, slug, vis, desc = page["title"], page["slug"], page["visibility"], page["description"]
        if "title" in d:
            title = str(d["title"]).strip()[:120] or title
        if "description" in d:
            desc = str(d["description"]).strip()[:300]
        if "visibility" in d:
            if d["visibility"] not in VISIBILITIES:
                raise HTTPError(400, "Bad visibility")
            vis = d["visibility"]
        if "slug" in d:
            slug = str(d["slug"]).strip().lower()
            if not SLUG_RE.match(slug):
                raise HTTPError(400, "Link name can use lowercase letters, numbers and dashes.")
            if self.unique_slug(slug, page["id"]) != slug:
                raise HTTPError(409, "Another app already uses that link.")
        self.conn.execute("UPDATE pages SET title=?, slug=?, description=?, visibility=?, updated=? WHERE id=?",
                          (title, slug, desc, vis, now(), page["id"]))
        if isinstance(d.get("access"), list):
            self.set_access(page["id"], d["access"])
        self.conn.commit()
        self.send_json(self.page_json(self.page_by_id(page["id"]), user, admin=True))

    def api_page_data(self, method, user, page):
        c, uid, pid = self.conn, user["id"], page["id"]
        if method in ("GET", "HEAD"):
            rows = c.execute("SELECT k, v FROM kv WHERE user_id=? AND page_id=? ORDER BY k", (uid, pid)).fetchall()
            body = json.dumps({r["k"]: r["v"] for r in rows}, indent=2).encode()
            return self.respond(200, body, "application/json", {
                "Content-Disposition": 'attachment; filename="%s-data.json"' % page["slug"]})
        if method == "DELETE":
            c.execute("DELETE FROM kv WHERE user_id=? AND page_id=?", (uid, pid))
            c.execute("DELETE FROM page_files WHERE user_id=? AND page_id=?", (uid, pid))
            c.commit()
            drop_files(c, uid=uid, pid=pid)
            return self.send_json({"ok": True})
        if method == "POST":  # import (replaces everything)
            d = self.read_json(MAX_UPLOAD)
            if not isinstance(d, dict):
                raise HTTPError(400, "Import file must be a JSON object of key/value pairs.")
            c.execute("DELETE FROM kv WHERE user_id=? AND page_id=?", (uid, pid))
            ts = now()
            for k, v in d.items():
                v = v if isinstance(v, str) else json.dumps(v)
                c.execute("INSERT INTO kv(user_id,page_id,k,v,updated,ver) VALUES(?,?,?,?,?,?)",
                          (uid, pid, str(k)[:512], v, ts, next_ver(0)))
            used = usage(c, uid)
            if used > STORE_QUOTA:
                c.rollback()
                raise HTTPError(413, "That would go over the storage quota.")
            c.commit()
            return self.send_json({"ok": True, "keys": len(d)})
        raise HTTPError(405, "Method not allowed")

    def route_updates(self, method, path, me):
        c = self.conn
        if path == "/api/admin/updates" and method in ("GET", "HEAD"):
            cfg = gh_config(c)
            log = [dict(r) for r in c.execute("SELECT ts, page_id, title, version, path, how FROM update_log "
                                              "ORDER BY id DESC LIMIT 20")]
            return self.send_json({
                "config": {"repo": cfg["repo"], "branch": cfg["branch"], "folder": cfg["folder"],
                           "has_token": bool(cfg["token"]), "auto": cfg["auto"], "interval": cfg["interval"]},
                "last_check": int(get_setting(c, "gh_last_check", "0") or 0),
                "last_error": get_setting(c, "gh_last_error", ""),
                "token_expires": int(get_setting(c, "gh_token_expires", "0") or 0) or None,
                "token_alert": token_alert(c, ignore_snooze=True),
                "report": json.loads(get_setting(c, "gh_report", "[]") or "[]"),
                "log": log})
        if path == "/api/admin/updates/config" and method == "POST":
            d = self.read_json()
            repos = []
            for line in re.split(r"[\s,]+", str(d.get("repo", ""))):
                r = re.sub(r"^(https?://)?(www\.)?github\.com/", "", line.strip().strip("/")).removesuffix(".git")
                if not r:
                    continue
                if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", r):
                    raise HTTPError(400, "Each repo should look like your-name/repo-name (got '%s')" % r)
                if r not in repos:
                    repos.append(r)
            set_setting(c, "gh_repo", "\n".join(repos))
            set_setting(c, "gh_branch", str(d.get("branch") or "main").strip())
            set_setting(c, "gh_folder", str(d.get("folder") or "").strip().strip("/"))
            set_setting(c, "gh_auto", "1" if d.get("auto") else "0")
            try:
                interval = max(5, min(1440, int(d.get("interval") or 60)))
            except (TypeError, ValueError):
                raise HTTPError(400, "Check interval must be a number of minutes.")
            set_setting(c, "gh_interval", str(interval))
            if d.get("token"):
                set_setting(c, "gh_token", str(d["token"]).strip())
                for k in ("gh_token_expires", "gh_token_rejected", "gh_alert_snooze"):  # new token: start fresh
                    set_setting(c, k, "")
            if d.get("clear_token"):
                set_setting(c, "gh_token", "")
            set_setting(c, "gh_report", "[]")
            c.commit()
            return self.send_json({"ok": True})
        if path == "/api/admin/updates/snooze" and method == "POST":
            set_setting(c, "gh_alert_snooze", str(now() + 86400))
            c.commit()
            return self.send_json({"ok": True})
        if path == "/api/admin/updates/check" and method == "POST":
            try:
                report, _ = run_update_check(c, auto_install=False)
            except UpdateError as e:
                raise HTTPError(400, str(e))
            return self.send_json({"report": report})
        if path == "/api/admin/updates/install" and method == "POST":
            d = self.read_json()
            cfg = gh_config(c)
            try:
                with UPDATE_LOCK:
                    pid = install_from_repo(c, cfg, str(d.get("key", "")), str(d.get("sha", "")),
                                            page_id=int(d["app_id"]) if d.get("app_id") else None,
                                            owner_id=me["id"])
                report, _ = run_update_check(c, auto_install=False)
            except UpdateError as e:
                raise HTTPError(400, str(e))
            return self.send_json({"ok": True, "app_id": pid, "report": report})
        raise HTTPError(404, "Unknown updates endpoint")

    def admin_count(self, exclude=None):
        return self.conn.execute("SELECT COUNT(*) FROM users WHERE is_admin=1 AND id IS NOT ?",
                                 (exclude,)).fetchone()[0]

    def route_admin(self, method, path, me):
        c = self.conn
        # -- apps
        if path == "/api/admin/apps":
            if method in ("GET", "HEAD"):
                rows = c.execute(self.PAGE_SELECT + "ORDER BY p.title COLLATE NOCASE").fetchall()
                users = c.execute("SELECT id, username, is_admin FROM users ORDER BY username").fetchall()
                return self.send_json({"apps": [self.page_json(p, me, admin=True) for p in rows],
                                       "users": [dict(u) for u in users],
                                       "limits": {"upload": MAX_UPLOAD}})
            if method == "POST":
                return self.api_upload(me)
        m = re.fullmatch(r"/api/admin/apps/(\d+)", path)
        if m:
            page = self.page_by_id(int(m.group(1)))
            if not page:
                raise HTTPError(404, "App not found")
            if method == "PATCH":
                return self.api_edit_page(me, page)
            if method == "DELETE":
                c.execute("DELETE FROM pages WHERE id=?", (page["id"],))
                c.commit()
                shutil.rmtree(page_dir(page["id"]), ignore_errors=True)
                remove_icon_files(page["id"])
                drop_files(c, pid=page["id"])
                return self.send_json({"ok": True})
        m = re.fullmatch(r"/api/admin/apps/(\d+)/icon", path)
        if m:
            page = self.page_by_id(int(m.group(1)))
            if not page:
                raise HTTPError(404, "App not found")
            if method == "POST":
                body = self.read_body(MAX_ICON)
                ext = sniff_image(body)
                if not ext:
                    raise HTTPError(400, "Use a PNG, JPG, GIF, WebP or SVG image.")
                remove_icon_files(page["id"])
                with open(os.path.join(ICON_DIR, "%d.%s" % (page["id"], ext)), "wb") as f:
                    f.write(body)
                c.execute("UPDATE pages SET icon=? WHERE id=?", ("%s.%d" % (ext, time.time() * 1000), page["id"]))
                c.commit()
                return self.send_json(self.page_json(self.page_by_id(page["id"]), me, admin=True))
            if method == "DELETE":
                remove_icon_files(page["id"])
                c.execute("UPDATE pages SET icon='' WHERE id=?", (page["id"],))
                c.commit()
                return self.send_json({"ok": True})

        # -- GitHub updates
        if path.startswith("/api/admin/updates"):
            return self.route_updates(method, path, me)

        # -- people
        if path == "/api/admin/users" and method in ("GET", "HEAD"):
            rows = c.execute(
                "SELECT u.id, u.username, u.is_admin, u.must_change, u.created, "
                "(SELECT COALESCE(SUM(LENGTH(k)+LENGTH(v)),0) FROM kv WHERE kv.user_id=u.id) + "
                "(SELECT COALESCE(SUM(size),0) FROM page_files f WHERE f.user_id=u.id) AS data_bytes "
                "FROM users u ORDER BY u.username").fetchall()
            users = []
            for r in rows:
                d = dict(r)
                d["apps"] = [x[0] for x in c.execute("SELECT page_id FROM page_access WHERE user_id=?", (r["id"],))]
                users.append(d)
            apps = c.execute("SELECT id, title, visibility FROM pages ORDER BY title COLLATE NOCASE").fetchall()
            return self.send_json({"users": users, "apps": [dict(a) for a in apps],
                                   "registration_open": get_setting(c, "registration_open", "0") == "1"})
        if path == "/api/admin/users" and method == "POST":
            d = self.read_json()
            uid = self.create_user(d.get("username"), d.get("password"), bool(d.get("is_admin")), must_change=True)
            for pid in d.get("apps") or []:
                c.execute("INSERT OR IGNORE INTO page_access(page_id,user_id) SELECT id, ? FROM pages WHERE id=?",
                          (uid, int(pid)))
            c.commit()
            return self.send_json({"ok": True, "id": uid})
        if path == "/api/admin/settings" and method in ("POST", "PATCH"):
            d = self.read_json()
            if "registration_open" in d:
                set_setting(c, "registration_open", "1" if d["registration_open"] else "0")
            c.commit()
            return self.send_json({"ok": True})
        m = re.fullmatch(r"/api/admin/users/(\d+)(/password)?", path)
        if m:
            uid = int(m.group(1))
            if not c.execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone():
                raise HTTPError(404, "No such user")
            if m.group(2) and method == "POST":
                self.set_password(uid, self.read_json().get("password"), must_change=uid != me["id"])
                c.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
                c.commit()
                return self.send_json({"ok": True})
            if not m.group(2) and method == "PATCH":
                d = self.read_json()
                if "is_admin" in d:
                    if not d["is_admin"] and self.admin_count(exclude=uid) == 0:
                        raise HTTPError(400, "There must be at least one admin.")
                    c.execute("UPDATE users SET is_admin=? WHERE id=?", (1 if d["is_admin"] else 0, uid))
                if isinstance(d.get("apps"), list):
                    c.execute("DELETE FROM page_access WHERE user_id=?", (uid,))
                    for pid in d["apps"]:
                        c.execute("INSERT OR IGNORE INTO page_access(page_id,user_id) "
                                  "SELECT id, ? FROM pages WHERE id=?", (uid, int(pid)))
                c.commit()
                return self.send_json({"ok": True})
            if not m.group(2) and method == "DELETE":
                if uid == me["id"]:
                    raise HTTPError(400, "You can't delete your own account.")
                c.execute("DELETE FROM users WHERE id=?", (uid,))  # their saved data goes with them
                c.commit()
                drop_files(c, uid=uid)
                return self.send_json({"ok": True})
        raise HTTPError(404, "Unknown admin endpoint")


def main():
    global SECRET
    SECRET = init_storage()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    threading.Thread(target=update_loop, daemon=True).start()
    print("PageVault %s listening on http://%s:%d  (data in %s)" % (VERSION, HOST, PORT, DATA_DIR), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
