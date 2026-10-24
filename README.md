# Glaido Pro (`v0.4.4`) — Native macOS Edition

100% native macOS reconstruction of **Glaido (`v0.4.4`)** built in Swift (`Cocoa`, `WebKit`, `AVFoundation`, `Speech`, `CoreAudio`, `ApplicationServices`, `SQLite3`) with full offline Pro unlock, zero cloud login requirement, native menu bar integration, global hotkeys, real-time speech-to-text dictation, auto-paste, Command Island CLI agent spawner (`claude` / `codex`), and `stdio` MCP client.

---

## 📦 Downloads (macOS Apple Silicon)

- **[⬇️ Download `Glaido-Pro-macOS-arm64-0.4.4.dmg`](https://github.com/xhacker-hub/glaido-pro/releases/download/v0.4.4/Glaido-Pro-macOS-arm64-0.4.4.dmg)** — macOS Disk Image Installer (drag `Glaido Pro.app` to `/Applications`)
- **[⬇️ Download `Glaido-Pro-macOS-arm64-0.4.4.zip`](https://github.com/xhacker-hub/glaido-pro/releases/download/v0.4.4/Glaido-Pro-macOS-arm64-0.4.4.zip)** — Direct `.app` bundle archive

---

## ✨ Key Native Subsystems (`glaido-reconstructed/macos-src/main.swift`)

1. **Global Hotkey Engine (`CGEventTap` + `NSEvent` Fallback + `--ax-helper` Bridge)**:
   - Supports `push_to_talk`, `persistent` (double-tap toggle), `command`, and `persistent_command` hotkeys including standalone modifiers (`fn` / Globe `63`, `Right Option` `61`, `Right Command` `54`).
   - Stamps synthesized events with `kCGEventSourceUserData = 0x474c4149` (`"GLAI"`) to prevent feedback loops.
2. **Real Audio Capture, RMS Metering & Speech Recognition (`AVAudioEngine` + `SFSpeechRecognizer`)**:
   - Enumerates hardware microphones via `AVCaptureDevice.DiscoverySession` and CoreAudio (`AudioObjectGetPropertyData`).
   - Streams live `amplitude-update` events to the floating pill overlay and records playable `.wav` files into `~/Library/Application Support/Glaido Reconstructed/audio/`.
3. **Multi-Tier Text Placement Pipeline (`TextPlacementEngine`)**:
   - Captures frontmost target application context (`NSWorkspace`, app icon `/app-icons/<bundleId>.png`, and selected text via `AXUIElementCopyAttributeValue`).
   - Applies custom SQLite dictionary replacements, `;trigger` snippets (`{{date}}`, `{{time}}`, `{{clipboard}}`), and per-app formatting rules (`Formal`, `Casual`, `Very Casual`, `lowercase`).
   - Auto-pastes via `CGEvent` (`Cmd+V`) or `--ax-helper` with automatic stale TCC `CDHash` recovery (`resetStaleAccessibilityTccIfNeeded`).
4. **Command Island & CLI Agent Runner (`CliAgentRunner`)**:
   - Spawns local `claude` or `codex` CLI processes with login-shell `PATH` resolution (`$SHELL -ilc`) and streams `command-response-delta`, `command-tool-call`, and `command-response-final` events.
5. **Real `stdio` MCP Client (`McpStdioClient`) & SQLite Persistence (`GlaidoDatabase`)**:
   - Connects to configured MCP servers over JSON-RPC `2.0` (`initialize` → `notifications/initialized` → `tools/list`) and persists sessions, entries, notes, dictionary, snippets, and analytics in `~/Library/Application Support/Glaido Reconstructed/glaido.db`.

---

## 🛠️ Build & Install from Source

```bash
chmod +x ./build.sh
./build.sh
open "/Applications/Glaido Pro.app"
```
