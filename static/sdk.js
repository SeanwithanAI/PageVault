/*
 * PageVault page SDK - injected automatically into every HTML page you upload.
 *
 * Your page's data is saved ONLY on your PageVault server, separately for each
 * signed-in user. Nothing is kept in the browser: the server is the single
 * source of truth, so there are no local copies to drift out of sync.
 * Pages that already use localStorage work as-is: it is transparently
 * redirected to the server.
 *
 * Conflict protection: every saved value carries a version. If another tab or
 * device saved a newer version first, this tab's write is refused (never
 * silently overwritten) and the user is asked to reload to get the latest.
 *
 * Extra API (optional):
 *   PageStore.getItem(key) / setItem(key, value) / removeItem(key) / clear()
 *   PageStore.getJSON(key, fallback) / PageStore.setJSON(key, value)
 *   PageStore.keys()           -> array of keys
 *   PageStore.flush()          -> Promise, resolves once everything is saved
 *   PageStore.persistent       -> true when data is saved to the server
 *   PageStore.pending          -> true while changes are still waiting to reach the server
 *   PageStore.conflicted       -> true if another tab/device saved first (reload needed)
 *   PageStore.files.put(blob, name) -> Promise<{id, name, type, size}>  (attachments, up to 25 MB)
 *   PageStore.files.url(id)    -> URL to show or download a saved file
 *   PageStore.files.remove(id) -> Promise
 *   PageStore.relay(url[, {auth}]) -> Promise<JSON>: fetch an allowed outside service through the
 *                                 server (Steam's Web API, RAWG, SteamGridDB with {auth: key}), for services that block
 *                                 web pages or browsers that block an app's own requests
 *   PageStore.imports("cocoon") -> Promise<{configured, folder, file, modified, sessions}>: play sessions
 *                                 from the newest Cocoon backup in the person's imports folder
 *   PageStore.user             -> signed-in username (or null)
 *   PageStore.ready            -> already-resolved Promise (data is preloaded)
 */
