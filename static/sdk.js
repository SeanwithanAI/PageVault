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
  function post(body, keepalive) {
    var opts = { method: "POST", headers: { "Content-Type": "text/plain" }, body: body };
    if (!keepalive) return fetch(cfg.store, opts);
    opts.keepalive = true;
    // if the browser refuses the keepalive request for any reason, send it the normal way
    return fetch(cfg.store, opts).catch(function () { delete opts.keepalive; return fetch(cfg.store, opts); });
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
          if (!r.ok) throw new Error("HTTP " + r.status);
          inflight = false;
          return r.json().then(function (res) {
            if (batch.clear) vers = Object.create(null);
            batch.remove.forEach(function (k) { delete vers[k]; });
            Object.keys(res.vers || {}).forEach(function (k) { vers[k] = res.vers[k]; });
            retryDelay = 2000; banner(null);
          });
        })
        .catch(function () {
          inflight = false;
          requeue(batch);
          banner("Can't reach the server - your changes will be saved when it's back. Don't close this tab yet.", false);
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
          return fetch(cfg.files, { method: "POST", body: blob, headers: {
            "Content-Type": blob.type || "application/octet-stream",
            "X-Filename": encodeURIComponent(name || blob.name || "file") } })
            .then(function (r) {
              if (r.status === 413) throw new Error("That file is too big, or your storage is full.");
              if (!r.ok) throw new Error("Couldn't save the file (HTTP " + r.status + ").");
              return r.json();
            });
        },
        url: function (id) { return cfg.persist ? cfg.files + "/" + encodeURIComponent(id) : null; },
        remove: function (id) {
          if (!cfg.persist) return Promise.resolve();
          return fetch(cfg.files + "/" + encodeURIComponent(id), { method: "DELETE" }).then(function () {});
        }
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
})();
