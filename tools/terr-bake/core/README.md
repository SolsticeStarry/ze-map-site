# Terrain and entity baking archive

This folder contains the baking scripts and the generated files used by the 3D preview.

## Layout

```
tools/terr-bake/
├── start-bake.cmd     # double-click: start (as SYSTEM) then show status
├── stop-bake.cmd      # double-click: stop
├── status-bake.cmd    # double-click: show progress
└── core/              # everything else: scripts, data, toolchain, logs
```

Only the three launchers sit at the top level. All scripts resolve their own location, so everything else lives in `core/`.

## Prerequisites

- Windows with PowerShell 5.1+ (Windows PowerShell or PowerShell 7).
- [Node.js](https://nodejs.org/) 18 or newer on `PATH`.
- Internet access on first setup (to fetch steamcmd and the Source2Viewer CLI).

## Setup

The only thing to install by hand is **Node.js 18+**.

After cloning the repo, just double-click `start-bake.cmd` the first time. It self-elevates and
`bootstrap.ps1` takes care of the rest, then starts the bake:

- downloads the repo-local toolchain into `tools/terr-bake/core/.tools/` (via `setup.ps1`):

  - `steamcmd/` — anonymous Steam Workshop downloads.
  - `s2v/Source2Viewer-CLI.exe` — extracts VPKs and decompiles entities/physics.
  - `node_modules/` (in this folder) — `meshoptimizer`, used by `bake-terrain.mjs`.

- registers the SYSTEM scheduled task `ze-terr-bake-svc` (via `install-task.ps1`).

It is idempotent: once the toolchain and task are in place, later double-clicks skip straight to
starting. If you prefer the manual route (both need an admin shell), run `core\setup.ps1` and then
`core\install-task.ps1`.

`.tools/`, `node_modules/`, `work/` and `bounds/` are git-ignored, so each machine keeps its own
copy. `done.txt` / `failed.txt` (the bake records) and `bake-manifest.json` **are** committed, so
every machine shares the same "already baked" state.

### How the background task works

The launchers drive a SYSTEM scheduled task, so the job keeps running after the RDP session is
disconnected or the user logs off (it runs in session 0, not in your desktop session). The task
`ze-terr-bake-svc` (principal `SYSTEM`, highest privileges) points at `watchdog.ps1`.
`start-bake.cmd` only starts that task, so it must be registered first — `bootstrap.ps1` does this
automatically (manual failures are written to `core/start.log`).

## Run

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\core\bake-all.ps1 -MaxMaps 2 -Random -Parallel 1
```

### Unattended / remote (double-click and disconnect)

Double-click `start-bake.cmd` (it self-elevates), then you can disconnect RDP — the work runs in the
SYSTEM task. While running, `run-to-end.ps1` holds a `SetThreadExecutionState` request so the machine
does **not** go to sleep on the idle timer after the session is gone; the request is released right
before the final `Action` runs.

- The run does **not** hibernate/sleep/shutdown by default (`-Action none`). Pass
  `-Action hibernate|sleep|shutdown` to `launch.ps1` if you do want that when it finishes.
- Clicking `start-bake.cmd` again rotates a finished `run-to-end.log` so a new run actually starts
  (watchdog otherwise refuses to relaunch a `FINISHED` run).
- `stop-bake.cmd` stops the current run (it keeps `done.txt`, so a later run resumes).

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\core\bake-all.ps1 -MaxMaps 2 -Random -Parallel 1
```

- `bake-all.ps1` reads the Workshop IDs from `capped.txt`, downloads any that are missing, then bakes them in parallel (default `-Parallel 4`).
- `bake-one.ps1` bakes a single map and is called by `bake-all.ps1`.

### Useful switches

- `-MaxMaps N` limit how many maps this run processes.
- `-Random` pick `N` random maps instead of the first ones.
- `-RetryFailed` re-run only the IDs in `failed.txt`.
- `-KeepDownloaded` keep VPKs that were downloaded by steamcmd (see below).
- `-IdsFile <path>` read the target IDs from a specific file instead of `capped.txt`.
- `-IgnoreDone` ignore `done.txt` and bake every ID in the list (used to re-bake updated maps).

### Paths

By default everything is repo-local. Override if needed:

- `-ToolsRoot <dir>` where `steamcmd/` and `s2v/` live (default `tools/terr-bake/core/.tools`).
- `-SteamCmd <exe>` / `-Source2Viewer <exe>` explicit tool paths.
- `-LocalCache <dir>` your Steam client's `steamapps\workshop\content\730`; auto-detected from the standard Steam install path when present.

## Pipeline

For each map ID:

1. Locate the VPK in the local Steam cache or the steamcmd download cache.
2. Extract the inner `maps/<map>.vpk`, then decompile `entities/default_ents.vents_c`.
3. `extract-entities.mjs` + `build-entity-bin.mjs` produce `public/entity/data/2001-<map>-<id>.bin`.
   Brush entities have no `box_mins/box_maxs` in the vents dump, so `extract-bounds.mjs` reads the
   per-entity brush model (`maps/<map>/entities/*.vmdl_c`, exported to GLB) to recover their real
   world-axis-aligned size; entities with no model fall back to a per-class typical size.
4. Export `world_physics.vmdl_c` to GLB, then `bake-terrain.mjs` writes `public/terr/<id>.bin`.
5. A VPK that had to be downloaded (only present in the steamcmd cache, not the local Steam cache) is deleted after a successful bake, so the next run re-downloads it on demand. Pass `-KeepDownloaded` to keep them. Local Steam cache VPKs are never touched.

`done.txt` records successful IDs so they are skipped on later runs; failures go to `failed.txt`.

## Incremental baking

`run-to-end.ps1 -Incremental $true` (the default when started through `launch.ps1` / `start-bake.cmd`) only bakes maps that actually need it, so a normal run adds a small commit instead of re-baking all ~548 maps at once (~180 MB of history added every time).

`select-bake.mjs` selects a map when any of these holds:

1. **output missing** — no `public/terr/<id>.bin` or `public/entity/data/*-<id>.bin`;
2. **updated on the Workshop** — the item's `time_updated` is newer than the version recorded in `bake-manifest.json`;
3. **backlog** — an existing output that was never recorded (e.g. inherited data).

```powershell
node .\core\select-bake.mjs --json                      # select only, do not bake
powershell -File .\core\launch.ps1 -Incremental $true    # full incremental run, then stop (no hibernate)
powershell -File .\core\launch.ps1 -Incremental $false   # legacy: bake everything not in done.txt
# or just double-click start-bake.cmd in the parent folder
```

`bake-manifest.json` records, per Workshop ID, the `time_updated` that a baked output corresponds to, so untouched maps are skipped on later runs. It is intended to be committed.

Records are only ever added, never overwritten with a newer version: at start, `--seed` fills entries for maps that have no record yet; after baking, `--record <file>` stores the current `time_updated` for exactly the maps baked in that run. This is what lets a later run detect "the Workshop item changed since we baked it".

`incremental.txt`, `incremental-chunk.txt` and `baked-this-run.txt` are runtime scratch and are git-ignored.
