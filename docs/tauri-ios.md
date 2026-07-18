# Running Mothtrap as a native iOS app (Tauri)

Status: **proof-of-concept** on the `feat/tauri-ios` branch. Mothtrap builds and
runs in the **iOS Simulator** as a native [Tauri](https://tauri.app) v2 app — the
Rust shell wraps the existing Svelte frontend in a WKWebView. The full app
renders (conversation graph, topic pills, IndexedDB archive, dev hot-reload).

This is a wrapper, not a rewrite: `src-tauri/` is the native shell; the web app
under `src/` is unchanged and still deploys to mothtrap.blue / GitHub Pages as
before.

---

## ⚠️ The one big gotcha: use **stable** Xcode, not a beta

On a **macOS/Xcode beta** (e.g. macOS 27 / Xcode 27 beta), the Rust build fails
inside `swift-rs` while compiling Tauri's Swift helper:

```
CIContext.h: fatal error: 'OpenGLES/EAGL.h' file not found
→ Failed to compile swift package Tauri
```

The beta macOS SDK gets fed an iOS target triple and tries to `#include`
`OpenGLES` (which doesn't exist on macOS). **The exact same source compiles
cleanly under stable Xcode 26.6.** So: build on a released Xcode, and install a
simulator runtime that matches it (a stable Xcode can't run the beta's iOS
runtime).

Verified-good combo: **Xcode 26.6 + iOS 26.5 simulator runtime.**

---

## One-time setup

```bash
# 1. Rust iOS targets (rustup-managed toolchain required — not brew rust)
rustup target add aarch64-apple-ios aarch64-apple-ios-sim

# 2. CocoaPods (Tauri iOS uses it)
brew install cocoapods

# 3. Point the toolchain at STABLE Xcode (see gotcha above)
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch

# 4. A simulator runtime matching that Xcode (only needed if none installed)
xcodebuild -downloadPlatform iOS   # ~8.5 GB

# 5. JS deps (pulls @tauri-apps/cli)
npm install

# 6. Generate the native iOS project (src-tauri/gen/apple).
#    Committed on this branch, so only needed after a clean checkout or to regen.
export PATH="/opt/homebrew/bin:$PATH"   # so xcodebuild finds `pod`
npx tauri ios init
```

Config that matters (already set in `src-tauri/tauri.conf.json`):

- `identifier`: `blue.mothtrap`
- `bundle.iOS.minimumSystemVersion`: `15.0` — Xcode 27 rejects the Tauri default
  of 14.0 (supported range is 15.0+). Kept in sync in `gen/apple/project.yml`
  and the generated `project.pbxproj`.

`package.json` also carries a `"tauri": "tauri"` script — the Xcode "Build Rust
Code" phase shells out to `npm run -- tauri ios xcode-script …`, which needs it.

---

## Build & run in the Simulator (no Apple account needed)

Simulator builds are **unsigned** — no development team, no $99 account. The one
wrinkle: `tauri ios dev` tries to *archive* for a physical device at the end
(which demands signing) and its device auto-detection treats booted simulators
as "connected devices". The reliable recipe is to build via Tauri, then drive the
simulator directly with `simctl`:

```bash
# Create a uniquely-named sim so Tauri can't confuse it with a real/booted device
xcrun simctl create "Mothtrap-iOS26" "iPhone 17 Pro" \
  com.apple.CoreSimulator.SimRuntime.iOS-26-5
UDID=<printed-udid>

export PATH="/opt/homebrew/bin:$PATH"

# Build (this compiles the .app; it will then error on the archive/signing step —
# that's expected and harmless, we only need the built .app)
npx tauri ios dev "Mothtrap-iOS26" --host 127.0.0.1 --no-dev-server-wait \
  --config '{"build":{"devUrl":"http://127.0.0.1:1997/"}}'   # wait for "BUILD SUCCEEDED"

APP=$(find ~/Library/Developer/Xcode/DerivedData/app-*/Build/Products/debug-iphonesimulator \
  -maxdepth 1 -name 'Mothtrap.app' | head -1)

# Run the frontend dev server, then install + launch the built app
npm run dev &                         # vite on 127.0.0.1:1997
xcrun simctl boot "$UDID"; open -a Simulator
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" blue.mothtrap
xcrun simctl io "$UDID" screenshot shot.png   # optional
```

`127.0.0.1` (loopback) is deliberate: in the Simulator it reaches the Mac's dev
server and needs no Local Network permission, unlike a LAN IP.

### Seeing the demo graph (`?demo=1`) in the webview

The web app enters no-login demo mode via `?demo=1`, but Tauri's `--host` rewrite
strips the query and its WKWebView doesn't surface a redirected query to
`location.search`. To force demo mode for a screenshot/eval, temporarily inject
the flag before the app bundle runs — add this dev-only plugin to
`vite.config.ts` and run vite with `MOTHTRAP_FORCE_DEMO=1`:

```ts
const forceDemo = {
  name: 'mothtrap-force-demo',
  transformIndexHtml(html: string) {
    if (!process.env.MOTHTRAP_FORCE_DEMO) return html
    return { html, tags: [{ tag: 'script', injectTo: 'head-prepend' as const,
      children: "if(!location.search.includes('demo'))history.replaceState(null,'','?demo=1')" }] }
  },
}
// plugins: [svelte(), forceDemo]
```

This is a **spike aid only** — it's not committed, because real users log in
rather than use demo mode.

---

## Real device / TestFlight / App Store

This is where you need an **Apple Developer account ($99/yr)** — a physical
device or any distribution requires code signing. Set a team via
`APPLE_DEVELOPMENT_TEAM=<TEAMID>` or `bundle.iOS.developmentTeam` in
`tauri.conf.json`, then `tauri ios dev` (device) / `tauri ios build` work without
the manual `simctl` dance. A free personal team can sideload to your own device
but apps expire after 7 days and there's no TestFlight/push.

---

## What's committed

- `src-tauri/` — the Tauri shell + generated iOS project. `target/` (Rust build,
  ~3 GB) and `gen/apple/Externals` (~350 MB) are gitignored; the tracked part is
  small (config, sources, icons, `.xcodeproj`).
- `vite.config.ts` — honors `TAURI_DEV_HOST` (Tauri sets it to the Mac's LAN IP
  for physical-device runs; unset → `127.0.0.1`, preserving atproto OAuth
  loopback). This is the only change to the web build and is a no-op for normal
  `npm run dev` / deploys.

The app icon is generated from the same moth mark as the PWA
(`npx tauri icon public/icon-512.png`).
