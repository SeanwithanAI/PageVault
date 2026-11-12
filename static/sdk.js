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