(function () {
  "use strict";
  var boot = window.__PV || { cfg: { persist: false }, data: {} };
  var cfg = boot.cfg || {};
  var data = Object.create(null);
  Object.keys(boot.data || {}).forEach(function (k) { data[k] = boot.data[k]; });

  var vers = Object.create(null);
  Object.keys(boot.vers || {}).forEach(function (k) { vers[k] = boot.vers[k]; });
  var dirty = Object.create(null), removed = Object.create(null), clearAll = false;
  var timer = null, retryDelay = 2000, chain = Promise.resolve(), halted = false, inflight = false;

  // Browsers only let a "keepalive" request (one that can finish after the tab closes) carry about
  // 64 KB, counted in BYTES. Characters like "–" or emoji take 2-4 bytes each, so measure bytes.
  var KEEPALIVE_MAX = 48 * 1024;
  function byteSize(str) { try { return new Blob([str]).size; } catch (e) { return str.length * 3; } }
  // ---- Form fallback -------------------------------------------------------------------
  // Some browsers block fetch() from inside PageVault's sandboxed apps. Brave on iPhone does:
  // its blocker never answers ("WKWebView API client did not respond to this postMessage").
  // A normal form submission into a hidden frame isn't affected, and the server replies with
  // a tiny page that hands the answer back to us with postMessage.
  var useForms = false, formSeq = 0, formWaiters = {};
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || typeof d.pvForm !== "string" || !formWaiters[d.pvForm]) return;
    formWaiters[d.pvForm](e, d);
  });
  function formSend(url, fields, file, fileName) {
    return new Promise(function (resolve, reject) {
      var id = "f" + (++formSeq) + "_" + Date.now().toString(36);
      var frame = document.createElement("iframe");
      frame.name = "pvform_" + id;
      frame.setAttribute("aria-hidden", "true"); frame.tabIndex = -1;
      frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
      var form = document.createElement("form");
      form.method = "POST"; form.enctype = "multipart/form-data"; form.acceptCharset = "utf-8";
      form.target = frame.name; form.style.display = "none";
      form.action = url + (url.indexOf("?") < 0 ? "?" : "&") + "via=form&rid=" + id;
      Object.keys(fields || {}).forEach(function (k) {
        var t = document.createElement("textarea"); t.name = k; t.value = fields[k]; form.appendChild(t);
      });
      if (file) {
        var input = document.createElement("input"); input.type = "file"; input.name = "file";
        var dt = new DataTransfer();
        dt.items.add(file instanceof File ? file : new File([file], fileName || "file", { type: file.type || "application/octet-stream" }));
        input.files = dt.files; form.appendChild(input);
      }
      var host = document.body || document.documentElement;
      host.appendChild(frame); host.appendChild(form);
      function cleanup() { delete formWaiters[id]; setTimeout(function () { frame.remove(); form.remove(); }, 0); }
      var timeout = setTimeout(function () { cleanup(); reject(new Error("no answer from the server")); }, 15000);
      formWaiters[id] = function (e, d) {
        if (e.source !== frame.contentWindow) return;      // only our own hidden frame may answer
        clearTimeout(timeout); cleanup();
        resolve({ status: d.status, ok: d.status >= 200 && d.status < 300,
                  json: function () { return Promise.resolve(d.body); },
                  text: function () { return Promise.resolve(JSON.stringify(d.body)); } });
      };
      form.submit();
    });
  }
  // Try fetch first; if the browser refuses it, switch to the form fallback for the rest of this visit.
  function send(url, opts, fields, file, fileName) {
    if (useForms) return formSend(url, fields, file, fileName);
    return fetch(url, opts).catch(function (err) {
      try { console.warn("PageVault: fetch() was refused (" + (err && err.message) + "); using the form fallback."); } catch (x) {}
      useForms = true;
      return formSend(url, fields, file, fileName);
    });
  }
  function post(body, keepalive) {
    var opts = { method: "POST", headers: { "Content-Type": "text/plain" }, body: body };
    if (keepalive && !useForms) {
      opts.keepalive = true;
      // if the browser refuses the keepalive request, try again without it (then the form fallback)
      return fetch(cfg.store, opts).catch(function () { delete opts.keepalive; return send(cfg.store, opts, { pv_body: body }); });
    }
    return send(cfg.store, opts, { pv_body: body });
  }
  function pending() {
    return clearAll || Object.keys(dirty).length > 0 || Object.keys(removed).length > 0;
  }
  function takeBatch() {
    var b = { set: {}, remove: Object.keys(removed), clear: clearAll, base: {} };
    Object.keys(dirty).forEach(function (k) { if (k in data) b.set[k] = data[k]; });
    // which server version each change was based on (0 = didn't exist)
    Object.keys(b.set).concat(b.remove).forEach(function (k) { b.base[k] = b.clear ? 0 : (vers[k] || 0); });
    dirty = Object.create(null); removed = Object.create(null); clearAll = false;
    return b;
  }
  function requeue(b) {
    if (b.clear) { clearAll = true; Object.keys(data).forEach(function (k) { dirty[k] = 1; }); }
    Object.keys(b.set).forEach(function (k) { if (!(k in removed)) dirty[k] = 1; });
    b.remove.forEach(function (k) { if (!(k in data)) removed[k] = 1; });
  }
  function schedule(delay) {
    if (!cfg.persist || timer || halted) return;
    timer = setTimeout(function () { timer = null; flush(); }, delay || 250);
  }
  function flush() {
    if (!cfg.persist || halted) return chain;
    if (timer) { clearTimeout(timer); timer = null; }   // this flush covers whatever the timer was waiting for
    chain = chain.then(function () {
      // build the batch only after the previous save finished, so versions are current
      if (halted || !pending()) return;
      var batch = takeBatch();
      var body = JSON.stringify(batch);
      inflight = true;
      return post(body, byteSize(body) < KEEPALIVE_MAX)
        .then(function (r) {
          if (r.status === 409 || r.status === 401 || r.status === 413) inflight = false;
          if (r.status === 409) {
            halted = true;
            banner("This app's data was changed in another tab or on another device. " +
                   "Your latest change here was NOT saved, so nothing was overwritten. Tap to reload the latest.", true);
            return;
          }
          if (r.status === 401) { halted = true; banner("Your session expired. Tap to reload and keep saving.", true); return; }
          if (r.status === 413) { banner("Storage is full; your latest change was not saved.", true); return; }
          if (r.status === 403) {
            inflight = false; halted = true;
            banner("PageVault won't accept saves from this page (no access, or your password needs changing). Tap to reload.", true);
            return;
          }
          if (!r.ok) {
            // the server answered but refused: read its reason so the message can say what went wrong
            return r.text().then(function (t) {
              var why = ""; try { why = JSON.parse(t).error || ""; } catch (e) { why = (t || "").slice(0, 120); }
              var err = new Error("server error " + r.status + (why ? ": " + why : ""));
              err.server = true; throw err;
            });
          }
          inflight = false;
          return r.json().then(function (res) {
            if (batch.clear) vers = Object.create(null);
            batch.remove.forEach(function (k) { delete vers[k]; });
            Object.keys(res.vers || {}).forEach(function (k) { vers[k] = res.vers[k]; });
            retryDelay = 2000; banner(null);
          });
        })
        .catch(function (e) {
          inflight = false;
          requeue(batch);
          try { console.warn("PageVault save failed:", e); } catch (x) {}
          if (e && e.server) {
            banner("The server couldn't save your change (" + e.message.replace(/^server /, "") + "). " +
                   "It's kept in this tab and will be retried. Don't close this tab yet.", false);
          } else {
            banner("Can't reach the server (no connection" + (e && e.message ? ": " + e.message : "") + "). " +
                   "Your changes will be saved when it's back. Don't close this tab yet.", false);
          }
          schedule(retryDelay); retryDelay = Math.min(retryDelay * 2, 60000);
        });
    });
    return chain;
  }

  var bannerEl = null;
  function banner(msg, sticky) {
    if (!msg) { if (bannerEl) { bannerEl.remove(); bannerEl = null; } return; }
    if (!document.body) return;
    if (!bannerEl) {
      bannerEl = document.createElement("div");
      bannerEl.setAttribute("style", "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;" +
        "background:#1f2937;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:10px 14px;border-radius:10px;" +
        "box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:90vw;cursor:pointer");
      bannerEl.title = sticky ? "Click to reload" : "";
      bannerEl.onclick = function () { if (sticky) location.reload(); };
      document.body.appendChild(bannerEl);
    }
    bannerEl.textContent = msg;
  }

  // Registered after the page's own scripts have added theirs, so a page that saves
  // "on close" gets its last change sent too.
  setTimeout(function () {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden" && pending()) { clearTimeout(timer); timer = null; flush(); }
    });
    window.addEventListener("pagehide", onHide);
  }, 0);
  function onHide() {
    if (!cfg.persist || halted || !pending()) return;
    var body = JSON.stringify(takeBatch());
    try {
      if (!(navigator.sendBeacon && navigator.sendBeacon(cfg.store, new Blob([body], { type: "text/plain" })))) {
        post(body, byteSize(body) < KEEPALIVE_MAX);
      }
    } catch (e) { /* best effort */ }
  }

  function makeStore(persist) {
    var mem = persist ? null : Object.create(null);
    function bag() { return persist ? data : mem; }
    var api = {
      getItem: function (k) { k = String(k); return k in bag() ? bag()[k] : null; },
      setItem: function (k, v) {
        k = String(k); v = String(v);
        bag()[k] = v;
        if (persist) { delete removed[k]; dirty[k] = 1; schedule(); }
      },
      removeItem: function (k) {
        k = String(k);
        if (!(k in bag())) return;
        delete bag()[k];
        if (persist) { delete dirty[k]; removed[k] = 1; schedule(); }
      },
      clear: function () {
        if (persist) { data = Object.create(null); dirty = Object.create(null); removed = Object.create(null); clearAll = true; schedule(); }
        else mem = Object.create(null);
      },
      key: function (i) { var ks = Object.keys(bag()); return i < ks.length ? ks[i] : null; },
      get length() { return Object.keys(bag()).length; },
      keys: function () { return Object.keys(bag()); },
      getJSON: function (k, fallback) {
        var v = api.getItem(k);
        if (v === null) return fallback === undefined ? null : fallback;
        try { return JSON.parse(v); } catch (e) { return fallback === undefined ? null : fallback; }
      },
      setJSON: function (k, v) { api.setItem(k, JSON.stringify(v)); },
      flush: function () { return persist ? flush() : Promise.resolve(); },
      ready: Promise.resolve(),
      persistent: !!(persist && cfg.persist),
      get conflicted() { return halted; },
      get pending() { return !!(cfg.persist && (pending() || inflight || timer)); },
      files: {
        put: function (blob, name) {
          if (!cfg.persist) return Promise.reject(new Error("Sign in to save files."));
          var fname = name || blob.name || "file";
          return send(cfg.files, { method: "POST", body: blob, headers: {
            "Content-Type": blob.type || "application/octet-stream",
            "X-Filename": encodeURIComponent(fname) } }, {}, blob, fname)
            .then(function (r) {
              if (r.status === 413) throw new Error("That file is too big, or your storage is full.");
              if (!r.ok) throw new Error("Couldn't save the file (HTTP " + r.status + ").");
              return r.json();
            });
        },
        url: function (id) { return cfg.persist ? cfg.files + "/" + encodeURIComponent(id) : null; },
        remove: function (id) {
          if (!cfg.persist) return Promise.resolve();
          var u = cfg.files + "/" + encodeURIComponent(id), viaForm = function () { return formSend(u + "?_method=DELETE", {}, null); };
          var p = useForms ? viaForm() : fetch(u, { method: "DELETE" }).catch(function () { useForms = true; return viaForm(); });
          return p.then(function () {}, function () {});
        }
      },
      relay: function (url, opts) {
        if (!cfg.relay) return Promise.reject(new Error("Sign in to PageVault to use this."));
        var msg = { url: String(url) };
        if (opts && opts.auth) msg.auth = String(opts.auth);   // SteamGridDB key, sent as "Authorization: Bearer"
        var body = JSON.stringify(msg);
        return send(cfg.relay, { method: "POST", headers: { "Content-Type": "text/plain" }, body: body }, { pv_body: body })
          .then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (j) {
              if (!r.ok) { var e = new Error((j && j.error) || ("HTTP " + r.status)); e.status = r.status; e.body = j; throw e; }
              return j;
            });
          });
      },
      imports: function (kind) {
        if (!cfg.imports) return Promise.reject(new Error("Sign in to PageVault to use this."));
        var body = JSON.stringify({ kind: String(kind) });
        return send(cfg.imports, { method: "POST", headers: { "Content-Type": "text/plain" }, body: body }, { pv_body: body })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok) { var e = new Error((j && j.error) || ("HTTP " + r.status)); e.status = r.status; throw e; } return j; }); });
      },
      user: cfg.user || null,
      page: cfg.page || null
    };
    // Proxy so localStorage.foo = "x", localStorage["foo"], Object.keys(localStorage) all work.
    return new Proxy(api, {
      get: function (t, p) {
        if (p in t) return t[p];
        if (typeof p === "string" && p in bag()) return bag()[p];
        return undefined;
      },
      set: function (t, p, v) {
        if (p in t) return false;
        t.setItem(p, v); return true;
      },
      has: function (t, p) { return p in t || p in bag(); },
      deleteProperty: function (t, p) { t.removeItem(p); return true; },
      ownKeys: function () { return Object.keys(bag()); },
      getOwnPropertyDescriptor: function (t, p) {
        if (typeof p === "string" && p in bag()) return { value: bag()[p], writable: true, enumerable: true, configurable: true };
        return undefined;
      }
    });
  }

  var store = makeStore(true);
  window.PageStore = store;

  // Uploaded pages run sandboxed, where the browser's own localStorage is unavailable.
  // Swap in server-backed storage (and an in-memory sessionStorage).
  function shim(name, value) {
    try { Object.defineProperty(window, name, { value: value, configurable: true, writable: true }); }
    catch (e) { /* ignore */ }
  }
  shim("localStorage", store);
  shim("sessionStorage", makeStore(false));

  // ---- PageVault button: back to the launcher, or switch to another app.
  // Lives in a shadow root so the app's CSS can't touch it (and it can't touch the app).
  if (cfg.nav && cfg.nav.apps && window.top === window) {
    var start = function () {
      var nav = cfg.nav, pos = nav.pos || { side: "left", y: 0.72 };
      var host = document.createElement("div");
      host.setAttribute("data-pagevault", "");
      host.style.cssText = "all:initial;position:fixed;z-index:2147483646;top:0;left:0;width:0;height:0";
      document.documentElement.appendChild(host);
      var root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
      var esc = function (t) { return String(t).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
      var hue = function (t) { var h = 0; for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 360; return h; };
      var icon = function (a) {
        var letter = '<span class="ic" style="background:hsl(' + hue(a.title) + ',62%,48%)">' + esc((a.title.trim()[0] || "?").toUpperCase()) + "</span>";
        return a.icon ? '<img class="ic" src="' + esc(a.icon) + '" alt="" data-letter="' + esc(letter) + '">' : letter;
      };
      root.innerHTML = '<style>' +
        ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
        '.fab{position:fixed;width:44px;height:44px;border-radius:50%;border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.92);color:#1f2937;' +
        'box-shadow:0 4px 14px rgba(0,0,0,.18);display:grid;place-items:center;cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none;' +
        'opacity:.78;transition:opacity .15s,transform .15s;padding:0;-webkit-tap-highlight-color:transparent}' +
        '.fab:hover,.fab:focus-visible{opacity:1}.fab.drag{opacity:1;transform:scale(1.08);transition:none}.fab svg{width:22px;height:22px}' +
        '.fab:focus-visible{outline:3px solid #2563eb;outline-offset:2px}' +
        '.ov{position:fixed;inset:0;background:rgba(15,20,30,.45);display:flex;align-items:flex-end;justify-content:center;padding:12px}' +
        '@media (min-width:600px){.ov{align-items:center}}.ov[hidden]{display:none}' +
        '.sh{width:min(420px,100%);max-height:min(560px,calc(100vh - 24px));overflow:auto;background:#fff;color:#16191f;border-radius:18px;padding:16px;box-shadow:0 20px 60px rgba(0,0,0,.3)}' +
        '.hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.hd b{font-size:16px}' +
        '.x{border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:#6b7280;padding:4px 8px;border-radius:8px}' +
        '.home{display:flex;align-items:center;gap:10px;width:100%;padding:12px 14px;border-radius:12px;background:#2563eb;color:#fff;text-decoration:none;font-weight:700;font-size:15px}' +
        '.home svg{width:20px;height:20px}.lbl{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin:16px 0 8px}' +
        '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px}' +
        '.app{display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 8px;border:1px solid #e5e7eb;border-radius:12px;text-decoration:none;color:inherit;text-align:center;font-size:13px;font-weight:600;line-height:1.25}' +
        'a.app:hover{border-color:#2563eb}.app.cur{background:#eff6ff;border-color:#bfdbfe;cursor:default}.app small{font-weight:600;color:#2563eb;font-size:11px}' +
        '.ic{width:40px;height:40px;border-radius:11px;object-fit:cover;display:grid;place-items:center;color:#fff;font-weight:700;font-size:18px}' +
        '.tip{font-size:12px;color:#6b7280;margin:14px 0 0;text-align:center}' +
        '@media (prefers-color-scheme:dark){.fab{background:rgba(30,34,43,.92);color:#e8eaee;border-color:rgba(255,255,255,.14)}' +
        '.sh{background:#171a21;color:#e8eaee}.app{border-color:#272b35}.app.cur{background:#1e2533;border-color:#334155}.x,.lbl,.tip{color:#9aa3b2}.home{background:#3b82f6}}' +
        '@media print{.fab,.ov{display:none!important}}</style>' +
        '<button class="fab" type="button" aria-label="PageVault: go home or switch apps" title="PageVault (drag to move)">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg></button>' +
        '<div class="ov" hidden><div class="sh" role="dialog" aria-modal="true" aria-label="PageVault">' +
        '<div class="hd"><b>PageVault</b><button class="x" type="button" aria-label="Close">✕</button></div>' +
        '<a class="home" href="' + esc(nav.home) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>Back to PageVault home</a>' +
        (nav.apps.length > 1 ? '<div class="lbl">Switch app</div><div class="grid">' + nav.apps.map(function (a) {
          return a.current ? '<div class="app cur" aria-current="page">' + icon(a) + "<span>" + esc(a.title) + "</span><small>You’re here</small></div>"
                           : '<a class="app" href="' + esc(a.url) + '">' + icon(a) + "<span>" + esc(a.title) + "</span></a>";
        }).join("") + "</div>" : "") +
        '<p class="tip">Tip: drag the round button to move it.</p></div></div>';
      var fab = root.querySelector(".fab"), ov = root.querySelector(".ov");
      root.querySelectorAll("img.ic").forEach(function (im) {
        im.onerror = function () { var t = document.createElement("template"); t.innerHTML = im.getAttribute("data-letter"); im.replaceWith(t.content); };
      });
      var place = function () {
        var h = window.innerHeight, y = Math.min(h - 52, Math.max(8, pos.y * h - 22));
        fab.style.top = y + "px";
        fab.style.left = pos.side === "right" ? "" : "10px";
        fab.style.right = pos.side === "right" ? "10px" : "";
      };
      place();
      window.addEventListener("resize", place);
      var open = function () { ov.hidden = false; var f = root.querySelector(".home"); if (f) f.focus(); };
      var close = function () { ov.hidden = true; fab.focus(); };
      root.querySelector(".x").onclick = close;
      ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
      root.addEventListener("keydown", function (e) { if (e.key === "Escape" && !ov.hidden) close(); });
      // tap opens the menu; drag moves the button and snaps it to the nearest side
      var d = null;
      fab.addEventListener("pointerdown", function (e) {
        d = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
        try { fab.setPointerCapture(e.pointerId); } catch (x) {}
      });
      fab.addEventListener("pointermove", function (e) {
        if (!d || e.pointerId !== d.id) return;
        if (!d.moved && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 8) return;
        d.moved = true; fab.classList.add("drag");
        fab.style.right = ""; fab.style.left = Math.max(4, Math.min(window.innerWidth - 48, e.clientX - 22)) + "px";
        fab.style.top = Math.max(4, Math.min(window.innerHeight - 48, e.clientY - 22)) + "px";
      });
      var up = function (e) {
        if (!d) return;
        var was = d; d = null; fab.classList.remove("drag");
        if (!was.moved) { if (e.type === "pointerup") open(); return; }
        pos = { side: e.clientX > window.innerWidth / 2 ? "right" : "left", y: Math.min(0.95, Math.max(0.05, e.clientY / window.innerHeight)) };
        place();
        try { fetch(nav.save, { method: "POST", body: JSON.stringify(pos), headers: { "Content-Type": "text/plain" }, keepalive: true }).catch(function () {}); } catch (x) {}
      };
      fab.addEventListener("pointerup", up);
      fab.addEventListener("pointercancel", up);
      fab.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
      fab.addEventListener("click", function (e) { e.preventDefault(); });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  }
})();
