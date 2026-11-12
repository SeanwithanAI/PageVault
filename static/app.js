(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var me = null, chosen = null, replaceTarget = null, importTarget = null;
  var apps = {}, adminApps = {}, people = [], userRows = {}, allApps = [];
  var VIS = {
    selected: "Selected people",
    users: "Everyone signed in",
    "public": "Anyone with the link",
    "private": "Hidden (admins only)"
  };

  // ---------- helpers
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function size(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }
  function when(ts) {
    var d = new Date(ts * 1000), s = (Date.now() - d) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    return d.toLocaleDateString();
  }
  // mirrors the server: "A-Better-PTO-Tracker-2026-11-11-mk2.html" -> "A Better PTO Tracker"
  function prettyName(f) {
    var s = f.replace(/\.(html?|zip)$/i, "")
      .replace(/[-_ .]+by[-_ .]+[^-_ .].*$/i, "")
      .replace(/[-_ .]*\d{4}-\d{2}-\d{2}([-_ .]*mk\d+)?$/i, "")
      .replace(/[-_ .]*(v|ver|version)?[-_ ]?\d+(\.\d+)+$/i, "")
      .replace(/[-_ .]*(mk|rev)\d+$/i, "")
      .replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    if (s && s === s.toLowerCase()) s = s.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    return s || "Untitled app";
  }
  function appIcon(a, cls) {
    if (a.icon) return '<img class="' + cls + ' icon" src="' + esc(a.icon) + '" alt="">';
    var letter = (a.title.trim()[0] || "?").toUpperCase();
    return '<div class="' + cls + '" style="background:hsl(' + hue(a.title) + ',62%,48%)">' + esc(letter) + "</div>";
  }
  var IMG_RE = /^image\/(png|jpeg|gif|webp|svg\+xml)$/;
  function previewInto(file, img, hint) {
    var url = URL.createObjectURL(file);
    img.src = url; img.classList.remove("hidden");
    if (hint) hint.classList.add("hidden");
  }
  function uploadIcon(appId, file) {
    return api("/api/admin/apps/" + appId + "/icon", {
      method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file
    });
  }
  function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  var toastTimer;
  function toast(msg, err) {
    var t = document.querySelector(".toast") || document.body.appendChild(document.createElement("div"));
    t.className = "toast" + (err ? " err" : "");
    t.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.remove(); }, 3200);
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "X-PV": "1" }, opts.headers || {});
    if (opts.json !== undefined) {
      opts.body = JSON.stringify(opts.json);
      opts.headers["Content-Type"] = "application/json";
      delete opts.json;
    }
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) { location.href = "/login"; throw new Error("Signed out"); }
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || r.statusText);
        return d;
      });
    });
  }
  function fail(e) { toast(e.message || String(e), true); }
  function visOptions(sel) {
    return Object.keys(VIS).map(function (v) {
      return '<option value="' + v + '"' + (v === sel ? " selected" : "") + ">" + VIS[v] + "</option>";
    }).join("");
  }
  function checklist(items, selected, labelKey) {
    if (!items.length) return '<span class="none">Nothing here yet.</span>';
    return items.map(function (it) {
      return '<label><input type="checkbox" value="' + it.id + '"' + (selected.indexOf(it.id) >= 0 ? " checked" : "") +
        "> " + esc(it[labelKey]) + "</label>";
    }).join("");
  }
  function checked(container) {
    return Array.prototype.map.call(container.querySelectorAll("input:checked"), function (i) { return +i.value; });
  }
  function members() { return people.filter(function (u) { return !u.is_admin; }); }

  // ---------- dialog
  var dlg = $("dlg"), dlgForm = $("dlgForm"), dlgOk = null;
  function openDialog(title, bodyHtml, okLabel, onOk) {
    dlgForm.innerHTML = "<h2>" + esc(title) + "</h2>" + bodyHtml +
      '<div class="actions">' + (okLabel ? '<button class="btn primary" value="ok">' + esc(okLabel) + "</button>" : "") +
      '<button class="btn" value="cancel">' + (okLabel ? "Cancel" : "Close") + "</button></div>";
    dlgOk = onOk;
    dlg.showModal();
  }
  dlgForm.addEventListener("submit", function (e) {
    var ok = e.submitter && e.submitter.value === "ok";
    if (!ok || !dlgOk) return;
    e.preventDefault();
    Promise.resolve(dlgOk(dlgForm)).then(function (close) { if (close !== false) dlg.close(); }).catch(fail);
  });

  // ---------- tabs
  function showTab(name) {
    document.querySelectorAll("#tabs button").forEach(function (x) { x.classList.toggle("on", x.dataset.tab === name); });
    ["apps", "manage", "people", "updates", "account"].forEach(function (t) { $("tab-" + t).classList.toggle("hidden", t !== name); });
    if (name === "apps") loadApps();
    if (name === "manage") loadManage();
    if (name === "people") loadPeople();
    if (name === "updates") loadUpdates();
  }
  document.querySelectorAll("#tabs button").forEach(function (b) { b.onclick = function () { showTab(b.dataset.tab); }; });
  $("logout").onclick = function () {
    api("/api/logout", { method: "POST" }).then(function () { location.href = "/login"; }).catch(fail);
  };

  // ================= MY APPS (everyone)
  function loadApps() {
    return api("/api/apps").then(function (d) {
      apps = {};
      d.apps.forEach(function (a) { apps[a.id] = a; });
      $("tiles").innerHTML = d.apps.length ? d.apps.map(function (a) {
        return '<a class="tile" href="' + esc(a.url) + '" data-id="' + a.id + '">' + appIcon(a, "icon") +
          '<div class="name">' + esc(a.title) + "</div>" +
          (a.description ? '<div class="desc">' + esc(a.description) + "</div>" : "") +
          '<button class="more" data-more="' + a.id + '" title="Options" aria-label="Options">⋯</button></a>';
      }).join("") : '<div class="card empty" style="grid-column:1/-1">' +
        (me.is_admin ? "No apps yet. Go to <b>Manage apps</b> to upload your first one."
                     : "You don't have any apps yet. Ask your administrator to give you access.") + "</div>";
      $("storage").textContent = d.storage.used ? "Your saved data: " + size(d.storage.used) + " of " + size(d.storage.quota) : "";
    }).catch(fail);
  }

  $("tiles").addEventListener("click", function (e) {
    var b = e.target.closest("[data-more]");
    if (!b) return;
    e.preventDefault();
    var a = apps[b.dataset.more];
    openDialog(a.title,
      '<p class="muted" style="margin-top:-6px">' + (a.data_keys ? "You have " + size(a.data_bytes) + " saved in this app." : "Nothing saved in this app yet.") + "</p>" +
      '<div class="sheet">' +
      '<button class="btn" type="button" data-sheet="export">Export my data (backup)</button>' +
      '<button class="btn" type="button" data-sheet="import">Import my data from a backup</button>' +
      '<button class="btn danger" type="button" data-sheet="clear">Erase my data in this app</button></div>', null, null);
    dlgForm.querySelectorAll("[data-sheet]").forEach(function (btn) {
      btn.onclick = function () {
        dlg.close();
        var act = btn.dataset.sheet;
        if (act === "export") location.href = "/api/apps/" + a.id + "/data";
        if (act === "import") { importTarget = a; $("importFile").value = ""; $("importFile").click(); }
        if (act === "clear" && confirm("Erase everything you've saved in “" + a.title + "”? This can't be undone.")) {
          api("/api/apps/" + a.id + "/data", { method: "DELETE" }).then(function () { toast("Erased"); loadApps(); }).catch(fail);
        }
      };
    });
  });

  $("importFile").onchange = function () {
    var f = $("importFile").files[0];
    if (!f || !importTarget) return;
    if (!confirm("Replace your saved data in “" + importTarget.title + "” with this backup?")) return;
    f.text().then(function (txt) {
      var obj;
      try { obj = JSON.parse(txt); } catch (e) { throw new Error("That file isn't a valid backup"); }
      return api("/api/apps/" + importTarget.id + "/data", { method: "POST", json: obj });
    }).then(function (r) { toast("Restored " + r.keys + " item(s)"); loadApps(); }).catch(fail);
  };

  // ================= MANAGE APPS (admin)
  $("upVis").innerHTML = visOptions("selected");
  $("upVis").onchange = function () { $("upPeopleWrap").classList.toggle("hidden", $("upVis").value !== "selected"); };

  var drop = $("drop"), fileInput = $("file");
  drop.onclick = function () { fileInput.click(); };
  ["dragenter", "dragover"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) { if (e.dataTransfer.files[0]) choose(e.dataTransfer.files[0]); });
  fileInput.onchange = function () { if (fileInput.files[0]) choose(fileInput.files[0]); };

  function choose(f) {
    if (!/\.(html?|zip)$/i.test(f.name)) { toast("Choose an .html or .zip file", true); return; }
    chosen = f;
    $("upName").textContent = f.name + " · " + size(f.size);
    $("upBtn").disabled = false;
    if (!$("upTitle").value) $("upTitle").value = prettyName(f.name);
  }
  var chosenImg = null;
  $("upImgPick").onclick = function (e) { if (e.target !== $("upImg")) $("upImg").click(); };
  $("upImg").onchange = function () {
    var f = $("upImg").files[0];
    if (!f) return;
    if (!IMG_RE.test(f.type)) { toast("Use a PNG, JPG, GIF, WebP or SVG image", true); return; }
    chosenImg = f; previewInto(f, $("upImgPrev"), $("upImgHint"));
  };
  function resetUpImg() {
    chosenImg = null; $("upImg").value = "";
    $("upImgPrev").classList.add("hidden"); $("upImgPrev").removeAttribute("src"); $("upImgHint").classList.remove("hidden");
  }
  function upload(file, params) {
    return api("/api/admin/apps?" + new URLSearchParams(params), {
      method: "POST",
      headers: { "X-Filename": encodeURIComponent(file.name), "Content-Type": "application/octet-stream" },
      body: file
    });
  }
  $("upBtn").onclick = function () {
    if (!chosen) return;
    $("upBtn").disabled = true; $("upBtn").textContent = "Uploading…";
    upload(chosen, {
      title: $("upTitle").value, slug: $("upSlug").value, description: $("upDesc").value,
      visibility: $("upVis").value, access: checked($("upPeople")).join(",")
    }).then(function (p) {
      return chosenImg ? uploadIcon(p.id, chosenImg).then(function () { return p; }) : p;
    }).then(function (p) {
      toast("Uploaded “" + p.title + "”");
      resetUpImg();
      chosen = null; fileInput.value = "";
      ["upTitle", "upSlug", "upDesc"].forEach(function (id) { $(id).value = ""; });
      $("upName").textContent = "";
      loadManage();
    }).catch(fail).then(function () { $("upBtn").textContent = "Upload"; $("upBtn").disabled = !chosen; });
  };

  function whoCan(a) {
    if (a.visibility !== "selected") return VIS[a.visibility];
    var names = people.filter(function (u) { return a.access.indexOf(u.id) >= 0 && !u.is_admin; })
      .map(function (u) { return u.username; });
    return names.length ? names.join(", ") : "Nobody yet (admins only)";
  }

  function loadManage() {
    return api("/api/admin/apps").then(function (d) {
      people = d.users; adminApps = {};
      d.apps.forEach(function (a) { adminApps[a.id] = a; });
      $("upPeople").innerHTML = checklist(members(), [], "username");
      $("appList").innerHTML = d.apps.length ? d.apps.map(function (a) {
        var url = location.origin + a.url;
        return '<div class="page" data-id="' + a.id + '">' +
          '<div class="head">' + appIcon(a, "thumb") + '<div class="title">' + esc(a.title) +
          '<span class="chip ' + a.visibility + '">' + VIS[a.visibility] + "</span></div></div>" +
          '<div class="meta">' + (a.description ? esc(a.description) + "<br>" : "") +
          "Who can use it: <b>" + esc(whoCan(a)) + "</b><br>" + (a.version ? "Version " + esc(a.version) + " · " : "") + "Updated " + when(a.updated) + " · " + a.files +
          (a.files === 1 ? " file" : " files") + " · " + size(a.bytes) + "</div>" +
          '<div class="link"><code>' + esc(url) + '</code><button class="btn small" data-act="copy">Copy</button>' +
          '<a class="btn small" target="_blank" rel="noopener" href="' + esc(a.url) + '">Open</a></div>' +
          '<div class="menu"><button class="btn small" data-act="edit">Edit name, image & access</button>' +
          '<button class="btn small" data-act="replace">Upload new version</button>' +
          '<button class="btn small danger" data-act="delete">Delete</button></div></div>';
      }).join("") : '<div class="empty">No apps yet. Upload one above.</div>';
    }).catch(fail);
  }

  $("appList").addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (!b) return;
    var a = adminApps[b.closest(".page").dataset.id];
    var act = b.dataset.act;
    if (act === "copy") {
      var url = location.origin + a.url;
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
        .then(function () { toast("Link copied"); }, function () { prompt("Copy this link:", url); });
    } else if (act === "replace") {
      replaceTarget = a; $("replaceFile").value = ""; $("replaceFile").click();
    } else if (act === "delete") {
      if (!confirm("Delete “" + a.title + "” and everyone's saved data in it? This can't be undone.")) return;
      api("/api/admin/apps/" + a.id, { method: "DELETE" }).then(function () { toast("Deleted"); loadManage(); }).catch(fail);
    } else if (act === "edit") {
      var newImg = null, dropImg = false;
      openDialog("Edit app",
        '<div><label>Image</label><div class="imgrow"><div class="imgpick" data-pick>' +
          (a.icon ? '<img src="' + esc(a.icon) + '" alt="">' : '<img class="hidden" alt=""><span>+ Image</span>') +
          '</div><div class="row"><button type="button" class="btn small" data-pick>Choose image…</button>' +
          '<button type="button" class="btn small danger' + (a.icon ? "" : " hidden") + '" data-drop>Remove</button></div>' +
          '<input type="file" class="hidden" data-file accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"></div>' +
          '<div class="muted" style="margin-top:4px">Square images look best (at least 256×256).</div></div>' +
        '<div><label>Name</label><input name="title" value="' + esc(a.title) + '"></div>' +
        '<div><label>Short description</label><input name="description" maxlength="300" value="' + esc(a.description) + '"></div>' +
        '<div><label>Link name</label><input name="slug" autocapitalize="none" value="' + esc(a.slug) + '"></div>' +
        '<div><label>Who can use it</label><select name="visibility">' + visOptions(a.visibility) + "</select></div>" +
        '<div class="peopleBox"><label>People</label><div class="checks">' + checklist(members(), a.access, "username") + "</div></div>",
        "Save", function (f) {
          return api("/api/admin/apps/" + a.id, { method: "PATCH", json: {
            title: f.title.value, description: f.description.value, slug: f.slug.value,
            visibility: f.visibility.value, access: checked(f.querySelector(".checks"))
          } }).then(function () {
            if (newImg) return uploadIcon(a.id, newImg);
            if (dropImg) return api("/api/admin/apps/" + a.id + "/icon", { method: "DELETE" });
          }).then(function () { toast("Saved"); loadManage(); });
        });
      var fileEl = dlgForm.querySelector("[data-file]"), prevImg = dlgForm.querySelector(".imgpick img"),
          hintEl = dlgForm.querySelector(".imgpick span"), dropBtn = dlgForm.querySelector("[data-drop]");
      dlgForm.querySelectorAll("[data-pick]").forEach(function (el) { el.onclick = function () { fileEl.click(); }; });
      fileEl.onchange = function () {
        var f = fileEl.files[0];
        if (!f) return;
        if (!IMG_RE.test(f.type)) { toast("Use a PNG, JPG, GIF, WebP or SVG image", true); return; }
        newImg = f; dropImg = false; previewInto(f, prevImg, hintEl); dropBtn.classList.remove("hidden");
      };
      dropBtn.onclick = function () {
        newImg = null; dropImg = true; fileEl.value = "";
        prevImg.classList.add("hidden"); prevImg.removeAttribute("src");
        if (hintEl) hintEl.classList.remove("hidden");
        else { hintEl = document.createElement("span"); hintEl.textContent = "+ Image"; prevImg.after(hintEl); }
        dropBtn.classList.add("hidden");
      };
      var sel = dlgForm.visibility, box = dlgForm.querySelector(".peopleBox");
      var sync = function () { box.classList.toggle("hidden", sel.value !== "selected"); };
      sel.onchange = sync; sync();
    }
  });

  $("replaceFile").onchange = function () {
    var f = $("replaceFile").files[0];
    if (!f || !replaceTarget) return;
    toast("Uploading new version…");
    upload(f, { replace: replaceTarget.id })
      .then(function () { toast("Updated. Same link, everyone's data kept."); loadManage(); }).catch(fail);
  };

  // ================= PEOPLE (admin)
  function loadPeople() {
    return api("/api/admin/users").then(function (d) {
      allApps = d.apps; userRows = {};
      $("regOpen").checked = d.registration_open;
      var assignable = allApps.filter(function (a) { return a.visibility === "selected"; });
      $("nuApps").innerHTML = checklist(assignable, [], "title");
      $("users").innerHTML = "<tr><th>Person</th><th>Role</th><th>Apps</th><th>Saved data</th><th></th></tr>" +
        d.users.map(function (u) {
          userRows[u.id] = u;
          var n = u.is_admin ? "All" : allApps.filter(function (a) {
            return a.visibility === "users" || a.visibility === "public" || (a.visibility === "selected" && u.apps.indexOf(a.id) >= 0);
          }).length;
          return '<tr data-uid="' + u.id + '"><td><b>' + esc(u.username) + "</b>" + (u.id === me.id ? ' <span class="muted">(you)</span>' : "") +
            "</td><td>" + (u.is_admin ? "Admin" : "Member") + (u.must_change ? '<br><span class="muted">temp password</span>' : "") + "</td><td>" + n + "</td><td>" + size(u.data_bytes) +
            '</td><td><div class="row" style="justify-content:flex-end;flex-wrap:nowrap">' +
            (u.is_admin ? "" : '<button class="btn small" data-uact="apps">Apps</button>') +
            '<button class="btn small" data-uact="role">' + (u.is_admin ? "Make member" : "Make admin") + "</button>" +
            '<button class="btn small" data-uact="pw">Reset password</button>' +
            (u.id === me.id ? "" : '<button class="btn small danger" data-uact="del">Delete</button>') + "</div></td></tr>";
        }).join("");
    }).catch(fail);
  }
  $("regOpen").onchange = function () {
    api("/api/admin/settings", { method: "POST", json: { registration_open: $("regOpen").checked } })
      .then(function () { toast($("regOpen").checked ? "Self sign-up is on" : "Self sign-up is off"); }).catch(fail);
  };
  $("nuAdmin").onchange = function () { $("nuApps").closest("div").classList.toggle("hidden", $("nuAdmin").value === "1"); };
  $("addUser").onsubmit = function (e) {
    e.preventDefault();
    var name = $("nuName").value;
    api("/api/admin/users", { method: "POST", json: {
      username: name, password: $("nuPw").value, is_admin: $("nuAdmin").value === "1", apps: checked($("nuApps"))
    } }).then(function () { toast("Added " + name); $("addUser").reset(); $("nuAdmin").onchange(); loadPeople(); }).catch(fail);
  };
  $("users").addEventListener("click", function (e) {
    var b = e.target.closest("[data-uact]");
    if (!b) return;
    var u = userRows[b.closest("tr").dataset.uid], act = b.dataset.uact;
    if (act === "apps") {
      var assignable = allApps.filter(function (a) { return a.visibility === "selected"; });
      var open = allApps.filter(function (a) { return a.visibility === "users" || a.visibility === "public"; });
      openDialog("Apps for " + u.username,
        '<div class="checks">' + checklist(assignable, u.apps, "title") + "</div>" +
        (open.length ? '<p class="muted">Everyone also gets: ' + open.map(function (a) { return esc(a.title); }).join(", ") + "</p>" : ""),
        "Save", function (f) {
          return api("/api/admin/users/" + u.id, { method: "PATCH", json: { apps: checked(f.querySelector(".checks")) } })
            .then(function () { toast("Saved"); loadPeople(); });
        });
    } else if (act === "role") {
      api("/api/admin/users/" + u.id, { method: "PATCH", json: { is_admin: !u.is_admin } })
        .then(function () { toast(u.username + " is now " + (u.is_admin ? "a member" : "an admin")); loadPeople(); }).catch(fail);
    } else if (act === "pw") {
      var pw = prompt("New password for " + u.username + " (8+ characters):");
      if (!pw) return;
      api("/api/admin/users/" + u.id + "/password", { method: "POST", json: { password: pw } })
        .then(function () { toast("Password reset. " + (u.id === me.id ? "" : u.username + " will choose a new one at next sign-in.")); }).catch(fail);
    } else if (act === "del" && confirm("Delete " + u.username + " and all of their saved data?")) {
      api("/api/admin/users/" + u.id, { method: "DELETE" }).then(function () { toast("Deleted " + u.username); loadPeople(); }).catch(fail);
    }
  });

  // ================= UPDATES (admin)
  var ghReport = [];
  var STATUS = { current: "Up to date", update: "Update available", "new": "Not installed" };
  function renderReport(report) {
    ghReport = report;
    $("ghList").innerHTML = report.length ? report.map(function (r, i) {
      var vers = r.versions.map(function (v, k) {
        return '<option value="' + v.sha + '">' + esc(v.version) + (k === 0 ? " (latest)" : "") + "</option>";
      }).join("");
      var main = r.status === "update" ? '<button class="btn small primary" data-gh="update">Update now</button>'
               : r.status === "new" ? '<button class="btn small primary" data-gh="add">Add as new app</button>' : "";
      return '<div class="page" data-i="' + i + '"><div class="title">' + esc(r.app ? r.app.title : r.name) +
        '<span class="chip ' + r.status + '">' + STATUS[r.status] + "</span></div>" +
        '<div class="meta">' + (r.app ? "Installed: <b>" + esc(r.app.version) + "</b> · " : "") +
        "Latest in repo: <b>" + esc(r.latest.version) + "</b><br><code>" + esc(r.latest.repo + "/" + r.latest.path) + "</code></div>" +
        '<div class="menu">' + main + (r.app && r.versions.length > 1 ?
          '<select data-gh="ver" style="width:auto;padding:4px 8px;font-size:13px">' + vers + "</select>" +
          '<button class="btn small" data-gh="pick">Install this version</button>' : "") + "</div></div>";
    }).join("") : '<div class="empty">Nothing found yet. Connect your repo below, then tap Check now.</div>';
  }
  function ghStatus(d) {
    var parts = [];
    if (d.last_check) parts.push("Last checked " + when(d.last_check));
    if (d.config && d.config.auto) parts.push("automatic updates on");
    $("ghStatus").innerHTML = (d.last_error ? '<div class="err-box">' + esc(d.last_error) + "</div>" : "") + esc(parts.join(" · "));
  }
  function loadUpdates() {
    return api("/api/admin/updates").then(function (d) {
      var c = d.config;
      $("ghRepo").value = c.repo; $("ghBranch").value = c.branch; $("ghFolder").value = c.folder;
      $("ghToken").value = ""; $("ghToken").placeholder = c.has_token ? "Saved ✓ (leave blank to keep)" : "github_pat_…";
      $("ghForget").classList.toggle("hidden", !c.has_token);
      $("ghAuto").checked = c.auto; $("ghInterval").value = String(c.interval);
      if (!$("ghInterval").value) $("ghInterval").value = "60";
      ghStatus(d); renderReport(d.report);
      markUpdatesTab(!!d.token_alert);
      var tokInfo = $("ghTokInfo");
      if (!tokInfo) { tokInfo = document.createElement("div"); tokInfo.id = "ghTokInfo"; $("ghToken").parentNode.appendChild(tokInfo); }
      if (d.token_alert) {
        tokInfo.innerHTML = '<div class="err-box" style="margin-top:8px"><b>' + esc(tokenTitle(d.token_alert)) + '.</b> <a href="#" data-tokhelp>How to renew it</a></div>';
        tokInfo.querySelector("[data-tokhelp]").onclick = function (e) { e.preventDefault(); var a = Object.assign({}, d.token_alert, { snoozable: false }); showTokenAlert(a); };
      } else {
        tokInfo.innerHTML = d.token_expires ? '<div class="muted" style="margin-top:4px">Token expires ' +
          new Date(d.token_expires * 1000).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) +
          ". You'll get a reminder a week before.</div>" : "";
      }
      $("ghLog").innerHTML = d.log.length ? "<table><tr><th>When</th><th>App</th><th>Version</th><th>How</th></tr>" +
        d.log.map(function (l) {
          return "<tr><td>" + when(l.ts) + "</td><td>" + esc(l.title) + "</td><td>" + esc(l.version) + "</td><td>" +
            ({ auto: "Automatic", manual: "By you", "new": "Added" }[l.how] || esc(l.how)) + "</td></tr>";
        }).join("") + "</table>" : '<div class="muted">No updates installed yet.</div>';
    }).catch(fail);
  }
  $("ghForm").onsubmit = function (e) {
    e.preventDefault();
    api("/api/admin/updates/config", { method: "POST", json: {
      repo: $("ghRepo").value, branch: $("ghBranch").value, folder: $("ghFolder").value,
      token: $("ghToken").value, auto: $("ghAuto").checked, interval: $("ghInterval").value
    } }).then(function () { toast("Saved. Checking your repo…"); return checkNow(); }).catch(fail);
  };
  $("ghForget").onclick = function () {
    if (!confirm("Remove the saved GitHub token? Update checks will stop until you add a new one.")) return;
    api("/api/admin/updates/config", { method: "POST", json: {
      repo: $("ghRepo").value, branch: $("ghBranch").value, folder: $("ghFolder").value,
      auto: $("ghAuto").checked, interval: $("ghInterval").value, clear_token: true
    } }).then(function () { toast("Token removed"); loadUpdates(); }).catch(fail);
  };
  function checkNow() {
    $("ghCheck").disabled = true; $("ghCheck").textContent = "Checking…";
    return api("/api/admin/updates/check", { method: "POST" })
      .then(function () { toast("Checked"); }).catch(fail)
      .then(function () { $("ghCheck").disabled = false; $("ghCheck").textContent = "Check now"; return loadUpdates(); });
  }
  $("ghCheck").onclick = checkNow;
  $("ghList").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-gh]");
    if (!b) return;
    var r = ghReport[b.closest(".page").dataset.i], sha = r.latest.sha, msg;
    if (b.dataset.gh === "pick") {
      sha = b.closest(".menu").querySelector("select").value;
      var v = r.versions.filter(function (x) { return x.sha === sha; })[0];
      if (!confirm("Install version " + v.version + " of " + (r.app ? r.app.title : r.name) + "? Everyone's saved data is kept.")) return;
      msg = "Installed " + v.version;
    } else if (b.dataset.gh === "add") {
      msg = "Added “" + r.name + "”. It's hidden until you choose who can use it in Manage apps.";
    } else {
      msg = "Updated to " + r.latest.version;
    }
    b.disabled = true; b.textContent = "Installing…";
    api("/api/admin/updates/install", { method: "POST", json: { key: r.key, sha: sha, app_id: r.app ? r.app.id : null } })
      .then(function () { toast(msg); loadUpdates(); }).catch(function (err) { fail(err); loadUpdates(); });
  });

  // ================= GitHub token reminder (admins)
  function tokenTitle(a) {
    if (a.state === "expiring") return a.days_left > 0 ? "Your GitHub token expires in " + a.days_left + " day" + (a.days_left === 1 ? "" : "s") : "Your GitHub token expires today";
    if (a.state === "expired") return "Your GitHub token has expired";
    return "GitHub stopped accepting your token";
  }
  function tokenStepsHtml(a) {
    var date = a.expires ? new Date(a.expires * 1000).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : "";
    var lead = a.state === "expiring"
      ? "On " + esc(date) + " PageVault will stop finding app updates until you give it a new token. Your apps and everyone's data aren't affected."
      : a.state === "expired"
        ? "It expired on " + esc(date) + ", so PageVault can't check GitHub for app updates. Your apps and everyone's data are fine."
        : "GitHub turned the saved token down. It may have been deleted or regenerated. Until you add a new one, PageVault can't check for app updates. Your apps and data are fine.";
    return '<p style="margin-top:-4px">' + lead + "</p>" +
      '<ol style="padding-left:20px;margin:10px 0;line-height:1.55">' +
      "<li>Open GitHub's token page (button below). If you get lost: your profile picture → <b>Settings</b> → <b>Developer settings</b> → <b>Personal access tokens</b> → <b>Fine-grained tokens</b>.</li>" +
      "<li>Click your PageVault token, then <b>Regenerate token</b>. Pick a new expiration and confirm. It keeps the same repos and permissions.</li>" +
      "<li><b>Copy the new token</b>. GitHub only shows it once.</li>" +
      "<li>Back here, go to <b>Updates</b>, paste it into <b>Access token</b> and click <b>Save</b>.</li></ol>" +
      '<div class="row" style="margin-top:6px">' +
      '<a class="btn primary" style="text-decoration:none" target="_blank" rel="noopener" href="' + esc(a.github_url) + '">Open GitHub token page ↗</a>' +
      '<button type="button" class="btn" data-tok="paste">Paste new token</button>' +
      (a.snoozable === false ? "" : '<button type="button" class="btn" data-tok="later">Remind me tomorrow</button>') + "</div>";
  }
  function showTokenAlert(a) {
    openDialog(tokenTitle(a), tokenStepsHtml(a), null, null);
    dlgForm.querySelectorAll("[data-tok]").forEach(function (b) {
      b.onclick = function () {
        dlg.close();
        if (b.dataset.tok === "later") api("/api/admin/updates/snooze", { method: "POST" }).then(function () { toast("I'll remind you tomorrow"); }).catch(fail);
        else { showTab("updates"); setTimeout(function () { $("ghToken").focus(); $("ghToken").scrollIntoView({ block: "center" }); }, 300); }
      };
    });
  }
  function markUpdatesTab(on) {
    var b = document.querySelector('#tabs button[data-tab="updates"]');
    if (b) b.innerHTML = "Updates" + (on ? ' <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--danger);vertical-align:2px" title="Token needs attention"></span>' : "");
  }

  // ================= ACCOUNT
  $("pwForm").onsubmit = function (e) {
    e.preventDefault();
    api("/api/account/password", { method: "POST", json: { current: $("pwCur").value, new: $("pwNew").value } })
      .then(function () { toast("Password updated"); $("pwForm").reset(); }).catch(fail);
  };

  // ================= boot
  api("/api/me").then(function (d) {
    if (!d.user) { location.href = "/login"; return; }
    me = d.user;
    $("who").textContent = me.username;
    var brand = document.querySelector(".brand");
    if (brand && d.version) { var v = document.createElement("span"); v.className = "chip"; v.title = "PageVault version"; v.textContent = d.version; brand.appendChild(v); }
    if (me.must_change) {
      $("tabs").classList.add("hidden");
      $("tab-apps").classList.add("hidden");
      $("forcePw").classList.remove("hidden");
      $("forceForm").onsubmit = function (e) {
        e.preventDefault();
        $("fpErr").textContent = "";
        if ($("fpNew").value !== $("fpConfirm").value) { $("fpErr").textContent = "Passwords don't match."; return; }
        api("/api/account/password", { method: "POST", json: { new: $("fpNew").value } })
          .then(function () { location.reload(); })
          .catch(function (err) { $("fpErr").textContent = err.message; });
      };
      return;
    }
    document.querySelectorAll(".admin-only").forEach(function (el) { el.classList.toggle("hidden", !me.is_admin); });
    if (me.is_admin) api("/api/admin/apps").then(function (r) { people = r.users; }).catch(function () {});
    if (me.is_admin && d.token_alert) { markUpdatesTab(true); setTimeout(function () { showTokenAlert(d.token_alert); }, 400); }
    loadApps();
  }).catch(fail);
})();
