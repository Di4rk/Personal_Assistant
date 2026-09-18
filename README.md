# DIARK OS (v1.0.0)

> **Personal Engineering & Academic Operating System**  
> *Local-first desktop environment for Competitive Programming (ICPC), Academic Management (UIT Portal & Moodle), and Socratic Pedagogical AI Coaching.*

[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-v2-blue.svg)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-1.80+-orange.svg)](https://www.rust-lang.org/)
[![React](https://img.shields.io/badge/React-19-cyan.svg)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-38bdf8.svg)](https://tailwindcss.com/)

---

## ⚡ Mental Model & System Architecture

DIARK is designed with a strict **Zero-Cloud, Local-First, Zero-Leak** philosophy:
- **Desktop Memory Budget**: Idle memory footprint < 100MB RAM.
- **Backend Core**: Tauri v2 + Rust (Tokio async runtime) + SQLite (WAL mode, FTS5 full-text indexing, `Arc<Mutex<Connection>>` connection pooling).
- **Frontend Stack**: React 19 + TypeScript + Tailwind CSS v4. Dark mode first (slate/zinc palette), zero magic numbers, high density and zero generic SaaS gradients.
- **Local Loopback Security**: Sync server operates strictly on `127.0.0.1` with token authentication (`X-Diark-Sync-Token`) and sliding-window rate limiting.

```
┌─────────────────────────────────────────────────────────────┐
│                 DIARK OS Desktop UI                         │
│       React 19 + TypeScript + Tailwind CSS (Dark Mode)      │
└──────────────────────────────┬──────────────────────────────┘
                               │ Tauri IPC / Events (Streaming)
┌──────────────────────────────▼──────────────────────────────┐
│                    Tauri v2 Core (Rust)                     │
│  Tokio Async Runtime  •  Loopback Sync Server (127.0.0.1)   │
│  SSE Gemini Streamer  •  Background Watchdogs & Schedulers  │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                 SQLite Local Store (WAL Mode)               │
│  FTS5 Search  •  Wecode & CF Submissions  •  Academic Vault │
└─────────────────────────────────────────────────────────────┘
```

---

## 🌟 Core Modules

### 1. 🏆 Competitive Programming & ICPC Engine
- **Automated Sync Watchdog**: Periodic non-intrusive synchronization with Codeforces API.
- **First-AC & Gamification Engine**: 15 XP awarded on first AC per unique problem, level progression system, and yearly activity heatmaps.
- **Post-Mortem Knowledge Vault**: Native searchable post-mortem editor for logging algorithmic insights, runtime pitfalls, and complexity analysis (powered by SQLite FTS5).

### 2. 🎓 UIT Academic Hub
- **Dual-Tier SSO Harvester**: Zero-friction synchronization of courses, lecture slides, and assignments from UIT Portal & Moodle via local loopback script.
- **Unified Quest Hub**: Centralizes deadlines across Moodle assignments, quizzes, and course projects with automatic status categorization (Gấp / Còn hạn / Đã đóng).
- **Curriculum & Degree Audit**: Real-time progress tracker against UIT graduation curriculum rules (credits by knowledge blocks, compulsory vs. elective requirements).
- **Offline Material Manager**: One-click download and local caching of course slides into your local Vault folder.

### 3. 🎯 Wecode UIT Drilldown
- **Comprehensive Hierarchy**: Structured inspection of assignments, problem sets, and submission logs.
- **Clean Empty States & Status Filters**: Instant filtering by Urgent (⚡ < 3 days), Completed (✅ 100%), and Closed deadlines.
- **Automated XP Sync**: Links Wecode practice with DIARK's core gamification loop.

### 4. 🤖 Gemini AI Copilot (BYOK via Rust SSE Streaming)
- **Bring Your Own Key (BYOK)**: Store your personal Google Gemini API Key locally in SQLite. Zero intermediate proxy servers.
- **Socratic Pedagogical Coach**:
  - *Zero Spoiler Policy*: Never reveals full code solutions or direct answers.
  - *Edge Case Generator*: Generates boundary test cases (e.g., $N=0, 1$, integer overflow, empty array) to guide debugging.
  - *Diagnostic Inquiries*: Asks Socratic questions to prompt student reflection.
- **Smart Moodle Task Extractor**: Parses unstructured lecturer announcements (natural language prose) and extracts deadlines, course codes, and actionable tasks directly into your database.

### 5. 📡 Exam Radar & Daily Briefing
- **Exam Countdown Clock**: High-efficiency countdown timer that dynamically manages CPU utilization and only runs when exams are upcoming.
- **Preparation Checklist**: Persistent per-exam checklists for student IDs, calculators, and revision notes.
- **Native Windows Notifications**: Rate-limited briefing notifications with 30-minute cooldowns to eliminate spam.

---

## 🚀 Getting Started

### Prerequisites
- **Node.js**: >= 20.x
- **pnpm**: >= 9.x (or `npm`)
- **Rust Toolchain**: `stable` (>= 1.80) with `x86_64-pc-windows-msvc`
- **C++ Build Tools**: Visual Studio Build Tools with C++ desktop development workload

### Installation & Development Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Di4rk/Personal_Assistant.git
   cd Personal_Assistant/diark-core
   ```

2. **Install frontend dependencies:**
   ```bash
   pnpm install
   # or
   npm install
   ```

3. **Run in development mode:**
   ```bash
   npm run tauri dev
   ```

4. **Compile production build (NSIS Installer):**
   ```bash
   npm run tauri build
   ```
   The generated standalone installer will be located at:
   `diark-core/src-tauri/target/release/bundle/nsis/`

---

## 🔒 Security & Privacy Commitments

- **100% Offline-First**: All academic metrics, submissions, notes, and profile data are stored in a local SQLite file (`diark.sqlite3`).
- **No Third-Party Telemetry**: Zero analytics trackers, zero external pingbacks.
- **Isolated Browser Sync**: The local sync server binds exclusively to `127.0.0.1` and requires a pre-shared cryptographic token (`X-Diark-Sync-Token`).
- **Sanitized Git History**: SQLite databases, WAL files, and environment files (`.env*`) are strictly ignored.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE) - see the [LICENSE](LICENSE) file for details.
