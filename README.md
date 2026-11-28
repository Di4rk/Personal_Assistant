# Diark (v1.2.1)

Local-first desktop workspace for UIT students built with Tauri v2, Rust, SQLite, and React 19.

[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-v2-blue.svg)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-1.80+-orange.svg)](https://www.rust-lang.org/)
[![React](https://img.shields.io/badge/React-19-cyan.svg)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-38bdf8.svg)](https://tailwindcss.com/)

## Architecture

Everything stays on your machine in a local SQLite database (`diark.sqlite3`, WAL mode with FTS5 full-text search). External requests only go to the services you sign into or configure (UIT Portal, UIT Moodle, Wecode, Codeforces, Google Calendar, and Google Gemini when you supply an API key).

```text
React 19 + TypeScript + Tailwind CSS v4 (UI)
   │  Tauri IPC + Events
   ▼
Tauri v2 / Rust (Tokio runtime)
   ├── Loopback HTTP sync server (127.0.0.1:3030, token-protected)
   ├── Background schedulers, file watcher, SSE stream client
   └── SQLite WAL pool + FTS5 index
```

## Features

### Academic Hub (UIT Portal & Moodle)
- Pulls transcript grades, DRL, profile info, timetable slots, registered classes, tuition records, certificates, and course syllabi directly through an authenticated in-app Portal session.
- Tracks degree progress against UIT curriculum blocks (compulsory vs. elective credits and non-credit prerequisites like GDQP, GDTC, and English).
- Includes a bidirectional GPA Target Simulator (`QT / TH / GK / CK` weights parsed from UIT syllabus PDFs or edited manually) plus dynamic graduation timeline presets from year 1 through year 7.
- Imports centralized exam schedules from P.ĐT Excel announcements (`.xlsx` / `.xls`), filtering by your enrolled classes and merging split exam rooms.
- Aggregates Moodle assignments and course materials with one-click offline download to your local Vault directory.

### Competitive Programming (Codeforces & Wecode)
- Periodic sync against Codeforces submissions and Wecode assignment hierarchies.
- Tracks first-AC XP, levels, and a yearly submission heatmap.
- Local post-mortem editor indexed with SQLite FTS5 for notes and edge-case breakdowns.

### Study Notes & Vault
- Single-pane rich Markdown editor (TipTap v2 + KaTeX) stored as plain `.md` files on disk, with `/` block commands, `@` and `[[` wikilink autocomplete, right-click context menu, drag-and-drop/paste local images (`_assets/`), and a toggleable raw `.md` source view.
- Built-in UIT study and academic report templates, customizable note keyboard shortcuts in Settings, and a one-click batch LaTeX normalizer for `\(...\)` and `\[...\]` formulas.
- Collapsible folder explorer tree with a recent-notes toggle, direct note navigation from `Ctrl+K`, a bottom backlinks bar, and FTS5 full-text search.
- Interactive force-directed Graph View overlay with Hub sizing, `#tag` and folder clustering, search and orphan filters, and live physics force controls.
- Ignores `.git`, `.obsidian`, `node_modules`, `.venv`, `site-packages`, and build artifacts during scanning and file watching.

### Gemini Copilot (BYOK) & Auto-Updater
- Uses your own Google Gemini API key stored locally in SQLite for inline note autocomplete (`Tab` to accept, `Alt+\` to trigger), Moodle announcement deadline extraction, and Socratic debugging questions.
- Checks GitHub Releases via `@tauri-apps/plugin-updater` with Minisign signature verification.

## Getting Started

### Prerequisites
- Node.js >= 20.x (`npm` or `pnpm`)
- Rust toolchain `stable` (>= 1.80) targeting `x86_64-pc-windows-msvc`
- Visual Studio Build Tools with the C++ desktop development workload (on Windows)

### Setup

1. Clone the repository and enter `diark-core`:
   ```bash
   git clone https://github.com/Di4rk/Personal_Assistant.git
   cd Personal_Assistant/diark-core
   ```

2. Install frontend dependencies:
   ```bash
   npm install
   ```

3. Start the desktop app in development mode:
   ```bash
   npm run tauri dev
   ```

4. Build the Windows NSIS installer:
   ```bash
   npm run tauri build
   ```
   The installer output is written to `diark-core/src-tauri/target/release/bundle/nsis/`.

## Privacy & Local Security

- All grades, notes, credentials, and submissions stay inside local SQLite storage and your chosen Vault folder.
- There is no analytics tracking or external telemetry.
- The local browser sync listener binds only to `127.0.0.1` and validates `X-Diark-Sync-Token` on every request.
- SSO and API secrets are encrypted before hitting disk, and database/environment files are excluded via `.gitignore`.

## License

Licensed under the [MIT License](LICENSE).
