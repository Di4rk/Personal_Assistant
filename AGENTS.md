# DIARK CORE — CODEX AGENT RULES

## 1. System Constraints
- Target Framework: Tauri v2 + Rust (Tokio) + SQLite (WAL mode) + React 18 (TypeScript + Tailwind CSS).
- Memory Budget: Desktop idle footprint < 100MB RAM. Zero memory leak, minimal CPU cycles.

## 2. Rust Code Standards
- Zero `unwrap()` or `expect()` in production code. Use `Result<T, AppError>` and propagate with `?`.
- Database access must use Connection Pooling / `Arc<Mutex<Connection>>` to avoid database locks.
- Concurrency: Background tasks must run inside `tokio::spawn` and communicate via Tauri Events (`app.emit`), avoiding blocking IPC calls.

## 3. Frontend Standards (React / Tailwind)
- Strict TypeScript: No `any` types. Props and state must be explicitly typed.
- Styling: Dark mode first (slate/zinc palette). Zero inline CSS, zero magic numbers (strictly follow 4px scale).
- Anti-patterns to reject: Generic SaaS purple/blue gradients, nested cards, bouncing animations.
- Component architecture: Clean separation between presentation components and hooks.

## 4. Execution Policy
- Only edit specified files. Never remove existing working logic unless instructed.
- Always provide full, compilable code replacements without placeholder comments (`// TODO`).


# AGENT DIRECTIVES: SUPERPOWERS & KARPATHY DISCIPLINES

## 1. Karpathy Simplicity Principles
- Think first, code minimal: Always explain the mental model in 2 sentences before touching code.
- No Over-Engineering: Zero premature abstractions, zero unneeded wrapper layers.
- Locality of Behavior: Keep related logic close; prefer readable flat execution over deeply nested indirection.

## 2. Superpowers Engineering Workflow
- TDD Enforcement: For any backend logic (e.g., First AC, XP, SQLite FTS5 triggers), define the failing test case before implementing the solution.
- Systematic Debugging: Never guess a fix. Trace the root cause, verify with compiler/logs, apply fix, and verify resolution.
- Verification Before Completion: Do not declare a task complete until cargo check or test suites pass with zero warnings.