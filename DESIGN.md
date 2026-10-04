---
name: Centralign Worker
description: Compact task controls with inspectable execution evidence.
colors:
  navy-900: "#152b40"
  ink: "#1d3143"
  muted: "#586c7e"
  line: "#d6e0e8"
  line-strong: "#bdcbd6"
  canvas: "#edf3f7"
  surface: "#ffffff"
  surface-cool: "#f5f8fa"
  blue-dark: "#194e73"
  blue-hover: "#113d5b"
  secondary-ink: "#31495e"
  nav-text: "#ced9e2"
  approval-bg: "#fff6d8"
  approval-ink: "#4e431f"
  approval-action: "#5f4d16"
  green-pale: "#e5f3eb"
  verified-ink: "#236346"
  red: "#9e3636"
  red-pale: "#fbefed"
typography:
  body: {fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', fontSize: "14px", lineHeight: 1.45}
  headline: {fontSize: "19px", fontWeight: 650, letterSpacing: "-.025em"}
  title: {fontSize: "16px", fontWeight: 650, letterSpacing: "-.018em"}
  field: {fontSize: "13px", lineHeight: 1.45}
  label: {fontSize: "12px", fontWeight: 650}
rounded:
  tag: "3px"
  control: "4px"
  panel: "5px"
  dialog: "6px"
  badge: "20px"
spacing:
  compact: "8px"
  control: "12px"
  stack: "14px"
  panel: "16px"
  inset: "18px"
  main: "28px"
components:
  button-primary: {backgroundColor: "{colors.blue-dark}", textColor: "{colors.surface}", typography: "{typography.label}", rounded: "{rounded.control}", padding: "0 12px"}
  button-primary-hover: {backgroundColor: "{colors.blue-hover}"}
  button-secondary: {backgroundColor: "{colors.surface}", textColor: "{colors.secondary-ink}", typography: "{typography.label}", rounded: "{rounded.control}", padding: "0 12px"}
  button-approve: {backgroundColor: "{colors.approval-action}", textColor: "{colors.surface}", typography: "{typography.label}", rounded: "{rounded.control}", padding: "0 12px"}
  task-input: {backgroundColor: "{colors.surface}", textColor: "{colors.ink}", typography: "{typography.field}", rounded: "{rounded.control}", padding: "9px 10px"}
  workspace-navigation: {backgroundColor: "{colors.navy-900}", textColor: "{colors.nav-text}", rounded: "{rounded.control}"}
  status-completed: {backgroundColor: "{colors.green-pale}", textColor: "{colors.verified-ink}", rounded: "{rounded.badge}", padding: "2px 8px"}
  approval-panel: {backgroundColor: "{colors.approval-bg}", textColor: "{colors.approval-ink}", rounded: "{rounded.panel}", padding: "14px 17px"}
  verification-strip: {backgroundColor: "{colors.surface}", textColor: "{colors.ink}", rounded: "{rounded.panel}", padding: "14px 16px 13px"}
---

# Design System: Centralign Worker

## Overview

**Creative North Star: "The inspection record"**

Centralign uses a compact work interface to make actions, proposed writes and checked results inspectable. Pale blue-white fields separate evidence from the navy navigation. Yellow draws attention to approval; green identifies a verified result. Normal browser controls keep tasks familiar.

The system comes from `public/dashboard.css`, `public/index.html`, `public/company.css` and `public/company.html`. `PRODUCT.md` supplies the evidence and synthetic-data constraints; `.impeccable/surfaces/public-index-html.md` records the approved direction. This is code-led documentation, not a comp-fidelity claim or a browser-QA verdict.

**Key Characteristics:**
- Compact panels with readable evidence and explicit state labels.
- Native controls, keyboard focus and recoverable errors.
- Synthetic records clearly distinguished from real execution evidence.

## Colors

### Primary
Navy anchors navigation. Deep blue identifies the main task action and its darker hover state. The company stylesheet names the same action color `--blue`; the dashboard names it `--blue-dark`.

### Secondary
Pale yellow contains proposed writes, with dark brown copy and an approval action. Green tint and verified ink identify checked outcomes. Pale red and red identify failures and destructive actions.

### Neutral
The canvas is a pale blue-white field; panels are white and diagnostic fields use the cool surface. Ink carries content, muted text carries supporting context, and two border strengths separate panels from controls.

**The state color rule.** Yellow means a human checkpoint, green means a checked result, and red means a failed or cancelled state. Pair color with explicit text.

## Typography

Use the system sans-serif stack in the frontmatter. No display font or promotional type scale is needed. Workspace headlines are smaller than typical marketing headings; panel headings and field labels establish the working hierarchy.

- Body uses the shared reading size and line height. Task text fields use the field role.
- Panel titles use the title role; narrower layouts may reduce heading sizes without hiding content.
- Use tabular numerals for timestamps, invoice amounts and source facts. Diagnostic details use the existing system monospace stack.
- Source messages may occupy up to 75ch; approval descriptions use up to 72ch. Wrap long identifiers and preserve meaningful line breaks.

**The readable evidence rule.** Event messages and inspection details must be at least 12px; keep metadata readable at normal zoom. Do not standardize the smaller pre-review event styles as design tokens.

## Layout

The dashboard has a navy rail, a task composer and adjacent activity/browser panels. An inline approval panel remains in the task flow. The verification strip connects source evidence, the human checkpoint and the checked result. Company views reuse the shell colors with tab navigation, record lists and native forms.

- Preserve the existing compact spacing vocabulary; use the live stylesheets for context-specific dimensions.
- On narrow screens, move navigation above the workspace and wrap destinations so all three remain visible. Do not depend on an undisclosed horizontal scroll to reveal a destination.
- Stack activity, browser observation, approval actions and verification steps as space decreases. Keep native selects and form controls within the viewport.
- Scroll long activity records inside their panel. Keep full event text and diagnostic details accessible.
- Contain screenshot previews without distorting them, and provide an explicit link to the full-size capture. A reduced preview is not sufficient inspection evidence.
- Company accounting columns collapse before the phone layout; wide invoice tables scroll within their container. Breakpoint metadata is in the sidecar.

## Elevation & Depth

Borders and pale fills provide most separation. Working panels share a small two-part shadow; confirmation dialogs use the stronger dialog shadow and a dark backdrop. Exact shadow values live in `.impeccable/design.json` and the source CSS. Do not add floating decorative cards or hover lifts.

## Shapes

Tags have the smallest corners, controls have restrained rounded corners, and panels are slightly rounder. Dialogs use the next step; status badges alone use a pill. Use thin solid borders and native checkbox, select, details and dialog affordances.

## Components

- Buttons use compact, text-led native controls. Deep blue starts or continues a task; white secondary controls stop, reject or refresh. Quiet actions stay subordinate. Brown confirms approval and red marks destructive reset. Preserve disabled states and visible focus.
- Task fields have explicit labels, white backgrounds and stronger borders. Keep the textarea resizable and preserve native validation. Company record inputs use their existing denser sizing.
- Navigation has a clear current state, distinct hover and high-contrast keyboard focus. Keep destination names visible at mobile widths; the desktop rail dimensions do not prescribe mobile sizing.
- Status badges state the status in text. Their tint reinforces the label rather than replacing it.
- Approval panels show the proposed change and inspectable details beside explicit reject/approve controls. Stack actions when necessary; never collapse the payload into a color-only cue.
- Activity records separate event type, timestamp, message and expandable details. Darken supporting metadata when needed for legibility instead of treating low contrast as hierarchy.
- Verification preserves separate observed, approved and verified states. Mark success only after checking the saved effect; expose evidence links and a full-size screenshot inspection path.
- Controls use the existing short color transitions. Honor reduced motion; no animation is needed to understand status. Sidecar examples illustrate appearance, not completed runs.

## Do's and Don'ts

### Do:
- Do keep all navigation destinations visible on narrow screens.
- Do make event text, metadata, approval details and full-size captures readable and inspectable.
- Do label synthetic business data and distinguish observations from verified results.
- Do preserve native semantics, visible keyboard focus and explicit state text.

### Don't:
- Don't add marketing heroes, decorative metrics, ornamental imagery or new fonts.
- Don't mark a result verified because the model says it is complete.
- Don't hide evidence behind clipped text, low contrast or a scaled screenshot alone.
- Don't treat this code-led reference as proof of visual fidelity or completed capture QA.
