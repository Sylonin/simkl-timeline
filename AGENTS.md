# Simkl Timeline

A Pebble watch app that puts upcoming episodes and movie releases from the user's Simkl lists on the Pebble timeline. `README.md` describes what users see. `docs/design.md` describes how the parts work together, the message protocol, storage and pin ids. When a change alters something `docs/design.md` describes, update it in the same commit.

The app needs the Core Devices Pebble app 1.18 or later with plugins turned on. Rebble and older Pebble apps can't run it.

## Layout

| Path | Runs in | Job |
| --- | --- | --- |
| `src/c/` | watch | List, detail and sign-in windows, the daily Wakeup sync, the app glance. `comm.c` handles AppMessage, `model.c` holds state and persistent storage, `ui.c` holds fonts and date formatting. |
| `src/pkjs/index.js` | PebbleKit JS on the phone | Bridge between the watch (AppMessage) and the plugin (`Pebble.invokeAction`). Draws the sign-in QR code with `qrcode-generator`. |
| `src/plugin/index.js` | plugin engine on the phone | All Simkl logic: sign-in, list sync, schedules, timeline pins, Mark watched. |
| `src/config.html` | bundled settings page | One file with inline script. Talks to the plugin through `Pebble.sendMessage('plugin', …)`. |
| `test/` | Node | Plugin tests. `world.cjs` is the fake phone and the fake Simkl. |
| `package.json` | | Manifest: uuid, platforms, permissions, plugin actions, message keys, resources. |
| `resources/images/`, `appstore/` | | Launcher icons and store icons (see Icons). |
| `devenv.nix`, `devenv.yaml`, `.envrc` | | Dev shell: Node.js, pebble-tool, the emulator's libraries, git hooks. |

## Commands

`devenv.nix` provides Node.js, pebble-tool 5.1.2 in a Python 3.12 venv, and the shared libraries that the emulator (qemu-pebble) loads through nix-ld. `.envrc` loads it with direnv, so run commands directly in this directory. pebble-tool keeps the SDK (4.44) in `~/.local/share/pebble-sdk`; on a new machine run `pebble sdk install latest` once.

The shell has no host C compiler and unsets `CC` and `AR`, because waf would use them instead of the SDK's ARM compiler (`gcc: error: unrecognized command-line option '-mthumb'`). Don't add a C compiler to `devenv.nix`.

`git commit` runs ripsecrets (a secret scanner) and treefmt (nixfmt) through prek. Run them on every file with `prek run --all-files`.

```sh
pebble build                                  # all seven platforms; runs npm install first
npm test                                      # plugin tests: node --test test/*.test.cjs
pebble install --emulator emery               # Pebble Time 2
pebble screenshot --emulator emery --no-open --scale 3 /tmp/shot.png
pebble emu-button --emulator emery click select   # back, up, select, down; --duration, --repeat
pebble emu-app-config --emulator emery --uuid 4b7b70e6-67aa-4071-a811-2c4f6cfa316f   # the bundled settings page
pebble kill && pebble wipe                    # stop a stuck emulator and clear its storage
```

Setup problems seen on this machine:

- Without a display, add `--vnc` to every command that takes `--emulator`.
- The first install after the emulator starts often fails with `Connection refused`. Retry every 10 seconds until it prints `App install succeeded`.
- `pebble logs --emulator emery` prints nothing through a pipe. Run it under a pty: `script -q -f -c "pebble logs --emulator emery" /tmp/logs.txt`.
- After changing `messageKeys`, run `pebble clean` before building. waf doesn't regenerate `message_keys.auto.h`.

## Verifying a change

- Plugin: run `npm test`, and add or change a test in `test/` for new behaviour. The emulator doesn't enforce the plugin engine's limits, so the tests are the only check of them.
- Watch app: build, install, take a screenshot and press through the changed screens. Check emery first, then one platform from each display group: basalt (colour), chalk or gabbro (round), diorite (black and white). Check aplite when memory use changes. The build prints each platform's free heap; aplite has about 6.8 KB.
- PKJS and settings page: install on the emulator and open the page with `pebble emu-app-config`. The browser ignores `pebblejs://close#`, so the page stays open after Save.
- The emulator can't show pins inserted by the plugin, a pin's Mark watched button (`pluginAction`), or Android's `localStorage` behaviour. Those need the real Pebble app. Report them as unverified.

## Rules that are easy to break

### Plugin engine

