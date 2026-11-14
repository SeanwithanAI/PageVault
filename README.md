<div align="center">

<img src="static/favicon.svg" width="72" height="72" alt="PageVault logo">

# PageVault

**A private app portal for your own HTML apps, self-hosted on TrueNAS**

![Version](https://img.shields.io/badge/version-2026--11--14%20mk5-2563eb)
![Python](https://img.shields.io/badge/python-3.12%20·%20stdlib%20only-3776AB)
![TrueNAS SCALE](https://img.shields.io/badge/TrueNAS%20SCALE-24.10%2B-0095D5)
![Dependencies](https://img.shields.io/badge/dependencies-none-16a34a)

*by SeanwithanAI*

</div>

![The app launcher a family member sees after signing in](docs/screenshots/launcher.png)

---

## Overview

PageVault turns single-file HTML apps (A Better Ledger, A Better PTO Tracker, A Better Maintenance Tracker…) into a private, multi-user web portal on your own server.

- **You (admin)** upload apps or pull them from GitHub, give each one a name, logo and link, create accounts, and decide who can use what.
- **Everyone else** signs in and picks from their apps. Whatever an app saves is stored **on your NAS**, separately for each person, and follows them to any device.

It's one Python file and a `static/` folder, using only the Python standard library on the official `python:3.12-alpine` image. There's nothing to build and no third-party packages.

## Screenshots

| Manage apps (admin) | On a phone |
|---|---|
| ![Manage apps: each app with its logo, description, who can use it, version and link](docs/screenshots/manage-apps.png) | ![The launcher on a phone](docs/screenshots/phone.png) |

![Updates tab: each app's installed version compared with the newest one in GitHub](docs/screenshots/updates.png)

<sub>Screenshots use example accounts.</sub>

## Features

### For everyone
- **App launcher.** A tile for each app they're allowed to use, with its logo and description. Works on phones, tablets and desktops.
- **Home and app switcher inside every app.** A small round button floats at the edge of each app. Tap it to go back to the PageVault home page or jump straight to another app (in the person's launcher order, with their favorites first and hidden apps left out). Drag it anywhere and it snaps to the nearest side, and the spot is remembered for that person. It uses its own isolated styles, so it never changes an app's look, and it's hidden when printing.
- **Sort and arrange.** Each person can search their apps, sort them (*My order*, *Name A–Z*, *Recently opened*, *Most opened*), and tap **Arrange** to drag apps into their own order (or move them with ‹ ›), pin favorites to the top with ★, and hide apps they don't use. It's saved to their account, so it's the same on every device.
- **Standalone versions note.** Small print at the bottom of the launcher points to the GitHub repositories for anyone who wants to run the apps on their own, without PageVault.
- **Date, time and weather.** The bottom of the launcher shows the date, a live clock and today's weather: temperature, conditions, high/low, chance of rain, wind and sunrise/sunset. Each person sets their own city or ZIP code (°F/°C and a 12/24-hour clock too). The server fetches the weather from [Open-Meteo](https://open-meteo.com) (free, no key) and caches it for 15 minutes, so the TrueNAS app needs internet access, which it already uses for GitHub updates.
- **Their own data.** Each person's data in each app is private to them.
- **Backups.** Each app's ⋯ menu lets a person **export, restore or erase** their own data.
- **Own password.** New accounts must choose their own password at first sign-in.

### For admins
| Tab | What it does |
|---|---|
| **Manage apps** | Upload an `.html` file or a `.zip` of a whole site. Set the name, logo, description and link, and choose who can use it: selected people, everyone signed in, anyone with the link, or hidden while testing. Upload new versions without losing anyone's data. |
| **People** | Add accounts with a temporary password, choose each person's apps, reset passwords, promote or demote admins, and turn self sign-up on or off (off by default). |
| **Updates** | Watch one or more **private GitHub repos** and install new app versions automatically or with one tap. Roll back to any older version. Reminds you before the GitHub token expires. |
| **Account** | Change your password. |

### Built for reliable data
- **The server is the only copy** (see [Where app data is stored](#where-app-data-is-stored)). Browser storage (`localStorage`, IndexedDB, cookies, Cache Storage) is blocked inside apps. Apps that use `localStorage` work unchanged, because it's redirected to the server. Nothing is left in a browser to go out of sync.
- **Conflict protection.** Every saved value has a version. A stale tab or device can't overwrite newer data; it's asked to reload instead.
- **Saves on close.** Changes made right before a tab closes still reach the server.
- **Attachments.** Apps can store files such as receipts and PDFs, up to 25 MB each.

## Where app data is stored

Where an app saves depends on **how it's opened**. It's always one place or the other, never both.

| How the app is opened | Where its data is saved | What the app shows |
|---|---|---|
| **Through PageVault** (from the launcher or an `/a/<app>/` link) | **On the server only**, in the `data` dataset, separately for each signed-in person. Nothing is kept in the browser, so it follows you to any device. | **Saved to your server** |
| **On its own** (the `.html` file opened directly in a browser) | **In that browser on that device only.** Other devices and other browsers won't see it. | **Saved on this device only** |

- **Signed out:** visitors to an app shared as *Anyone with the link* can use it, but nothing they do is saved.
- **Backup reminders:** inside PageVault the apps don't nag for backups, because the server keeps the data. Opened on their own, they remind you to download a backup now and then.
- **Moving data between the two:** use the app's own **Export / Back up** on one side and **Import / Restore** on the other. In PageVault, each app's **⋯** menu also has **Export my data** and **Import my data from a backup**.
- **Current versions with the status label:** A Better Ledger mk6+, A Better PTO Tracker mk4+, A Better Maintenance Tracker mk14+.

## Installation (TrueNAS SCALE 24.10+)

This server uses three datasets, created with the **Apps** dataset preset:

| Dataset | Holds |
|---|---|
| `Storage/Configs/PageVault/code` | This repository (`server.py`, `static/`) |
| `Storage/Configs/PageVault/apps` | Uploaded HTML apps |
| `Storage/Configs/PageVault/data` | Accounts and everyone's saved data. **Snapshot this one.** |

1. **Put the code in place.** Download this repository into the `code` dataset; see [Updating PageVault](#updating-pagevault). The folder should contain `server.py` and `static/` directly.
2. **Install the app.** Go to **Apps → Discover Apps → ⋮ → Install via YAML**, name it `pagevault`, and paste [`truenas-app.yaml`](truenas-app.yaml). The paths are already set for this server.
3. **Open it.** Go to `http://<truenas-ip>:8090`. The first account created becomes the admin.
4. **Connect GitHub.** In **Updates**, list the app repos, paste a read-only token, and click **Add as new app** on each.

**If it won't start:** check **Apps → pagevault → Logs**. "Permission denied" means the `apps` user can't use a dataset. Fix it with **Datasets → Edit Permissions**.

## Updating PageVault

PageVault's own updates are released to this repository. Your NAS downloads them with `git`, using the same read-only token as the Updates tab. The token must include this repo with **Contents: Read-only**.

**One-time setup** (TrueNAS shell, as root: **System → Shell**, then `sudo -i`):

```sh
cd /mnt/Storage/Configs/PageVault/code
git init -b main
git remote add origin https://x-access-token:YOUR_TOKEN@github.com/SeanwithanAI/PageVault.git
git fetch origin main
git reset --hard origin/main
git branch --set-upstream-to=origin/main main
```

**Each update:**

```sh
cd /mnt/Storage/Configs/PageVault/code && git pull
```

Then restart the app (**Apps → pagevault → Restart**). The new version number appears next to the PageVault name on the home screen. Your apps and data live in other datasets and are never touched.

**When the token is renewed:**

```sh
cd /mnt/Storage/Configs/PageVault/code
git remote set-url origin https://x-access-token:NEW_TOKEN@github.com/SeanwithanAI/PageVault.git
```

## App updates from GitHub

PageVault reads app names and versions from file names:

```
A-Better-PTO-Tracker-2026-11-11-mk3.html             →  A Better PTO Tracker · 2026-11-11 mk3
A_Better_Ledger_2026-11-11_mk6_by_SeanwithanAI.html   →  A Better Ledger · 2026-11-11 mk6
A_Better_Ledger_2026-11-12_by_SeanwithanAI.html       →  A Better Ledger · 2026-11-12
```

Each new version is a new file in the app's repo. The newest date wins; on the same day, `mk1` is newer than the plain date, `mk2` newer than `mk1`, and so on. Updates keep the app's link, name, logo, access and everyone's data. With **Install updates automatically** on, PageVault checks on the schedule you choose.

## Writing apps for PageVault

- **Paths:** use relative paths (`assets/app.js`, not `/assets/app.js`).
- **Saving data:** `localStorage` is saved to the server automatically; nothing else is needed. `sessionStorage` works but isn't saved.
- **Extra API:** `window.PageStore` is available for more control.

```js
PageStore.setJSON("trips", list);              // save any JSON value
const list = PageStore.getJSON("trips", []);   // read it back
await PageStore.flush();                       // wait until it's on the server
PageStore.pending / PageStore.conflicted       // save status
const f = await PageStore.files.put(file);     // store an attachment
img.src = PageStore.files.url(f.id);           // show it
PageStore.user                                 // signed-in username
PageStore.persistent                           // false for signed-out visitors
const owned = await PageStore.relay(url);      // fetch an allowed outside service through the server
const art = await PageStore.relay(url, {auth: key}); // SteamGridDB only: sends your key as a Bearer token
```

**Relay (`PageStore.relay`).** Some services, such as Steam's Web API, only answer servers, and some browsers (Brave on iPhone) block an app's own requests. `PageStore.relay(url)` asks PageVault to fetch the address and hand back the JSON. It only reaches these services:

| Service | Allowed |
|---|---|
| Steam Web API (`api.steampowered.com`) | Owned games, recently played games, player summaries, vanity-name lookup |
| RAWG game database (`api.rawg.io`) | Game, genre, tag, platform, developer, publisher, store and creator lookups |
| SteamGridDB (`www.steamgriddb.com`) | Game search and box-art (grid) lookups. The app passes the person's own key with `PageStore.relay(url, {auth: key})`; it's sent only to SteamGridDB. |

Only signed-in people can use it, only with GET, and it's limited to `RELAY_PER_MIN` requests a minute per person. Nothing is stored, and the address (which may contain an API key) isn't written to the log.

## Configuration

Set in the `environment:` section of `truenas-app.yaml`:

| Variable | Default | Purpose |
|---|---|---|
| `MAX_UPLOAD_MB` | 100 | Largest app upload |
| `STORE_QUOTA_MB` | 200 | Saved data and files allowed per person |
| `MAX_VALUE_MB` | 10 | Largest single saved value |
| `MAX_FILE_MB` | 25 | Largest attachment |
| `MAX_IMAGE_MB` | 5 | Largest app logo |
| `SESSION_DAYS` | 30 | How long a sign-in lasts |
| `VIEW_TOKEN_HOURS` | 24 | How long an open app keeps saving before it needs a reload |
| `COOKIE_SECURE` | 0 | Set to `1` when served over HTTPS |
| `RELAY_PER_MIN` | 600 | Relay requests allowed per person per minute |
| `STANDALONE_URL` | `https://github.com/SeanwithanAI?tab=repositories` | Where the launcher's “Want the standalone versions?” note links. Set it to an empty value to hide the note. |

**Remote access:** PageVault speaks plain HTTP. For access away from home, use Tailscale, a Cloudflare Tunnel or a reverse proxy with HTTPS, and set `COOKIE_SECURE: "1"`. Don't expose the port directly to the internet.

## Security

- Every app runs in a **browser sandbox with its own isolated origin**. Apps can't read the sign-in cookie, call admin functions, or touch another app's or person's data.
- Passwords are hashed with **scrypt**. Sign-in is rate-limited, admin actions are protected against cross-site requests, and admin checks are enforced on the server.
- Zip uploads are checked for unsafe paths and zip bombs. Logos and attachments are type-checked and served sandboxed.
- The GitHub token is stored only in the `data` dataset and is never sent to browsers.
- Weather lookups go from the server to Open-Meteo with only the rounded coordinates of the place a person picked. A person's location is saved only in their own launcher settings, and browsers never contact the weather service directly.

## Backups

Snapshot the **`data`** dataset; it holds `pagevault.db`, `secret.key` and attachments. Snapshot **`apps`** too, or simply re-install apps from GitHub. People can also export their own data from each app's ⋯ menu.

## Project structure

```
server.py            the whole server (Python standard library)
static/
  app.html, app.js   dashboard: launcher, Manage apps, People, Updates, Account
  login.html/.js     sign-in, first-run admin setup
  sdk.js             injected into every app: server storage, files, conflict protection
  style.css          styles (light and dark)
  favicon.svg        logo
truenas-app.yaml     TrueNAS "Install via YAML" definition
Dockerfile           optional: build a self-contained image instead
docs/screenshots/    README images
```

## Changelog

| Version | Notes |
|---|---|
| **2026-11-14 mk5** | Apps can offer **Download this app**: PageVault hands over the app's file exactly as installed, under its original name (single-file apps only). |
| **2026-11-14 mk4** | Removed the imports folder added in mk3 (Ayn Thor playtime is now imported by hand in the tracker). If you added `IMPORTS_DIR` or an `imports` volume to the app's YAML, you can take them out. |
| **2026-11-14 mk3** | Imports folder for automatic Cocoon playtime (removed in mk4). |
| **2026-11-14 mk2** | Relay can reach SteamGridDB (box art) with the person's own key, which is sent only to SteamGridDB and never logged. |
| **2026-11-14 mk1** | Relay for apps (`PageStore.relay`): signed-in apps can fetch Steam's Web API and RAWG through the server, including in Brave on iPhone. Used by A Better Backlog Tracker for automatic Steam playtime sync. |
| **2026-11-14** | A home and app-switcher button inside every app (drag to move, position saved per person). Note at the bottom of the launcher linking to the standalone versions on GitHub (`STANDALONE_URL`). |
| **2026-11-13** | Launcher: search, sort (My order, Name A–Z, Recently opened, Most opened), **Arrange** mode (drag or ‹ › to reorder, ★ to pin to the top, Hide/Show), saved per person on the server. New date, time and weather bar at the bottom (Open-Meteo, set by city or ZIP, °F/°C, 12/24-hour). New tables `user_prefs` and `app_usage` are added automatically. |
| **2026-11-12** | Version numbering: the first release of a day is just the date, then `mk1`, `mk2`… for later releases that day. PageVault now sorts these correctly (a plain date comes before that day's `mk1`). |
| **2026-11-11 mk5** | The PageVault version is now shown to everyone (next to the PageVault name on the home screen), not just admins. |
| **2026-11-11 mk4** | Fix for **Brave on iPhone**: its blocker refuses requests from inside apps (*"WKWebView API client did not respond to this postMessage"*), so nothing saved. Apps now fall back to a background form submission when that happens, with the same conflict protection, attachments and error messages. Other browsers are unchanged. |
| **2026-11-11 mk3** | Save problems now say what went wrong: *"The server couldn't save your change (error 500: …)"* when the server refuses, *"Can't reach the server (no connection …)"* when the request never arrives, and a separate message when access is refused. Details are also written to the browser console. |
| **2026-11-11 mk2** | Fix: apps could get stuck showing *"Can't reach the server"* (seen in Brave/Chrome on phones) when a save contained characters like "–" or emoji. The size limit for saves made while a tab closes is now measured in bytes, and if the browser refuses one it's resent normally. |
| **2026-11-11 mk1** | First release. App launcher, admin portal (apps, people, logos, access), per-person server storage with conflict protection, attachments, GitHub updates for apps across several repos, token expiry reminders, forced password change at first sign-in. |

---

<div align="center"><sub>PageVault · by SeanwithanAI · private repository</sub></div>
