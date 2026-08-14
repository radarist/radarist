# Color Conventions

This document defines the color conventions used throughout the Radarist Studio UI.
Any new component or modification should follow these conventions.

---

## Semantic Entity Colors (by design -- do NOT change)

These are **intentional** identity colors for each entity type. They appear in entity
icons, badges, graph labels, and type indicators across the application.

| Entity          | Color class        | Hex       |
| --------------- | ------------------ | --------- |
| Company         | `text-blue-500`    | `#3b82f6` |
| Technology      | `text-emerald-500` | `#10b981` |
| Signal          | `text-orange-500`  | `#f97316` |
| Use Case        | `text-yellow-500`  | `#eab308` |
| Prototype       | `text-green-500`   | `#22c55e` |
| Strategy        | `text-purple-500`  | `#a855f7` |
| Org Unit        | `text-indigo-500`  | `#6366f1` |
| Initiative      | `text-pink-500`    | `#ec4899` |
| Pain Point      | `text-red-500`     | `#ef4444` |
| Document        | `text-slate-500`   | `#64748b` |
| Radar Placement | `text-indigo-500`  | `#6366f1` |

Source: `src/components/visualizations/graph/GraphOverviewPanel.tsx` (`ENTITY_COLORS`)

---

## Status Colors (Approved/Rejected/Pending/Archived)

These colors communicate workflow status and should be consistent everywhere.

| Status    | Badge pattern                                                                    |
| --------- | -------------------------------------------------------------------------------- |
| Detected  | `bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/30`     |
| Validated | `bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30`             |
| Approved  | `bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30` |
| Rejected  | `bg-destructive/10 text-destructive border-destructive/30`                       |
| Imported  | `bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30`     |
| Archived  | `bg-muted text-muted-foreground border-border`                                   |

---

## Score / Confidence Colors

Used for trust scores, confidence indicators, approval rates, and similar numeric ranges.

| Range      | Text color                               | Bar/badge bg     |
| ---------- | ---------------------------------------- | ---------------- |
| High (70+) | `text-emerald-600 dark:text-emerald-400` | `bg-emerald-500` |
| Medium     | `text-yellow-600 dark:text-yellow-400`   | `bg-yellow-500`  |
| Low        | `text-destructive`                       | `bg-destructive` |

---

## Sentiment / Trend Colors

| Sentiment | Color                                    |
| --------- | ---------------------------------------- |
| Positive  | `text-emerald-600 dark:text-emerald-400` |
| Neutral   | `text-muted-foreground`                  |
| Negative  | `text-destructive`                       |
| Rising    | `text-emerald-600 dark:text-emerald-400` |
| Declining | `text-destructive`                       |

---

## UI Chrome Colors (CSS Variables)

Always prefer CSS variable-based classes for general UI elements.

| Need             | Class                   | Avoid             |
| ---------------- | ----------------------- | ----------------- |
| Muted text       | `text-muted-foreground` | `text-gray-*`     |
| Muted background | `bg-muted`              | `bg-gray-100`     |
| Border           | `border-border`         | `border-gray-200` |
| Destructive      | `text-destructive`      | `text-red-600`    |
| Card/page bg     | `bg-background`         | `bg-white`        |
| Primary text     | `text-foreground`       | `text-gray-900`   |

---

## Action Button Colors

| Action  | Pattern                                   |
| ------- | ----------------------------------------- |
| Approve | `bg-emerald-600 hover:bg-emerald-700`     |
| Reject  | `bg-destructive hover:bg-destructive/90`  |
| Delete  | `bg-destructive hover:bg-destructive/90`  |
| Default | Use `<Button variant="default">` (shadcn) |

---

## SWOT Analysis Colors (domain-semantic)

These are deliberate domain colors for SWOT quadrants and should remain as-is.

| Quadrant      | Color                                                    |
| ------------- | -------------------------------------------------------- |
| Strengths     | `text-emerald-600` / `bg-emerald-50 dark:bg-emerald-950` |
| Weaknesses    | `text-red-600` / `bg-red-50 dark:bg-red-950`             |
| Opportunities | `text-blue-600` / `bg-blue-50 dark:bg-blue-950`          |
| Threats       | `text-amber-600` / `bg-amber-50 dark:bg-amber-950`       |

---

## Signal Type / Category Colors (domain-semantic)

These are intentional signal-type differentiators, not status indicators.

| Signal Type | Badge pattern                                              |
| ----------- | ---------------------------------------------------------- |
| Patent      | `bg-blue-500/10 text-blue-600 border-blue-500/30`          |
| Paper       | `bg-purple-500/10 text-purple-600 border-purple-500/30`    |
| News        | `bg-emerald-500/10 text-emerald-600 border-emerald-500/30` |
| Funding     | `bg-yellow-500/10 text-yellow-600 border-yellow-500/30`    |
| GitHub      | `bg-muted text-muted-foreground border-border`             |

---

## Rules

1. **Never use `text-gray-*`, `bg-gray-*`, or `border-gray-*`** -- use the muted/border CSS variables instead.
2. **For error/destructive states**, prefer `text-destructive` / `bg-destructive` over `text-red-600`.
3. **Entity identity colors are sacred** -- do not replace them with CSS variables.
4. **Status badge colors should be consistent** across all views of the same entity status.
5. **All color classes should include dark mode variants** when using Tailwind color-\*-NNN classes.