- No timers and no browser globals. On Android, `setTimeout`, `setInterval`, `navigator`, `window`, `document` and similar throw "not available to plugins". iOS doesn't have them. When the plugin has to wait, it saves its progress and answers `wait:<ms>` (actions) or `retryAfterMs` (settings page), and the caller waits.
- No `localStorage`. PKJS shares it, and on Android PKJS writes its own stale copy back when it stops. Plugin state lives in `Pebble.secureStorage`. PKJS gets what the watch shows from the `watch_data` action.
- No state in variables between requests. The Pebble app starts the script fresh for every request.
- An action gets 20 seconds. `sync` stops starting new steps after `STEP_BUDGET_MS` (12 s) and answers `more`, and PKJS calls it again.
- Treat only a `TypeError` from `fetch` as "offline".
- `insertTimelinePin`, `deleteTimelinePin` and `pluginAction` need Pebble app 1.18. On 1.17 the plugin runs without them, so tell the user to update the Pebble app, not to turn plugins on.
- `test/world.cjs` reproduces these limits: getters that throw for timers, browser globals and `localStorage`, and a fresh vm context for every call. Keep it in step with the real engine.

### Simkl API terms

- Don't call the watchlist endpoints (`/sync/*`) without a user action. The scheduled Wakeup sync only reads the public calendar files on `data.simkl.in`.
- Pull lists one request at a time. Movie lookups may run 3 at once.
- Every request carries `app-name` and `app-version`. Every pin links to the item's Simkl page, as Simkl's attribution rule requires.
- Refresh the token only within a day of expiry or after a `401`, and re-read the stored token first.
- A new host needs its own `Internet` entry in `usesPermissions`. The Pebble app blocks undeclared domains.

### Watch and phone contract

- `Cmd` numbers, `State` values and `ItemFlags` bits are defined in three places: `src/c/comm.h` and `src/c/model.h`, `src/pkjs/index.js`, and the Messages table in `docs/design.md`. Change all three together.
- Watch strings have fixed buffers (`TITLE_LEN` and the others in `model.h`). PKJS cuts every string with `truncateUtf8`, on a UTF-8 character boundary. Use it for any new text field.
- The watch holds its messages until PKJS sends `READY`, or for 6 seconds. PKJS sends one AppMessage at a time, because a second one in flight is rejected.
- The app glance template string can't exceed 150 bytes, and app glances don't exist on aplite.

### Watch storage

- Key 1 holds `Meta`. Keys 16 to 31 hold one `Item` each. A persist key holds at most 256 bytes, and `_Static_assert`s in `model.c` check both structs.
- Bump `META_VERSION` in `model.c` when the layout of `Meta` or `Item` changes. Older data is then dropped instead of misread.
- Aplite has about 7 KB of heap. A full list needs about 4.5 KB while it arrives.

### Releases

- `version` in `package.json` and `APP_VERSION` in `src/plugin/index.js` must match. `pebble build` rewrites the version in `package-lock.json`; commit that file too.
- The Pebble app ignores an insert under a pin id that was deleted, so an item that returns gets `-2`, `-3` and so on appended (`pinIdFor`).

## Icons

- Launcher icons are 25×25 PNGs in `resources/images/`. The `~color` and `~bw` suffixes select a file per platform.
  - `menu_icon~color.png`: greyscale with transparency, for basalt, chalk, emery and gabbro. Colour launchers show apps in greyscale anyway.
  - `menu_icon~bw.png`: pure black and white, no transparency, for aplite, diorite and flint. These launchers invert it on the highlighted row.
- `package.json` lists the icon twice, split by `targetPlatforms`, because only the black-and-white entry has `memoryFormat: 1Bit`. Only one entry may set `menuIcon: true`: the SDK rejects a second one even when the platform lists don't overlap, although the SDK guide's example sets it twice. Both entries are named `IMAGE_MENU_ICON`, so every platform gets the icon.
- Store icons: `appstore/icon.svg` is the source. Render `icon-small.png` (80×80) and `icon-large.png` (144×144) from it with `rsvg-convert -w 80 -h 80 appstore/icon.svg -o appstore/icon-small.png`, and pass them to `pebble publish --icon-small … --icon-large …`.
- The aplite emulator has no launcher, so the aplite icon can only be checked on a watch.

## Conventions

- C: `#pragma once`; static functions start with `prv_`; public functions start with their module name (`model_`, `comm_`, `ui_`). Handle platform differences with `PBL_IF_ROUND_ELSE`, `PBL_IF_COLOR_ELSE` and `PBL_PLATFORM_*`.
- PKJS and plugin: `var` and function declarations, no arrow functions. Match the existing style.
- Tests: CommonJS `*.test.cjs` files using `node:test`.
- Commits: Conventional Commits, with a scope where one fits (`fix(plugin): …`).

## Documentation

- Pebble SDK: https://developer.repebble.com/llms.txt indexes every page. Add `.md` to a page URL to get Markdown.
- Plugins: https://developer.repebble.com/guides/plugins/preview.md. Local pins: https://developer.repebble.com/guides/pebble-timeline/timeline-local-pins.md.
- For plugin engine behaviour the docs don't cover, read the Pebble app source: github.com/coredevices/mobileapp, `libpebble3/src/{commonMain,androidMain}/kotlin/io/rebble/libpebblecommon/{js,plugin}/`.
