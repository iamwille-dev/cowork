---
name: Cowork
description: A shared workspace for teams and their AI coworker.
colors:
  primary: "#1458db"
  ink: "#141923"
  muted: "#566174"
  canvas: "#f6f7f9"
  surface: "#ffffff"
  sidebar: "#eff1f5"
  line: "#e0e5ed"
  tint: "#e8efff"
  dark-canvas: "#11151d"
  dark-surface: "#191e28"
  dark-primary: "#8ab3ff"
typography:
  display:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: "clamp(3.1rem, 6.5vw, 6rem)"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.04em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: "16px"
    lineHeight: 1.55
rounded:
  control: "8px"
  panel: "12px"
  capsule: "999px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    height: "40px"
---

## Overview

The homepage introduces Cowork through an example thread and the artifacts it produces. The workspace carries the same outline icons and blue accent into a quieter canvas for daily work.

## Colors

Use blue for primary actions, selection, and links. Use the light or dark workspace palette according to the chosen appearance. The public homepage uses a light canvas with a navy stage around the example.

## Typography

Use the platform sans-serif stack. Give pages a prominent title and keep action labels concise. Reserve the largest type for the homepage and account access.

## Layout

Keep wide workspaces within a readable measure. On smaller screens, move workspace navigation into a drawer and stack controls where space is tight.

## Elevation & Depth

Use fine separators for operational surfaces. The homepage preview uses a deeper shadow to separate it from its display stage.

## Components

Primary actions use solid blue. Quiet actions use neutral borders. The inbox uses divided rows, visible statuses, and spacing to distinguish each conversation.
