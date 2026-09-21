# Release Audit Report - DIARK Core

**Date:** September 22, 2026  
**Auditor:** QA Engineer & Release Auditor  
**Scope:** Repository configuration, dependencies, Tauri v2 build scripts, frontend (React/TypeScript), backend (Rust/Tauri/SQLite/FastEmbed).

---

## Executive Summary

A comprehensive release audit and dry-run build check (`pnpm build` and `cargo build`) were performed on the repository. While both frontend and backend successfully compile individually in development environments, several **Blockers** and **Warnings** exist in build configuration, package management, and asset bundling that prevent stable production releases and automated Tauri packaging (`tauri build`).

---

## Findings & Categorization

### 1. Blocker: Inconsistent Package Manager Commands in Tauri Config
- **Component:** `diark-core/src-tauri/tauri.conf.json`
- **Severity:** **Blocker**
- **Description:** 
  The Tauri configuration specifies `npm run dev` and `npm run build` for `beforeDevCommand` and `beforeBuildCommand`. However, the project exclusively uses `pnpm` (evidenced by `pnpm-lock.yaml` and workspace setup). Running `tauri build` out-of-the-box invokes `npm`, which fails due to the missing `package-lock.json` and incorrect package manager context.
- **Proposed Fix:**
  Update `src-tauri/tauri.conf.json` to use `pnpm`:
  ```json
  "build": {
    "beforeDevCommand": "pnpm run dev",
    "beforeBuildCommand": "pnpm run build",
    ...
  }
  ```

---

### 2. Warning: pnpm Build Script Execution Interruption (`ERR_PNPM_IGNORED_BUILDS`)
- **Component:** `diark-core/package.json` / pnpm
- **Severity:** **Warning**
- **Description:**
  When installing dependencies with strict supply-chain policies (`pnpm install --ignore-workspace`), pnpm ignores build scripts for packages like `esbuild`. In automated CI/CD environments, this can lead to missing binary execution permissions or post-install build steps.
- **Proposed Fix:**
  Add `pnpm.onlyBuiltDependencies` in `package.json` or run `pnpm approve-builds` during CI setup.

---

### 3. Warning: Vite Dynamic vs. Static Import Conflict
- **Component:** `diark-core/src/lib/tauri-client.ts` & consumers
- **Severity:** **Warning**
- **Description:**
  Vite reports a bundling warning: `src/lib/tauri-client.ts` is dynamically imported in `syncOrchestratorStore.ts` but statically imported across multiple components and pages (`App.tsx`, `SettingsModal.tsx`, dashboards, etc.). This prevents Vite from code-splitting `tauri-client.ts` into a separate dynamic chunk.
- **Proposed Fix:**
  Standardize import methods for `tauri-client.ts` across the codebase (either uniformly static or uniformly dynamic).

---

### 4. Warning: Rust Dependency & Target Profile Optimization
- **Component:** `diark-core/src-tauri/Cargo.toml`
- **Severity:** **Warning** (Informational)
- **Description:**
  The `[profile.release]` section is well-configured (`opt-level = "s"`, `lto = true`, `strip = true`), but heavy dependencies like `ort` (ONNX Runtime) and `fastembed` require native C++ / ONNX shared libraries during linking. Ensure CI runners have required build toolchains (MSVC Build Tools on Windows, GCC/Clang on Linux/macOS) pre-installed.
- **Proposed Fix:**
  Document prerequisite build tools and verify CI runner image toolchains for Tauri v2 and ONNX runtime bindings.

---

## Conclusion

With the Tauri config script updated from `npm` to `pnpm` and build toolchains verified, the project is fully ready for stable production release builds.
