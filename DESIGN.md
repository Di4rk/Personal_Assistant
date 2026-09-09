# Design System — Project Diark

<!-- impeccable:design-schema 1 -->

## Design Intent & Persona

Diark is a Personal OS for competitive programmers and CS engineers.

- Philosophy: minimalist, high-density, zero-clutter, focus-first.
- Target visual: a high-precision technical telemetry dashboard—not generic SaaS.
- Avoid purple/blue gradients, excessive rounding, and nested card treatments.

## Color Palette & Surface Hierarchy

Dark mode only. The neutral Zinc/Slate palette establishes controlled contrast. JSX must consume semantic Tailwind tokens or design tokens; it must not contain hardcoded color values.

| Token | Tailwind class | Value | Use |
| --- | --- | --- | --- |
| Surface base | `bg-zinc-950` | `#09090b` | Main application canvas |
| Surface card | `bg-zinc-900/70` | `#18181b` | Statistic widgets and data tables |
| Surface hover | `bg-zinc-800/60` | `#27272a` | Hovered table rows and list items |
| Border subtle | `border-zinc-800/80` | `#27272a` | Card, header, and cell dividers |
| Border active | `border-zinc-700` | `#3f3f46` | Focused or active input borders |

### Semantic Accents

| Meaning | Token | Value |
| --- | --- | --- |
| XP / level progress | `emerald-400` | `#34d399` |
| Accepted verdict | `emerald-500` | `#10b981` |
| Wrong answer / rejection | `rose-500` | `#f43f5e` |
| Time or memory limit | `amber-400` | `#fbbf24` |
| Primary text | `text-zinc-100` | `#f4f4f5` |
| Secondary text | `text-zinc-400` | `#a1a1aa` |
| Code and metadata | `text-zinc-500` | `#71717a` |

## Typography & Spatial Layout

- UI and headings: `Inter`, `Geist Sans`, or a system UI font stack.
- Numeric data, code, XP, and verdicts: `JetBrains Mono`, `Fira Code`, or `ui-monospace`.
- Use a 4px spatial scale. Margins, padding, and gaps must be divisible by four. Use `gap-1` for 4px micro-gaps; `p-3` / `p-4` for card padding; `space-y-4` / `gap-6` for sections.
- Exceptions: `gap-1.5` (6px) is allowed only for compact badge/icon alignment.
- Cards may use at most `rounded-lg`; controls and badges at most `rounded-md`; heatmap cells use `rounded-sm`.
- Never use `rounded-full` for cards or large containers.

## Interaction

- Motion is crisp and precise: `transition-all duration-150 ease-out`.
- Do not use spring or bouncing animation.
- Focus indication uses the active border token and must remain visible against `zinc-950`.

## Hard Constraints

1. **Zero card-in-card.** Do not place bordered, surfaced child cards inside a parent card. Divide related regions using whitespace and `border-t border-zinc-800`.
2. **No pure black.** Retain `zinc-950` as the deepest canvas surface for optical depth on IPS and OLED displays.
3. **Scannability first.** Key values—daily XP, accepted count, and streak—use `text-2xl font-bold font-mono`. Descriptive labels use `text-xs text-zinc-400 uppercase tracking-wider` above or below the value.
4. **Semantic color only.** Accent colors encode meaning; emerald tracks progress/success, rose denotes rejection, and amber denotes limits/warnings.
5. **High density without clutter.** Prefer meaningful alignment, concise labels, whitespace, and restrained dividers over ornamental surfaces.
