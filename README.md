# @dsh-external/dsh-client-ui-skin-manager

A skin manager for the DSH web GUI: it adds a **皮肤 / Skins page to the DSH
settings dialog**, lists the skins installed in the current profile, lets you
pick the active one, and switches the whole interface between the **stock UI**
and a **skin** with one click. It renders no floating overlay, so it never covers
the shell's own controls, and it survives another agent installing a skin the
documented way.

## Install the manager

1. Copy this package into the profile's plugin directory:

   ```
   <DSH_HOME>/profiles/web/node_modules/@dsh-external/dsh-client-ui-skin-manager/
   ```

   (`dsh plugin --profile web add <path-or-git-url>` also works when the launcher
   can reach `pnpm`; the plain copy needs no package manager.)
2. Wire it — either run the bundled installer, or add the row yourself:

   ```sh
   node "<...>/dsh-client-ui-skin-manager/install.mjs"
   ```

   ```yaml
   # $DSH_HOME/cordis.patch.yml
   - insert:
       - id: ui-skin-manager
         name: '@dsh-external/dsh-client-ui-skin-manager'
   ```
3. Restart DSH (or just refresh the page when it was already running), then open
   **设置 → 皮肤**. With no skin installed the page says so and offers the stock UI.

Tested against DSH `0.1.5-rc.1` with the `0.1.5-rc.2` web client packages
(`dsh-client-ui-renderer`, `dsh-client-locale`, `dsh-client-ui-settings`).
Also see [`AGENT-INSTALL.md`](AGENT-INSTALL.md): a minimal guide to hand to an AI
assistant that is asked to install a skin.

## What it does

- **Discovery** — scans the profile's `node_modules` for packages exposing a
  `skin.json` (`@scope/name/skin.json` or `name/skin.json`), tolerating a UTF-8
  BOM, and ignores everything else including itself.
- **Selection** — persists the choice in
  `$DSH_HOME/profiles/<profile>/data/dsh-client-ui-skin-manager/settings.json`.
