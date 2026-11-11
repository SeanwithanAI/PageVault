(function () {
  var mode = "login", info = null;
  var $ = function (id) { return document.getElementById(id); };
  var next = new URLSearchParams(location.search).get("next") || "/";
  if (!/^\/(?!\/)/.test(next)) next = "/";

  function setMode(m) {
    mode = m;
    var reg = m === "register";
    $("heading").textContent = info.first_run ? "Create the admin account" : reg ? "Create an account" : "Sign in";
    $("submit").textContent = reg ? "Create account" : "Sign in";
    $("confirmRow").classList.toggle("hidden", !reg);
    $("password").autocomplete = reg ? "new-password" : "current-password";
    $("intro").classList.toggle("hidden", !info.first_run);
    $("intro").textContent = "Welcome! The first account you create is the administrator. You can add other people afterwards.";
    var sw = $("switchRow");
    sw.textContent = "";
    if (!info.first_run && info.registration_open) {
      var a = document.createElement("a");
      a.href = "#";
      a.textContent = reg ? "Have an account? Sign in" : "New here? Create an account";
      a.onclick = function (e) { e.preventDefault(); setMode(reg ? "login" : "register"); };
      sw.appendChild(a);
    }
    $("err").textContent = "";
  }

  $("form").addEventListener("submit", function (e) {
    e.preventDefault();
    $("err").textContent = "";
    if (mode === "register" && $("password").value !== $("confirm").value) {
      $("err").textContent = "Passwords don't match.";
      return;
    }
    $("submit").disabled = true;
    fetch("/api/" + mode, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PV": "1" },
      body: JSON.stringify({ username: $("username").value, password: $("password").value })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok) location.href = next;
        else { $("err").textContent = res.d.error || "Something went wrong."; $("submit").disabled = false; }
      })
      .catch(function () { $("err").textContent = "Can't reach the server."; $("submit").disabled = false; });
  });

  fetch("/api/me").then(function (r) { return r.json(); }).then(function (d) {
    if (d.user) { location.href = next; return; }
    info = d;
    setMode(d.first_run ? "register" : "login");
  });
})();
