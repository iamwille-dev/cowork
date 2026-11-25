---
name: Cowork
description: A shared workspace for teams and their AI coworker.
colors:
  primary: "#252522"
  primary-hover: "#403f39"
  canvas: "#f3f2ee"
  surface: "#fff"
  sidebar: "#eeede8"
  frame: "#e6e4dd"
  muted: "#62615b"
  line: "#e4e2db"
  line-strong: "#cecac0"
  soft: "#ebe9e3"
  information: "#28577a"
  information-tint: "#e6eff5"
  warning: "#925014"
  warning-tint: "#fff0db"
  success: "#14634d"
  success-tint: "#e2f5ed"
  dark-canvas: "#1b1c1a"
  dark-surface: "#242522"
  dark-sidebar: "#20211e"
  dark-frame: "#121310"
  dark-ink: "#f3f1eb"
  dark-primary: "#eae7de"
  dark-line: "#393a34"
  dark-muted: "#c0beb4"
  dark-information: "#a9d3f4"
  dark-information-tint: "#263b49"
  dark-warning: "#ffc18b"
  dark-warning-tint: "#452d22"
  dark-success: "#91e0bf"
  dark-success-tint: "#173831"
typography:
  display:
    fontFamily: '"Instrument Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: "clamp(2.65rem, 5.5vw, 5rem)"
    fontWeight: 550
    lineHeight: 1
    letterSpacing: "-0.04em"
  headline:
    fontFamily: '"Instrument Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: "2.125rem"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "-0.03em"
  title:
    fontSize: "1.125rem"
    fontWeight: 650
    letterSpacing: "-0.03em"
  body:
    fontFamily: '"Instrument Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: "15px"
    lineHeight: 1.5
  label:
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.3333
rounded:
  field: "8px"
  panel: "12px"
  frame: "20px"
  capsule: "999px"
spacing:
  compact: "8px"
  row: "12px"
  inset: "16px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.capsule}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-quiet:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.capsule}"
    padding: "8px 14px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.field}"
    padding: "8px 12px"
  nav-current:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.capsule}"
    height: "38px"
  chip-review:
    backgroundColor: "{colors.success-tint}"
    textColor: "{colors.success}"
    typography: "{typography.label}"
    rounded: "{rounded.capsule}"
    padding: "2px 8px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
---

# Design System: Cowork

## Overview

**Creative North Star: "The Shared Workbench"**

Cowork uses a warm gray frame, white ruled panels, and compact controls to make daily agent work easy to scan. Muted context sits beside the titles, actions, and status labels people use to decide what needs attention.

Public pages use the same materials and outline icons as the workspace. The landing example shows a conversation, its artifacts, and a reminder together. The workspace uses these patterns for live conversations, task reviews, reminders, and settings.

**Key Characteristics**

- Warm gray frame and softly ruled surfaces.
- Charcoal capsules for primary actions and the selected destination.
- Instrument Sans throughout, with semantic blue, amber, and green accents.

## Colors

### Primary

- **Charcoal** fills primary controls and the selected navigation capsule in light mode. The workspace uses pale stone for these fills in dark mode.

### Secondary

- **Muted blue** marks links, informational badges, and selected FAQ questions. Place it over the matching pale blue tint where the component uses a fill.

### Tertiary

- **Amber** marks items needing attention. **Green** marks review readiness and successful outcomes. Both colors pair with their tinted backgrounds and visible labels.

### Neutral

- **Warm gray** establishes the canvas, frame, and sidebar. **White** lifts content panels from that canvas. Use muted gray for secondary text and warm gray rules between content rows. In dark appearance, retain the relationship between the near-black frame, gray canvas, and lighter panel.

### Named Rules

**The Status Color Rule.** Use semantic color on labels and relevant nonzero totals. Preserve the written state in badges so its meaning is legible without color.

## Typography

Instrument Sans handles display and body copy, with system sans-serif fallbacks. Headings use tighter tracking, and operational labels keep the body face at smaller sizes.

- **Display** uses the fluid hero scale and a medium weight (550). Narrow public layouts use a separate fluid range.
- **Headline** names the workspace view in medium-weight type (500). On compact screens it reduces to 1.8rem.
- **Title** identifies panels and sections. Row titles and metadata use smaller sizes within the same family.
- **Body** uses a comfortable default line height (1.5). Workspace controls use 14px text.
- **Label** is the compact status size. Metrics set their figures in tabular numerals.

## Layout

The desktop workspace starts at 1024px with a persistent, 200px sidebar and 20px outer margins. Content uses a fluid inset (16–36px) and main views are capped at 1280px. Below 1024px the sidebar becomes a drawer. The conversation inbox gains a supporting column at 1150px, and metric groups move from two to four columns at 640px.

Public pages share a centered width capped at 1160px. The landing preview and workflow stack at 740px, and the preview sidebar drops out at 580px. FAQ answers occupy a neighboring panel at 801px and above and expand inline at smaller widths.

## Elevation & Depth

**The Border First Rule.** Use tonal separation and fine borders for panels and nested sections. The workspace panel shadow is shallow. The public example uses a warmer stage around its nested frame.

## Shapes

Capsules distinguish workspace action buttons, active navigation, search, and status labels. Fields have softly rounded corners (8px), standard panels use a slightly broader radius (12px), and the desktop workspace and public preview stage use a broad radius (20px).

## Components

### Buttons

Workspace buttons have a minimum height of 38px with a single-line label. The primary variant uses the filled action color and its hover shade. Quiet actions use a panel-colored fill and a fine rule, with a soft neutral hover fill. Public calls to action use a 42px minimum height. Keyboard focus uses a blue outline with a 3px offset on standard controls.

### Status chips

Use a compact capsule with a small leading dot, text, and a semantic tint. Navigation invitation counts keep their label and omit the dot.

### Panels and rows

Use the raised surface on a warm canvas. A single rule divides rows in inbox, task, and review lists. Keep the row title visually stronger than metadata and use the label to communicate state.

### Fields

Use surface-colored inputs with a stronger rule and neutral placeholder text. Search uses a capsule with a leading outline icon. Keep an accessible label on search and icon controls.

### Navigation

Pair outline icons with text labels. Inactive destinations use muted text and a soft hover fill. The current destination uses the filled action capsule. Use the drawer at narrower workspace widths.

### Workspace metrics

Place a short label above the value with a hairline under each metric. Nonzero counts take the blue, amber, or green tone assigned to their meaning.

## Do's and Don'ts

### Do

- **Do** keep status labels visible alongside semantic color.
- **Do** divide related rows with a shared rule inside a single panel.
- **Do** preserve labels and keyboard focus when navigation moves to a drawer.

### Don't

- **Don't** use informational blue as the default fill for a primary workspace action.
- **Don't** assign alert color to a zero count in a workspace metric.