- **Live switch** — applies the choice to the RUNNING loader immediately
  (`entry.update({ disabled })` for every entry of a skin's package). Disabling an
  entry removes both halves of a skin: its client module leaves the served page and
  its host route is disposed. No DSH restart is needed.
- **No double mounts** — a skin the composed tree has not mounted yet is reported as
  `未接入` (with the choice persisted) instead of being created on the side: the
  managed block already carries its insert, so a second entry created here would
  make the package mount twice as soon as that insert applied.
- **Two-layer wiring** — the manager's own row and one marked block live in the
  HOME layer (`$DSH_HOME/cordis.patch.yml`); the profile layer
  (`profiles/<name>/cordis.patch.yml`) is left to the user and to other
  installers. The home layer is applied after the profile layer, so:
  - a skin that another agent wired in the profile layer is **adopted** — the
    manager only overrides its enablement, so the composed tree keeps exactly one
    entry per skin and the enable/disable decision still wins;
  - an agent that rewrites the profile layer cannot delete the manager itself.
- **Settings page** — contributes a `settings.section` page ("皮肤" / "Skins")
  through the shell's slot system, localized via `ctx.locale`.
- **Stock UI** — "原版 UI" disables every skin row, leaving the untouched
  interface (skin settings stay on disk and return when re-enabled).

## Using it

Open **设置 → 皮肤** (Settings → Skins). The page is ONE radio list — no mode
buttons, no actions to remember:

| Row | Effect when clicked |
|---|---|
| 原版 UI (first row) | disable every skin → stock interface |
| a skin row | make that skin the active one; every other skin is disabled |

So any number of installed skins stays a single click away, and the current
choice is always visible as the filled radio (plus a `使用中` badge on the row
that the loader reports as effective).

Each skin row shows its preview image, name, author and tagline, and a badge:
`使用中` (effective), `待生效` (written, loader still switching) or `未接入`
(no loader row yet). The page waits for the host to report the new effective
state and then reloads the page once — a skin's client half can only be loaded or
dropped by a fresh page load; a switch normally lands within a second.

## Installing another skin (including by another agent)

Any of these work, and none of them needs the manager to be reconfigured:

1. **Package only** — drop the package into
   `profiles/<profile>/node_modules/@scope/name/` (or
   `dsh plugin --profile web add <path-or-git-url>`), or just run
   `tools/install-skin.mjs <url|owner/repo|dir>`. The manager discovers it on the
   next request, inserts it in its own block, and it appears in the picker; until the
   loader has mounted that insert the row reads `未接入`, and restarting DSH once
   makes it live.
2. **Package plus a patch row** — the step most skin READMEs document
   (`- insert: - id: ui-skin-x / name: '@dsh-external/...'` in the PROFILE layer).
   The manager detects that row, **adopts** it (whatever id it uses) and only
   writes the enable/disable override. It never inserts a second copy.
3. **As a bundle** (`dsh.profile.bundles`) — the skin's own `cordis.patch.yml`
   insert applies from the bundle layer; the manager adopts it the same way.

Skins written for older dsh builds whose host half registers a route with
`return ctx.webServer.register(...)` cannot be re-enabled cleanly (the previous
route is never disposed): run `tools/patch-skin-dispose.mjs <skin-package-dir>`
once per skin.

## Layout

| Path | Role |
|---|---|
| `lib/index.js` | host half: discovery, persistence, `/api/dsh-skin-manager/state`, `/api/dsh-skin-manager/preview`, runtime toggling, layer migration, managed-block writer, bundle re-hash |
| `lib/client.js` | browser half: the 设置 → 皮肤 page (React, no component-library imports) |
| `install.mjs` | copies the package in and owns the HOME layer; `--dry-run` prints both layers, `--files-only` skips the patch layers (used while an older build is still running) |
| `tools/install-skin.mjs` | one-command skin installer (GitHub URL, `owner/repo`, or a local directory) |
| `tools/patch-skin-dispose.mjs` | compatibility shim for older skins' host halves |
| `tools/refresh-served-bundle.mjs` | re-hashes the browser bundle on a running harness (no restart) |
| `AGENT-INSTALL.md` | the minimal install guide to hand to another AI assistant |
| `test/compose.test.mjs` | discovery + wiring-plan + managed-block tests through the real harness composer, including the foreign-wiring scenarios |
| `test/routes.test.mjs` | HTTP-surface tests with fake `req`/`res` and a fake loader |
| `test/client.test.mjs` | browser-half tests: settings registration, rendered list, click path |
| `test/e2e-live.mjs` | drives a running instance end to end (needs its port + launch token) |

Run the tests with `node test/<name>.test.mjs`.

## Updating the plugin itself

The harness caches each package's browser bundle and keeps imported host modules
in Node's ESM cache. The host half re-hashes its own bundle on every mount, so an
update that comes with a restart (or any remount) is picked up automatically; to
refresh a RUNNING harness without a restart, run
`tools/refresh-served-bundle.mjs` (it briefly disables and re-enables the
manager's loader entry through the watched patch layer and verifies the remount
through the host-mount marker). A changed **host** half still needs a restart,
because the running process keeps the module it already imported.

## Notes and limits

- Both routes are loopback-only; the browser reaches them through the existing
  authenticated page session.
- The manager owns the block between its two markers plus its own insert row. The
  markers are written only into the HOME layer; an older build's block left in the
  profile layer is migrated at the next mount.
- A skin row added by hand *inside* the marked block is overwritten — add skins by
  installing the package (or a row next to the block), then use the settings page.
- Discovery walks one `node_modules` level (plus `@scope/`); nested or
  `.dsh-module-fallback` copies are not scanned.
- With no skin installed the page says so and reports mode `vanilla`.
- The page reloads once per switch: a skin's client half is delivered with the
  page's boot payload, so it cannot be added or dropped in an already-loaded tab.

## Troubleshooting

### `dsh` refuses to start: `overlay …/cordis.patch.yml must be a top-level YAML array of loader patch entries`

That patch layer holds only comments, which YAML parses as `null` rather than an
empty array. **Versions before 0.4.1 could leave the profile layer in that state**
while migrating the manager's own wiring into the home layer, and the next start
then failed before any plugin could load.

Repair it without starting `dsh` (this is the whole point of the tool — a stuck
installation cannot boot the harness):

```sh
node "<...>/dsh-client-ui-skin-manager/tools/repair-patch-layer.mjs" --all
```

`--dry-run` reports what it would change first. From 0.4.1 on, every writer in this
package runs its output through the same guarantee, so a comments-only layer can no
longer be produced (the regression is covered by `test/compose.test.mjs`, which
checks the written file with the harness's own patch loader).

### A skin row says `未接入` and switching does nothing

The composed tree has not mounted that skin's entry yet. The choice is already
persisted in the managed block; restart `dsh` once and the row becomes usable. (The
manager deliberately does not create the entry itself — see "No double mounts".)
