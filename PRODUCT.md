# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Primary: one developer using Diark as a personal operating system for competitive programming.
- Secondary readiness: close peers may run separate local profiles in a standalone desktop client; this is not a shared cloud service.

## Product Purpose

Diark autonomously tracks competitive-programming practice, beginning with Codeforces and an ICPC-focused workflow. It turns submissions and reflection into a durable practice loop: capture activity, preserve post-mortem knowledge, and make progress visible through XP, streaks, and analytics.

Success means the user can sustain deliberate ICPC practice, learn from failed and solved problems without an external notes tool, and understand their momentum while offline.

## Positioning

A local-first competitive-programming personal OS that combines automated platform tracking, a native searchable post-mortem knowledge base, and a unified gamification loop. It does not require Obsidian or a cloud service for notes, analytics, or core daily use.

## Operating Context

- Primary platform integration in Phase 1: Codeforces.
- Practice context: ICPC-oriented problem solving and post-submission review.
- Core records include submissions, XP, streaks, activity history, analytics, and post-mortem notes.
- Data remains useful without a network connection; sync workers contact competitive-programming platforms only when needed.

## Capabilities and Constraints

- Local-first desktop client with readiness for multiple local profiles.
- SQLite is the persistent store, using WAL mode and FTS5 for full-text search.
- Analytics and notes must remain fully functional offline.
- Platform synchronization uses ephemeral network workers.
- Idle memory target on Windows: under 100 MB.
- Codeforces is the confirmed Phase 1 integration; additional platform scope is undecided.

## Brand Commitments

- Product name: Diark.
- Built-in internationalization: English is the default language; users can switch dynamically to Vietnamese in the interface.
- Binding UI direction: dark, minimalist, high-density dashboard.
- UI implementation uses a tokenized design system with no magic numbers, following Impeccable rules.

## Evidence on Hand

- Existing implementation: `diark-core`, a Tauri + React + TypeScript desktop project.
- Current UI already presents Codeforces submissions, XP, level progression, activity heatmap, and local SQLite-backed data.
- No external proof assets, testimonials, customer claims, or benchmarks are confirmed. Future surfaces must not fabricate them.

## Product Principles

1. Local ownership first: practice history and knowledge remain available and useful without the network.
2. Reflection compounds: every important submission can become searchable learning material.
3. Motivation must be legible: XP, streaks, and analytics clarify progress without obscuring the practice itself.
4. Automation stays lightweight: synchronize when needed, then return to a low-resource local state.
5. Personal depth before broad collaboration: perfect the single-user loop while preserving clean local-profile boundaries.

## Accessibility & Inclusion

- English and Vietnamese language switching is a confirmed inclusion requirement.
- Additional accessibility standards are undecided.
