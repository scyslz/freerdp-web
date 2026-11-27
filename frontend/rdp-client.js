/**
 * RDP Web Client - Reusable ES Module
 * Shadow DOM isolated component for browser-based RDP via WebSocket
 * 
 * @example Basic usage
 * import { RDPClient } from './rdp-client.js';
 * 
 * const client = new RDPClient(document.getElementById('container'), {
 *   wsUrl: 'ws://localhost:8765',
 *   showTopBar: true,
 *   showBottomBar: true,
 *   keepConnectionModalOpen: false
 * });
 * 
 * await client.connect({ host: '192.168.1.100', user: 'admin', pass: 'secret' });
 * 
 * @example With theme customization
 * import { RDPClient } from './rdp-client.js';
 * 
 * const client = new RDPClient(container, {
 *   theme: {
 *     preset: 'dark',
 *     colors: {
 *       accent: '#00b4d8',
 *       buttonHover: '#0096c7'
 *     }
 *   }
 * });
 */

import { resolveTheme, themeToCssVars, sanitizeTheme, fontsToCss, themes } from './rdp-themes.js';
import { Magic, matchMagic, parsePointerPosition, parsePointerSystem, parsePointerSet } from './wire-format.js';
import { RDPSecurityPolicy } from './rdp-security.js';
import { WsTransport, RtcMediaTransport, getTransportModeFromQuery, getStunUrlsFromQuery, getTurnFromQuery, expandStunServers, expandIceServers, fetchIceServers } from './rdp-transport.js';

// ============================================================
// BASE URL - Compute the directory containing this script for dynamic resource loading
// ============================================================
const RDP_CLIENT_BASE_URL = new URL('./', import.meta.url).href;

const RDP_REMEMBER_KEY = 'rdp-client:connection';

// ============================================================
// STYLES - Shadow DOM isolated styles (uses CSS custom properties for theming)
// ============================================================
const STYLES = `
:host {
    display: block;
    width: 100%;
    height: 100%;

    /* Typography */
    --rdp-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --rdp-font-size: 14px;
    --rdp-font-size-small: 0.85rem;
    --rdp-font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;

    /* Colors - defaults (overridden by theme) */
    --rdp-bg: #0b0f17;
    --rdp-surface: #131a27;
    --rdp-border: #243147;
    --rdp-text: #e7eefb;
    --rdp-text-muted: #8d9cb5;
    --rdp-accent: #22d3ee;
    --rdp-accent-text: #03212a;
    --rdp-error: #f87171;
    --rdp-success: #10b981;
    --rdp-btn-bg: #1b2434;
    --rdp-btn-hover: #263247;
    --rdp-btn-text: #dbe6f7;
    --rdp-btn-active-bg: #22d3ee;
    --rdp-btn-active-text: #03212a;
    --rdp-input-bg: #0e1520;
    --rdp-input-border: #2a3a53;
    --rdp-input-focus-border: #22d3ee;

    /* Derived surfaces - kept as tokens so every theme gets them for free.
       The light theme overrides these in themeToCssVars(). */
    --rdp-elevated: color-mix(in srgb, var(--rdp-surface) 82%, #ffffff 18%);
    --rdp-sunken: color-mix(in srgb, var(--rdp-bg) 88%, #000000 12%);
    --rdp-hairline: color-mix(in srgb, var(--rdp-border) 70%, transparent);
    --rdp-scrim: color-mix(in srgb, #000000 68%, transparent);
    --rdp-screen-bg: #05070b;
    --rdp-grip: rgba(255, 255, 255, 0.34);

    /* Shape */
    --rdp-border-radius: 7px;
    --rdp-border-radius-lg: 12px;
    --rdp-radius-pill: 999px;

    /* Spacing rhythm (4 / 8) */
    --rdp-space-1: 4px;
    --rdp-space-2: 8px;
    --rdp-space-3: 12px;
    --rdp-space-4: 16px;
    --rdp-space-5: 24px;

    /* Control sizing */
    --rdp-control-height: 34px;
    --rdp-control-height-sm: 28px;
    --rdp-icon-size: 17px;

    /* Elevation */
    --rdp-shadow-1: 0 1px 2px rgba(0, 0, 0, 0.3);
    --rdp-shadow-2: 0 6px 20px rgba(0, 0, 0, 0.4);
    --rdp-shadow-3: 0 24px 64px rgba(0, 0, 0, 0.6);

    /* Motion - shared durations so every transition stays consistent */
    --rdp-duration-fast: 120ms;
    --rdp-duration: 180ms;
    --rdp-ease: cubic-bezier(0.2, 0, 0.2, 1);

    /* Focus ring - a surface-colored gap keeps it visible on any background */
    --rdp-focus-ring: 0 0 0 2px var(--rdp-surface), 0 0 0 4px var(--rdp-accent);

    font-family: var(--rdp-font-family);
    font-size: var(--rdp-font-size);
    color: var(--rdp-text);
}

/* Keyboard focus must always be visible; pointer clicks stay quiet.
   The hidden IME field is excluded because it is never user-facing. */
button:focus-visible,
input:focus-visible,
[tabindex]:focus-visible:not(.rdp-ime) {
    outline: none;
    box-shadow: var(--rdp-focus-ring);
}

/* Respect users who ask the OS to reduce motion. */
@media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
        animation-duration: 0.001ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.001ms !important;
    }
}

* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

.rdp-container {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    background: var(--rdp-bg);
    color: var(--rdp-text);
    overflow: hidden;
    isolation: isolate;
}

/* -------------------------------------------------- Screen (the primary surface)
   The remote desktop fills the entire component. Chrome floats above it and
   auto-hides, so the picture never loses rows to toolbars. */
.rdp-screen-wrapper {
    position: relative;
    flex: 1;
    display: flex;
    justify-content: center;
    align-items: stretch;
    padding: 0;
    min-height: 0;
    /* Scrolling controlled via CSS custom properties - only scroll when needed */
    overflow-x: var(--rdp-overflow-x, hidden);
    overflow-y: var(--rdp-overflow-y, hidden);
}

.rdp-screen {
    position: relative;
    flex: 1;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 0;
    /* Minimum dimensions from options (0 = auto) */
    min-width: var(--rdp-screen-min-width, 0);
    background: var(--rdp-screen-bg, #05070b);
    border: none;
    border-radius: 0;
    overflow: hidden;
}

.rdp-screen canvas {
    display: block;
    /* When min dimensions are set, canvas respects them; otherwise scales to fit */
    min-width: var(--rdp-canvas-min-width, 0);
    min-height: var(--rdp-canvas-min-height, 0);
    max-width: 100%;
    max-height: 100%;
}

/* -------------------------------------------------- Floating HUD
   A compact panel that can dock to any of the four screen edges. It shrinks to
   its content so it covers as little of the remote desktop as possible, and
   folds away completely when idle.

   Docking is driven by data-hud-dock on the container:
     top / bottom    -> horizontal row of tools
     left / right    -> vertical stack of tools
   The same markup serves all four orientations; only layout direction and the
   edge offsets change, so no duplicated templates are needed. */
.rdp-hud {
    position: absolute;
    z-index: 40;
    display: flex;
    background: color-mix(in srgb, var(--rdp-surface) 90%, transparent);
    border: 1px solid var(--rdp-border);
    border-radius: var(--rdp-border-radius-lg);
    box-shadow: var(--rdp-shadow-2);
    backdrop-filter: blur(16px) saturate(1.4);
    -webkit-backdrop-filter: blur(16px) saturate(1.4);
    transition: opacity var(--rdp-duration) var(--rdp-ease),
                transform var(--rdp-duration) var(--rdp-ease),
                visibility var(--rdp-duration) var(--rdp-ease);
}

.rdp-topbar {
    display: flex;
    align-items: center;
    min-height: 0;
}

.rdp-bottombar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--rdp-space-3);
    font-size: var(--rdp-font-size-small);
    color: var(--rdp-text-muted);
}

.rdp-topbar.hidden,
.rdp-bottombar.hidden { display: none; }

/* Nothing to show at all - do not leave an empty floating shell. */
.rdp-hud.hidden,
.rdp-hud-handle.hidden { display: none !important; }

/* -------------------------------------------------- Dock: TOP / BOTTOM (row) */
.rdp-container[data-hud-dock="top"],
.rdp-container[data-hud-dock="bottom"] { --rdp-hud-axis: row; }

.rdp-container[data-hud-dock="top"] .rdp-hud,
.rdp-container[data-hud-dock="bottom"] .rdp-hud {
    left: 50%;
    flex-direction: column;
    width: max-content;
    max-width: calc(100% - (2 * var(--rdp-space-4)));
    transform: translateX(-50%);
}

.rdp-container[data-hud-dock="top"] .rdp-hud { top: var(--rdp-space-3); transform-origin: top center; }
.rdp-container[data-hud-dock="bottom"] .rdp-hud { bottom: var(--rdp-space-3); transform-origin: bottom center; }

.rdp-container[data-hud-dock="top"] .rdp-topbar,
.rdp-container[data-hud-dock="bottom"] .rdp-topbar {
    flex-direction: row;
    gap: var(--rdp-space-3);
    padding: var(--rdp-space-1) var(--rdp-space-1) var(--rdp-space-1) var(--rdp-space-3);
}

.rdp-container[data-hud-dock="top"] .rdp-bottombar,
.rdp-container[data-hud-dock="bottom"] .rdp-bottombar {
    justify-content: space-between;
    gap: var(--rdp-space-4);
    padding: var(--rdp-space-1) var(--rdp-space-3);
    min-height: 26px;
    border-top: 1px solid var(--rdp-hairline);
}

/* Flipped stacking when docked to the bottom, so the divider stays between rows. */
.rdp-container[data-hud-dock="bottom"] .rdp-hud { flex-direction: column-reverse; }
.rdp-container[data-hud-dock="bottom"] .rdp-bottombar { border-top: none; border-bottom: 1px solid var(--rdp-hairline); }

/* -------------------------------------------------- Dock: LEFT / RIGHT
   Tools still stack into a column, but the connection info is laid out
   horizontally underneath them - reading left-to-right is far easier than a
   rotated strip, and it keeps the rail narrow. */
.rdp-container[data-hud-dock="left"] .rdp-hud,
.rdp-container[data-hud-dock="right"] .rdp-hud {
    top: 50%;
    flex-direction: column;
    align-items: stretch;
    width: max-content;
    max-width: calc(100% - (2 * var(--rdp-space-4)));
    transform: translateY(-50%);
}

.rdp-container[data-hud-dock="left"] .rdp-hud { left: var(--rdp-space-3); transform-origin: left center; }
.rdp-container[data-hud-dock="right"] .rdp-hud { right: var(--rdp-space-3); transform-origin: right center; }

.rdp-container[data-hud-dock="left"] .rdp-topbar,
.rdp-container[data-hud-dock="right"] .rdp-topbar {
    flex-direction: column;
    align-items: center;
    gap: var(--rdp-space-1);
    padding: var(--rdp-space-2) var(--rdp-space-1);
}

.rdp-container[data-hud-dock="left"] .rdp-controls,
.rdp-container[data-hud-dock="right"] .rdp-controls {
    flex-direction: column;
    align-items: center;
    margin-left: 0;
    gap: var(--rdp-space-1);
}

/* The info strip stacks on two lines in the rail: latency on top, the route
   picker below. Two short rows read better than one cramped row in a column. */
.rdp-container[data-hud-dock="left"] .rdp-bottombar,
.rdp-container[data-hud-dock="right"] .rdp-bottombar {
    flex-direction: column;
    flex-wrap: nowrap;
    align-items: center;
    gap: var(--rdp-space-1);
    padding: var(--rdp-space-2) var(--rdp-space-1);
    min-width: 0;
    border-top: 1px solid var(--rdp-hairline);
}
.rdp-container[data-hud-dock="left"] .rdp-bottombar { border-left: none; }
.rdp-container[data-hud-dock="right"] .rdp-bottombar { border-right: none; }

/* Keep the transport word horizontal - it gets its own row. */
.rdp-container[data-hud-dock="left"] .rdp-transport,
.rdp-container[data-hud-dock="right"] .rdp-transport {
    writing-mode: horizontal-tb;
    padding: 2px var(--rdp-space-2);
    font-size: 0.66rem;
}

.rdp-container[data-hud-dock="left"] .rdp-transport-dot,
.rdp-container[data-hud-dock="right"] .rdp-transport-dot {
    margin-bottom: 0;
}

/* -------------------------------------------------- HUD grip
   Deliberately tiny and inert unless targeted: this is the ONLY way to
   reopen the panel, so ordinary pointer movement never pops it open. */
.rdp-hud-handle {
    position: absolute;
    z-index: 41;
    display: none;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;
}

.rdp-hud-handle::before {
    content: '';
    position: absolute;
    border-radius: var(--rdp-radius-pill);
    background: var(--rdp-grip, rgba(255, 255, 255, 0.34));
    box-shadow: var(--rdp-shadow-1);
    transition: background var(--rdp-duration-fast) var(--rdp-ease),
                transform var(--rdp-duration-fast) var(--rdp-ease);
}

/* The grip only exists while the panel is folded away. */
.rdp-container.rdp-chrome-autohide.rdp-chrome-hidden .rdp-hud-handle { display: block; }

/* Grip geometry per dock: a horizontal bar on top/bottom, a vertical bar on
   the sides, always positioned on the edge the panel would slide from. */
.rdp-container[data-hud-dock="top"] .rdp-hud-handle,
.rdp-container[data-hud-dock="bottom"] .rdp-hud-handle {
    left: 50%;
    width: 64px;
    height: 14px;
    transform: translateX(-50%);
}
.rdp-container[data-hud-dock="top"] .rdp-hud-handle { top: 0; }
.rdp-container[data-hud-dock="bottom"] .rdp-hud-handle { bottom: 0; }

.rdp-container[data-hud-dock="top"] .rdp-hud-handle::before,
.rdp-container[data-hud-dock="bottom"] .rdp-hud-handle::before {
    left: 50%;
    width: 36px;
    height: 4px;
    transform: translateX(-50%);
}
.rdp-container[data-hud-dock="top"] .rdp-hud-handle::before { top: 4px; }
.rdp-container[data-hud-dock="bottom"] .rdp-hud-handle::before { bottom: 4px; }

.rdp-container[data-hud-dock="left"] .rdp-hud-handle,
.rdp-container[data-hud-dock="right"] .rdp-hud-handle {
    top: 50%;
    width: 14px;
    height: 64px;
    transform: translateY(-50%);
}
.rdp-container[data-hud-dock="left"] .rdp-hud-handle { left: 0; }
.rdp-container[data-hud-dock="right"] .rdp-hud-handle { right: 0; }

.rdp-container[data-hud-dock="left"] .rdp-hud-handle::before,
.rdp-container[data-hud-dock="right"] .rdp-hud-handle::before {
    top: 50%;
    width: 4px;
    height: 36px;
    transform: translateY(-50%);
}
.rdp-container[data-hud-dock="left"] .rdp-hud-handle::before { left: 4px; }
.rdp-container[data-hud-dock="right"] .rdp-hud-handle::before { right: 4px; }

.rdp-hud-handle:hover::before,
.rdp-hud-handle:focus-visible::before {
    background: var(--rdp-accent);
}
.rdp-container[data-hud-dock="top"] .rdp-hud-handle:hover::before,
.rdp-container[data-hud-dock="bottom"] .rdp-hud-handle:hover::before {
    width: 46px;
}
.rdp-container[data-hud-dock="left"] .rdp-hud-handle:hover::before,
.rdp-container[data-hud-dock="right"] .rdp-hud-handle:hover::before {
    height: 46px;
}

/* Enlarge the pointer target without enlarging the visible grip. */
.rdp-hud-handle::after {
    content: '';
    position: absolute;
    inset: -6px -24px;
}
.rdp-container[data-hud-dock="left"] .rdp-hud-handle::after,
.rdp-container[data-hud-dock="right"] .rdp-hud-handle::after {
    inset: -24px -6px;
}

/* -------------------------------------------------- Collapsed state */
.rdp-container.rdp-chrome-autohide.rdp-chrome-hidden .rdp-hud {
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
}

.rdp-container[data-hud-dock="top"].rdp-chrome-hidden .rdp-hud {
    transform: translateX(-50%) translateY(-10px) scale(0.96);
}
.rdp-container[data-hud-dock="bottom"].rdp-chrome-hidden .rdp-hud {
    transform: translateX(-50%) translateY(10px) scale(0.96);
}
.rdp-container[data-hud-dock="left"].rdp-chrome-hidden .rdp-hud {
    transform: translateY(-50%) translateX(-10px) scale(0.96);
}
.rdp-container[data-hud-dock="right"].rdp-chrome-hidden .rdp-hud {
    transform: translateY(-50%) translateX(10px) scale(0.96);
}

/* -------------------------------------------------- Fullscreen */
.rdp-container.fs-autohide[data-hud-dock="top"] .rdp-hud { top: var(--rdp-space-2); }
.rdp-container.fs-autohide[data-hud-dock="bottom"] .rdp-hud { bottom: var(--rdp-space-2); }
.rdp-container.fs-autohide[data-hud-dock="left"] .rdp-hud { left: var(--rdp-space-2); }
.rdp-container.fs-autohide[data-hud-dock="right"] .rdp-hud { right: var(--rdp-space-2); }

/* -------------------------------------------------- Status
   Doubles as the connect trigger: when idle it opens the connection dialog,
   which is why the standalone Connect button was removed (it duplicated this
   and the large "+" on the empty screen).

   Icon-only: the state reads from the glyph (ring + check when live, plain
   ring when off, circle + bang on error). The text stays in the DOM for screen
   readers only, so no visual label is needed. */
.rdp-status {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--rdp-control-height);
    height: var(--rdp-control-height);
    flex-shrink: 0;
    padding: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--rdp-radius-pill);
    color: var(--rdp-text-muted);
    cursor: pointer;
    font-family: inherit;
    transition: color var(--rdp-duration) var(--rdp-ease),
                background var(--rdp-duration-fast) var(--rdp-ease);
}

.rdp-status:hover:not(:disabled) {
    background: color-mix(in srgb, var(--rdp-accent) 16%, transparent);
    color: var(--rdp-accent);
}

/* Once connected there is nothing to open; the icon becomes a plain indicator. */
.rdp-status[data-state="connected"] { cursor: default; }
.rdp-status[data-state="connected"]:hover { background: transparent; }

.rdp-status[data-state="connected"] { color: var(--rdp-success); }
.rdp-status[data-state="connecting"] { color: var(--rdp-accent); cursor: progress; }
.rdp-status[data-state="error"] { color: var(--rdp-error); }

.rdp-status-icon {
    position: relative;
    display: inline-flex;
    width: var(--rdp-icon-size);
    height: var(--rdp-icon-size);
}

.rdp-status-glyph {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    transition: opacity var(--rdp-duration) var(--rdp-ease);
}

/* Only one glyph is visible per state. */
.rdp-status[data-state="disconnected"] .rdp-glyph-off,
.rdp-status[data-state="connected"] .rdp-glyph-on,
.rdp-status[data-state="error"] .rdp-glyph-error { opacity: 1; }

/* Connecting reuses the "off" ring, pulsing to show work in progress. */
.rdp-status[data-state="connecting"] .rdp-glyph-off {
    opacity: 1;
    animation: rdp-pulse 1.4s ease-in-out infinite;
}

@keyframes rdp-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
}

/* Theme toggle: two stacked glyphs, only the one you would switch TO shows.
   Both are absolutely positioned inside the button's icon box so the button
   aligns exactly like every other icon button in the rail. */
.rdp-btn-theme { position: relative; }

.rdp-theme-glyph {
    position: absolute;
    inset: 0;
    margin: auto;
    width: var(--rdp-icon-size);
    height: var(--rdp-icon-size);
    opacity: 0;
    transition: opacity var(--rdp-duration) var(--rdp-ease);
}

.rdp-container[data-theme-mode="dark"] .rdp-glyph-sun { opacity: 1; }
.rdp-container[data-theme-mode="light"] .rdp-glyph-moon { opacity: 1; }

/* Light mode: the glass panel needs a touch more opacity and a firmer edge to
   stay legible over bright screenshots. */
.rdp-container[data-theme-mode="light"] .rdp-hud {
    background: color-mix(in srgb, var(--rdp-surface) 94%, transparent);
    border-color: color-mix(in srgb, var(--rdp-border) 92%, #101828 8%);
}

.rdp-container[data-theme-mode="light"] .rdp-screen {
    /* A hairline plus a soft inner shade separates the picture area from the
       light page background without boxing it in. */
    box-shadow:
        inset 0 0 0 1px rgba(16, 24, 40, 0.12),
        inset 0 2px 10px rgba(16, 24, 40, 0.06);
}

/* The grip sits on the remote desktop, so it needs a dark mark on light UIs. */
.rdp-container[data-theme-mode="light"] .rdp-hud-handle::before {
    box-shadow: 0 1px 3px rgba(16, 24, 40, 0.35);
}

/* Visually hidden but still announced (status text, screen-reader labels). */
.rdp-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
}

/* -------------------------------------------------- Controls */
.rdp-controls {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--rdp-space-1);
}

.rdp-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--rdp-space-1);
    background: var(--rdp-btn-bg);
    border: 1px solid var(--rdp-hairline);
    color: var(--rdp-btn-text);
    padding: 0 var(--rdp-space-3);
    height: var(--rdp-control-height);
    border-radius: var(--rdp-border-radius);
    cursor: pointer;
    font-size: var(--rdp-font-size-small);
    font-family: inherit;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    transition: background var(--rdp-duration-fast) var(--rdp-ease),
                color var(--rdp-duration-fast) var(--rdp-ease),
                border-color var(--rdp-duration-fast) var(--rdp-ease),
                box-shadow var(--rdp-duration-fast) var(--rdp-ease),
                transform var(--rdp-duration-fast) var(--rdp-ease);
}

.rdp-btn:hover:not(:disabled) {
    background: var(--rdp-btn-hover);
    border-color: color-mix(in srgb, var(--rdp-accent) 35%, var(--rdp-border));
    box-shadow: var(--rdp-shadow-1);
}

.rdp-btn:active:not(:disabled) {
    transform: translateY(1px);
    box-shadow: none;
}

.rdp-btn:disabled { opacity: 0.42; cursor: not-allowed; }

/* Danger-tinted while a session is live, so Disconnect reads as the exit. */
.rdp-btn.rdp-btn-icon.rdp-btn-disconnect:not(:disabled):hover {
    background: color-mix(in srgb, var(--rdp-error) 18%, transparent);
    border-color: color-mix(in srgb, var(--rdp-error) 40%, transparent);
    color: var(--rdp-error);
}

/* Reconnect is a stateful toggle: subtle when off, accented when on. */
.rdp-btn.rdp-btn-icon.rdp-btn-reconnect.on {
    background: color-mix(in srgb, var(--rdp-success) 18%, transparent);
    border-color: color-mix(in srgb, var(--rdp-success) 45%, transparent);
    color: var(--rdp-success);
}

/* Icon buttons keep a square hit area even though the glyph is smaller. */
/* Icon buttons are a fixed square so every glyph shares one optical centre.
   flex: 0 0 auto prevents the rail from shrinking them out of alignment. */
.rdp-btn.rdp-btn-icon {
    flex: 0 0 auto;
    width: var(--rdp-control-height);
    min-width: var(--rdp-control-height);
    height: var(--rdp-control-height);
    padding: 0;
    background: transparent;
    border-color: transparent;
    color: var(--rdp-text-muted);
}
.rdp-btn.rdp-btn-icon:hover:not(:disabled) {
    background: var(--rdp-btn-hover);
    color: var(--rdp-text);
    border-color: var(--rdp-hairline);
}

/* Pin button reflects a persistent "keep controls visible" toggle. */
.rdp-btn.rdp-btn-pin.on {
    background: color-mix(in srgb, var(--rdp-accent) 18%, transparent);
    border-color: color-mix(in srgb, var(--rdp-accent) 45%, transparent);
    color: var(--rdp-accent);
}
.rdp-btn-icon svg {
    width: var(--rdp-icon-size);
    height: var(--rdp-icon-size);
    display: block;
    flex-shrink: 0;
}

/* Hidden IME anchor still needs a focusable box, kept out of layout. */
/* -------------------------------------------------- Overflow menu */
.rdp-overflow-container { position: relative; }

.rdp-btn-overflow { display: none; }
.rdp-btn.rdp-btn-overflow.visible { display: inline-flex; }

.rdp-overflow-dropdown {
    position: absolute;
    top: calc(100% + var(--rdp-space-1));
    right: 0;
    background: var(--rdp-elevated);
    border: 1px solid var(--rdp-border);
    border-radius: var(--rdp-border-radius-lg);
    box-shadow: var(--rdp-shadow-2);
    display: none;
    flex-direction: column;
    min-width: 184px;
    z-index: 100;
    padding: var(--rdp-space-1);
    gap: 2px;
    animation: rdp-pop-in var(--rdp-duration) var(--rdp-ease);
}

/* Open toward the picture, not off-screen, on vertical rails. */
.rdp-container[data-hud-dock="left"] .rdp-overflow-dropdown {
    top: 0;
    right: auto;
    left: calc(100% + var(--rdp-space-2));
}
.rdp-container[data-hud-dock="right"] .rdp-overflow-dropdown {
    top: 0;
    right: calc(100% + var(--rdp-space-2));
}
/* Dock to the bottom edge: drop the menu upward so it stays on screen. */
.rdp-container[data-hud-dock="bottom"] .rdp-overflow-dropdown {
    top: auto;
    bottom: calc(100% + var(--rdp-space-1));
}

.rdp-overflow-dropdown.open { display: flex; }

.rdp-overflow-dropdown .rdp-btn {
    justify-content: flex-start;
    min-height: 34px;
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    font-weight: 500;
}
.rdp-overflow-dropdown .rdp-btn:hover:not(:disabled) {
    background: var(--rdp-btn-hover);
}

.rdp-btn-menu-item svg {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
}

@keyframes rdp-pop-in {
    from { opacity: 0; transform: translateY(-4px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
}

.rdp-btn.rdp-collapsed { display: none !important; }

/* Single-line button labels */
.rdp-btn-no-wrap {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
}

/* -------------------------------------------------- Toast */
.rdp-toast {
    position: absolute;
    left: 50%;
    bottom: 58px;   /* clears the floating bottom bar */
    display: inline-flex;
    align-items: center;
    gap: var(--rdp-space-2);
    transform: translate(-50%, 10px);
    max-width: min(90%, 520px);
    padding: var(--rdp-space-2) var(--rdp-space-4);
    border-radius: var(--rdp-radius-pill);
    background: var(--rdp-elevated);
    border: 1px solid var(--rdp-border);
    box-shadow: var(--rdp-shadow-2);
    color: var(--rdp-text);
    font-size: var(--rdp-font-size-small);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--rdp-duration) var(--rdp-ease),
                transform var(--rdp-duration) var(--rdp-ease);
    z-index: 200;
}

.rdp-toast::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--rdp-accent);
    flex-shrink: 0;
}

.rdp-toast.show {
    opacity: 1;
    transform: translate(-50%, 0);
}

.rdp-toast.success { border-color: color-mix(in srgb, var(--rdp-success) 55%, transparent); }
.rdp-toast.success::before { background: var(--rdp-success); }
.rdp-toast.error { border-color: color-mix(in srgb, var(--rdp-error) 55%, transparent); }
.rdp-toast.error::before { background: var(--rdp-error); }

/* -------------------------------------------------- API cursor */
.rdp-api-cursor {
    position: absolute;
    pointer-events: none;
    z-index: 100;
    display: none;
    transform: translate(-2px, -2px);
}
.rdp-api-cursor.visible { display: block; }
.rdp-api-cursor-icon {
    width: 24px;
    height: 24px;
    filter: drop-shadow(1px 1px 2px rgba(0, 0, 0, 0.7));
}

/* -------------------------------------------------- Empty / loading state */
.rdp-loading {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: var(--rdp-space-3);
    padding: var(--rdp-space-5);
    border-radius: var(--rdp-border-radius-lg);
}

.rdp-loading:focus-visible {
    box-shadow: var(--rdp-focus-ring);
    outline: none;
}

.rdp-loading p {
    max-width: 32ch;
    color: var(--rdp-text-muted);
    font-size: var(--rdp-font-size-small);
    line-height: 1.5;
    letter-spacing: 0.01em;
}

/* Idle: a "+" affordance instead of a spinner; clicking opens the modal. */

.rdp-spinner {
    width: 34px;
    height: 34px;
    border: 2px solid color-mix(in srgb, var(--rdp-border) 90%, transparent);
    border-top-color: var(--rdp-accent);
    border-radius: 50%;
    animation: rdp-spin 0.9s linear infinite;
}

@keyframes rdp-spin {
    to { transform: rotate(360deg); }
}

/* Idle: a "+" affordance instead of a spinner; clicking opens the modal. */
.rdp-plus {
    display: none;
    width: 64px;
    height: 64px;
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in srgb, var(--rdp-accent) 55%, transparent);
    border-radius: 50%;
    color: var(--rdp-accent);
    background: color-mix(in srgb, var(--rdp-accent) 8%, transparent);
    transition: background var(--rdp-duration) var(--rdp-ease),
                color var(--rdp-duration) var(--rdp-ease),
                box-shadow var(--rdp-duration) var(--rdp-ease),
                transform var(--rdp-duration) var(--rdp-ease);
}

.rdp-plus svg { width: 26px; height: 26px; display: block; }

.rdp-loading.idle .rdp-spinner { display: none; }
.rdp-loading.idle .rdp-plus { display: flex; }
.rdp-loading.idle:hover .rdp-plus {
    background: var(--rdp-accent);
    color: var(--rdp-accent-text);
    transform: translateY(-1px);
    box-shadow: 0 0 0 8px color-mix(in srgb, var(--rdp-accent) 10%, transparent);
}

/* Hidden, focusable field that captures IME composition (CJK / dead keys).
   It must be an editable element for the browser IME to deliver characters. */
.rdp-ime {
    position: absolute;
    top: 0;
    left: 0;
    width: 1px;
    height: 1px;
    min-width: 1px;
    padding: 0;
    margin: 0;
    border: 0;
    outline: none;
    background: transparent;
    color: transparent;
    caret-color: transparent;
    resize: none;
    overflow: hidden;
    opacity: 0;
    z-index: 1;
    font-size: 16px; /* prevent iOS zoom-on-focus */
}

/* -------------------------------------------------- Bottom bar internals
   Metrics are icon + value, with the label carried by the title attribute and
   an aria-label, so no visible text is wasted on "Resolution:" / "Latency:". */
.rdp-metric {
    display: inline-flex;
    align-items: center;
    gap: var(--rdp-space-1);
    flex-shrink: 0;
    white-space: nowrap;
    border-radius: var(--rdp-border-radius);
    padding: 0 2px;
}

.rdp-metric-icon {
    width: 13px;
    height: 13px;
    flex-shrink: 0;
    color: color-mix(in srgb, var(--rdp-text-muted) 80%, transparent);
}

.rdp-metric-value {
    font-family: var(--rdp-font-mono);
    font-size: 0.74rem;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.01em;
    color: var(--rdp-text-muted);
}

/* Transport badge doubles as the route picker trigger */
.rdp-transport {
    display: inline-flex;
    align-items: center;
    gap: var(--rdp-space-2);
    padding: 2px var(--rdp-space-2);
    border-radius: var(--rdp-radius-pill);
    border: 1px solid var(--rdp-border);
    background: color-mix(in srgb, var(--rdp-text) 5%, transparent);
    font-family: var(--rdp-font-mono);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    transition: border-color var(--rdp-duration-fast) var(--rdp-ease),
                color var(--rdp-duration-fast) var(--rdp-ease),
                background var(--rdp-duration-fast) var(--rdp-ease);
}
.rdp-transport.rdp-transport-ws { color: var(--rdp-text-muted); }
.rdp-transport.rdp-transport-rtc {
    color: var(--rdp-success);
    border-color: color-mix(in srgb, var(--rdp-success) 45%, transparent);
    background: color-mix(in srgb, var(--rdp-success) 10%, transparent);
}
.rdp-transport:hover { background: color-mix(in srgb, var(--rdp-text) 10%, transparent); }

.rdp-transport-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
}

/* -------------------------------------------------- Dock picker */
.rdp-dock-pop {
    position: absolute;
    min-width: 168px;
    background: var(--rdp-elevated);
    border: 1px solid var(--rdp-border);
    border-radius: var(--rdp-border-radius-lg);
    box-shadow: var(--rdp-shadow-2);
    padding: var(--rdp-space-1);
    z-index: 60;
    display: none;
    flex-direction: column;
    gap: 2px;
    animation: rdp-pop-in var(--rdp-duration) var(--rdp-ease);
}
.rdp-dock-pop.open { display: flex; }

/* Anchor the dock list to whichever edge the HUD currently sits on. */
.rdp-container[data-hud-dock="top"] .rdp-dock-pop { top: calc(100% + var(--rdp-space-2)); left: 0; }
.rdp-container[data-hud-dock="bottom"] .rdp-dock-pop { bottom: calc(100% + var(--rdp-space-2)); left: 0; }
.rdp-container[data-hud-dock="left"] .rdp-dock-pop { left: calc(100% + var(--rdp-space-2)); top: 0; }
.rdp-container[data-hud-dock="right"] .rdp-dock-pop { right: calc(100% + var(--rdp-space-2)); top: 0; }

.rdp-dock-item {
    display: flex;
    align-items: center;
    gap: var(--rdp-space-2);
    width: 100%;
    padding: var(--rdp-space-2);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--rdp-border-radius);
    color: var(--rdp-text);
    font-size: var(--rdp-font-size-small);
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    transition: background var(--rdp-duration-fast) var(--rdp-ease),
                border-color var(--rdp-duration-fast) var(--rdp-ease);
}
.rdp-dock-item:hover { background: var(--rdp-btn-hover); }
.rdp-dock-item.active {
    border-color: color-mix(in srgb, var(--rdp-accent) 55%, transparent);
    background: color-mix(in srgb, var(--rdp-accent) 10%, transparent);
}
.rdp-dock-item svg { width: 16px; height: 16px; flex-shrink: 0; color: var(--rdp-text-muted); }
.rdp-dock-item.active svg { color: var(--rdp-accent); }

/* -------------------------------------------------- Route picker */
.rdp-route-pop {
    position: absolute;
    top: calc(100% + var(--rdp-space-2));
    left: 0;
    min-width: 268px;
    max-width: 100%;
    background: var(--rdp-elevated);
    border: 1px solid var(--rdp-border);
    border-radius: var(--rdp-border-radius-lg);
    box-shadow: var(--rdp-shadow-2);
    padding: var(--rdp-space-1);
    z-index: 60;
    display: none;
    flex-direction: column;
    gap: 2px;
    animation: rdp-pop-in var(--rdp-duration) var(--rdp-ease);
}
.rdp-route-pop.open { display: flex; }

/* On vertical rails the route list must open sideways. */
.rdp-container[data-hud-dock="left"] .rdp-route-pop {
    top: 0;
    left: calc(100% + var(--rdp-space-2));
}
.rdp-container[data-hud-dock="right"] .rdp-route-pop {
    top: 0;
    left: auto;
    right: calc(100% + var(--rdp-space-2));
}
.rdp-container[data-hud-dock="bottom"] .rdp-route-pop {
    top: auto;
    bottom: calc(100% + var(--rdp-space-2));
}

.rdp-route-head {
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--rdp-text-muted);
    padding: var(--rdp-space-2) var(--rdp-space-2) var(--rdp-space-1);
}

.rdp-route-item {
    display: flex;
    align-items: center;
    gap: var(--rdp-space-2);
    width: 100%;
    background: transparent;
    border: 1px solid transparent;
    color: var(--rdp-text);
    font-size: var(--rdp-font-size-small);
    font-family: inherit;
    padding: var(--rdp-space-2);
    border-radius: var(--rdp-border-radius);
    cursor: pointer;
    text-align: left;
    transition: background var(--rdp-duration-fast) var(--rdp-ease),
                border-color var(--rdp-duration-fast) var(--rdp-ease);
}
.rdp-route-item:hover:not(:disabled) { background: var(--rdp-btn-hover); }
.rdp-route-item:disabled { opacity: 0.4; cursor: not-allowed; }
.rdp-route-item.active {
    border-color: color-mix(in srgb, var(--rdp-accent) 55%, transparent);
    background: color-mix(in srgb, var(--rdp-accent) 10%, transparent);
}
.rdp-route-name {
    font-family: var(--rdp-font-mono);
    font-weight: 600;
    font-size: 0.75rem;
    letter-spacing: 0.04em;
    min-width: 62px;
}
.rdp-route-meta {
    color: var(--rdp-text-muted);
    font-size: 0.76rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.rdp-route-check { margin-left: auto; color: var(--rdp-accent); font-size: 0.6rem; }

/* -------------------------------------------------- Modal */
.rdp-modal {
    display: none;
    position: absolute;
    inset: 0;
    z-index: 300;
    padding: var(--rdp-space-4);
    background: var(--rdp-scrim);
    backdrop-filter: blur(3px);
    justify-content: center;
    align-items: center;
}

.rdp-modal.active { display: flex; }

.rdp-modal-content {
    width: min(400px, 100%);
    max-height: 100%;
    overflow-y: auto;
    padding: var(--rdp-space-5);
    background: var(--rdp-surface);
    border: 1px solid var(--rdp-border);
    border-radius: var(--rdp-border-radius-lg);
    box-shadow: var(--rdp-shadow-3);
    animation: rdp-modal-in var(--rdp-duration) var(--rdp-ease);
}

@keyframes rdp-modal-in {
    from { opacity: 0; transform: translateY(8px) scale(0.985); }
    to { opacity: 1; transform: translateY(0) scale(1); }
}

.rdp-modal-content h2 {
    margin-bottom: var(--rdp-space-4);
    font-size: 1.05rem;
    font-weight: 600;
    letter-spacing: -0.01em;
}

/* Small caption under the title, injected by CSS to avoid template churn */
.rdp-modal-content h2::after {
    content: 'Credentials are sent over the RDP session and stored locally only if you choose to remember them.';
    display: block;
    margin-top: var(--rdp-space-1);
    font-size: 0.76rem;
    font-weight: 400;
    line-height: 1.4;
    color: var(--rdp-text-muted);
    letter-spacing: 0;
}

.rdp-form-group { margin-bottom: var(--rdp-space-3); }

.rdp-form-group label {
    display: block;
    margin-bottom: var(--rdp-space-1);
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--rdp-text-muted);
}

.rdp-form-group input {
    width: 100%;
    height: var(--rdp-control-height);
    padding: 0 var(--rdp-space-3);
    border: 1px solid var(--rdp-input-border);
    border-radius: var(--rdp-border-radius);
    background: var(--rdp-input-bg);
    color: var(--rdp-text);
    font-size: var(--rdp-font-size-small);
    font-family: inherit;
    transition: border-color var(--rdp-duration-fast) var(--rdp-ease),
                box-shadow var(--rdp-duration-fast) var(--rdp-ease);
}

.rdp-form-group input::placeholder { color: var(--rdp-text-muted); opacity: 0.65; }

.rdp-form-group input:focus {
    outline: none;
    border-color: var(--rdp-input-focus-border);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--rdp-accent) 20%, transparent);
}

.rdp-form-checkbox { margin-top: var(--rdp-space-1); }
.rdp-form-checkbox label {
    display: inline-flex;
    align-items: center;
    gap: var(--rdp-space-2);
    margin: 0;
    font-size: var(--rdp-font-size-small);
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
    color: var(--rdp-text-muted);
    cursor: pointer;
}
.rdp-form-checkbox input[type="checkbox"] {
    width: 15px;
    height: 15px;
    accent-color: var(--rdp-accent);
    cursor: pointer;
}

.rdp-modal-error {
    display: none;
    margin-bottom: var(--rdp-space-3);
    padding: var(--rdp-space-2) var(--rdp-space-3);
    border: 1px solid color-mix(in srgb, var(--rdp-error) 50%, transparent);
    border-left-width: 3px;
    border-radius: var(--rdp-border-radius);
    background: color-mix(in srgb, var(--rdp-error) 12%, transparent);
    color: var(--rdp-error);
    font-size: var(--rdp-font-size-small);
    line-height: 1.4;
    word-break: break-word;
}

.rdp-modal-error.show { display: block; }

.rdp-modal-buttons {
    display: flex;
    gap: var(--rdp-space-2);
    margin-top: var(--rdp-space-5);
}

.rdp-modal-buttons .rdp-btn { flex: 1; height: 38px; }

.rdp-modal-buttons .rdp-btn-primary {
    background: var(--rdp-accent);
    color: var(--rdp-accent-text);
    border-color: transparent;
    font-weight: 600;
}
.rdp-modal-buttons .rdp-btn-primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--rdp-accent) 88%, #ffffff 12%);
}

/* -------------------------------------------------- Virtual keyboard */
.rdp-keyboard-overlay {
    display: none;
    position: absolute;
    padding: var(--rdp-space-2);
    background: color-mix(in srgb, var(--rdp-surface) 96%, transparent);
    border: 1px solid var(--rdp-border);
    border-radius: var(--rdp-border-radius-lg);
    box-shadow: var(--rdp-shadow-3);
    z-index: 100;
    user-select: none;
    overflow: hidden;
}

.rdp-keyboard-overlay.visible { display: block; }

.rdp-keyboard-titlebar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 var(--rdp-space-1) 0 var(--rdp-space-2);
    margin-bottom: var(--rdp-space-2);
    height: 26px;
    border-radius: var(--rdp-border-radius);
    background: color-mix(in srgb, var(--rdp-text) 4%, transparent);
    cursor: move;
}

.rdp-keyboard-title {
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--rdp-text-muted);
}

.rdp-keyboard-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    background: transparent;
    border: none;
    border-radius: var(--rdp-border-radius);
    color: var(--rdp-text-muted);
    font-size: 1.05rem;
    line-height: 1;
    cursor: pointer;
    transition: background var(--rdp-duration-fast) var(--rdp-ease),
                color var(--rdp-duration-fast) var(--rdp-ease);
}
.rdp-keyboard-close:hover {
    background: color-mix(in srgb, var(--rdp-error) 18%, transparent);
    color: var(--rdp-error);
}

.rdp-keyboard-content { transform-origin: top left; width: max-content; }

.rdp-keyboard-rows {
    display: flex;
    flex-direction: column;
    gap: var(--rdp-space-1);
}

.rdp-keyboard-row {
    display: flex;
    gap: var(--rdp-space-1);
    justify-content: center;
}

.rdp-key {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 34px;
    height: 34px;
    padding: 0 var(--rdp-space-2);
    background: var(--rdp-btn-bg);
    border: 1px solid var(--rdp-border);
    border-bottom-width: 2px;
    border-radius: var(--rdp-border-radius);
    color: var(--rdp-btn-text);
    font-size: 0.74rem;
    font-family: inherit;
    font-weight: 500;
    cursor: pointer;
    transition: background var(--rdp-duration-fast) var(--rdp-ease),
                border-color var(--rdp-duration-fast) var(--rdp-ease),
                transform var(--rdp-duration-fast) var(--rdp-ease);
}

.rdp-key:hover { background: var(--rdp-btn-hover); }

.rdp-key:active,
.rdp-key.pressed {
    background: var(--rdp-accent);
    border-color: var(--rdp-accent);
    color: var(--rdp-accent-text);
    transform: translateY(1px);
    border-bottom-width: 1px;
}

.rdp-key-wide { min-width: 58px; }
.rdp-key-wider { min-width: 78px; }
.rdp-key-widest { min-width: 98px; }
.rdp-key-space { min-width: 200px; }

/* Modifiers read as a different key class than letters */
.rdp-key-modifier {
    background: color-mix(in srgb, var(--rdp-btn-bg) 60%, var(--rdp-border) 40%);
    color: var(--rdp-text-muted);
    font-size: 0.7rem;
    letter-spacing: 0.03em;
}
.rdp-key-modifier:hover { color: var(--rdp-text); }

.rdp-key-special {
    background: color-mix(in srgb, var(--rdp-accent) 14%, var(--rdp-btn-bg));
    border-color: color-mix(in srgb, var(--rdp-accent) 35%, transparent);
    color: var(--rdp-accent);
}
.rdp-key-special:hover {
    background: color-mix(in srgb, var(--rdp-accent) 24%, var(--rdp-btn-bg));
}

.rdp-keyboard-resize {
    position: absolute;
    bottom: 2px;
    right: 2px;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    opacity: 0.45;
}
.rdp-keyboard-resize:hover { opacity: 1; }

.rdp-keyboard-resize::before,
.rdp-keyboard-resize::after {
    content: '';
    position: absolute;
    background: var(--rdp-text-muted);
    border-radius: 1px;
}
.rdp-keyboard-resize::before {
    width: 12px;
    height: 2px;
    bottom: 2px;
    right: 0;
    transform: rotate(-45deg);
    transform-origin: right bottom;
}
.rdp-keyboard-resize::after {
    width: 8px;
    height: 2px;
    bottom: 6px;
    right: 0;
    transform: rotate(-45deg);
    transform-origin: right bottom;
}
`;

// ============================================================
// HTML TEMPLATE
// ============================================================
const TEMPLATE = `
<div class="rdp-container" data-hud-dock="top">
    <!-- Slim grip: the only way to bring the HUD back, so casual mouse
         movement in the remote desktop never pops it open by accident. -->
    <button class="rdp-hud-handle" type="button" title="Show controls" aria-label="Show controls" aria-expanded="true"></button>

    <div class="rdp-hud">
        <div class="rdp-topbar">
            <button type="button" class="rdp-status" data-state="disconnected" title="Disconnected — click to connect" aria-label="Disconnected. Click to connect.">
                <span class="rdp-status-icon" aria-hidden="true">
                    <svg class="rdp-status-glyph rdp-glyph-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v9"/><path d="M6.34 6.34a8 8 0 1 0 11.32 0"/></svg>
                    <svg class="rdp-status-glyph rdp-glyph-on" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" fill="currentColor"/><path d="m7.8 12.2 2.9 2.9 5.5-5.6" fill="none" stroke="var(--rdp-surface)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    <svg class="rdp-status-glyph rdp-glyph-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>
                </span>
            </button>
            <span class="rdp-status-text rdp-sr-only" role="status" aria-live="polite">Disconnected</span>
            <div class="rdp-controls">
                <button class="rdp-btn rdp-btn-icon rdp-btn-disconnect" data-collapse-priority="2" disabled title="Disconnect" aria-label="Disconnect">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v9"/><path d="M6.34 6.34a8 8 0 1 0 11.32 0"/><path d="m3 3 18 18"/></svg>
                </button>
                <button class="rdp-btn rdp-btn-icon rdp-btn-reconnect" data-collapse-priority="3" title="Auto reconnect: off" aria-label="Toggle auto reconnect" aria-pressed="false">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/></svg>
                </button>
                <button class="rdp-btn rdp-btn-icon rdp-btn-keyboard" data-collapse-priority="never" disabled title="Toggle virtual keyboard" aria-label="Toggle virtual keyboard" aria-pressed="false">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/></svg>
                </button>
                <button class="rdp-btn rdp-btn-icon rdp-btn-mute" data-collapse-priority="never" disabled title="Toggle audio" aria-label="Toggle audio" aria-pressed="false">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6.5 9H3v6h3.5L11 19V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 6a9 9 0 0 1 0 12"/></svg>
                </button>
                <button class="rdp-btn rdp-btn-icon rdp-btn-screenshot" data-collapse-priority="never" disabled title="Take screenshot" aria-label="Take screenshot">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.2l.9-1.4A1.5 1.5 0 0 1 8.9 4h6.2a1.5 1.5 0 0 1 1.3.6L17.3 6h1.2A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-8Z"/><circle cx="12" cy="12.5" r="3.2"/></svg>
                </button>
                <button class="rdp-btn rdp-btn-icon rdp-btn-clipboard" data-collapse-priority="never" disabled title="Push local clipboard to remote" aria-label="Push local clipboard to remote">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><path d="M12 11v6M9.5 14.5 12 17l2.5-2.5"/></svg>
                </button>
                <button class="rdp-btn rdp-btn-icon rdp-btn-fullscreen" data-collapse-priority="never" title="Toggle fullscreen" aria-label="Enter fullscreen" aria-pressed="false">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4"/></svg>
                </button>
                <button class="rdp-btn rdp-btn-icon rdp-btn-pin" data-collapse-priority="never" title="Keep controls visible" aria-label="Keep controls visible" aria-pressed="false">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6M12 4v6l3 3v4H9v-4l3-3V4M12 17v3"/></svg>
                </button>
                <button class="rdp-btn rdp-btn-icon rdp-btn-dock" data-collapse-priority="never" title="Move controls (top)" aria-label="Change dock position" aria-haspopup="menu" aria-expanded="false">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18"/><path d="M9 3v6"/></svg>
                </button>
                <button class="rdp-btn rdp-btn-icon rdp-btn-theme" data-collapse-priority="never" title="Switch to light theme" aria-label="Switch theme" aria-pressed="false">
                    <svg class="rdp-theme-glyph rdp-glyph-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
                    <svg class="rdp-theme-glyph rdp-glyph-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
                </button>
                <div class="rdp-overflow-container">
                    <button class="rdp-btn rdp-btn-icon rdp-btn-overflow" title="More options" aria-label="More options" aria-haspopup="true" aria-expanded="false">
                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>
                    </button>
                    <div class="rdp-overflow-dropdown" role="menu"></div>
                </div>
            </div>
        </div>

        <div class="rdp-bottombar">
            <span class="rdp-metric rdp-latency" title="Round-trip time">
                <svg class="rdp-metric-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20V4"/><path d="m6 10 6-6 6 6"/></svg>
                <span class="rdp-metric-value">--</span>
            </span>
            <span class="rdp-transport rdp-transport-ws" title="Media over WebSocket relay" role="button" tabindex="0" aria-haspopup="true" aria-expanded="false"><span class="rdp-transport-dot"></span><span class="rdp-transport-text">RELAY</span></span>
        </div>

        <div class="rdp-route-pop"></div>
        <div class="rdp-dock-pop" role="menu" aria-label="Dock position"></div>
    </div>

    <div class="rdp-screen-wrapper">
        <div class="rdp-screen">
            <div class="rdp-loading idle">
                <div class="rdp-spinner"></div>
                <div class="rdp-plus"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></div>
                <p>Click to connect</p>
            </div>
            <textarea class="rdp-ime" aria-hidden="true" tabindex="0" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
            <canvas class="rdp-canvas" width="1280" height="720" style="display: none;"></canvas>
            <div class="rdp-toast" role="status" aria-live="polite"></div>
            
            <!-- API Cursor Overlay - shown when using programmatic mouse methods -->
            <div class="rdp-api-cursor">
                <svg class="rdp-api-cursor-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M4 4L10.5 20L12.5 13.5L19 11.5L4 4Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/>
                </svg>
            </div>
            
            <!-- Virtual Keyboard Overlay -->
            <div class="rdp-keyboard-overlay">
                <div class="rdp-keyboard-titlebar">
                    <span class="rdp-keyboard-title">Virtual Keyboard</span>
                    <button class="rdp-keyboard-close" title="Close">×</button>
                </div>
                <div class="rdp-keyboard-content">
                    <div class="rdp-keyboard-rows">
                        <!-- Row 1: Function keys + special -->
                        <div class="rdp-keyboard-row">
                        <button class="rdp-key" data-code="Escape">Esc</button>
                        <button class="rdp-key" data-code="F1">F1</button>
                        <button class="rdp-key" data-code="F2">F2</button>
                        <button class="rdp-key" data-code="F3">F3</button>
                        <button class="rdp-key" data-code="F4">F4</button>
                        <button class="rdp-key" data-code="F5">F5</button>
                        <button class="rdp-key" data-code="F6">F6</button>
                        <button class="rdp-key" data-code="F7">F7</button>
                        <button class="rdp-key" data-code="F8">F8</button>
                        <button class="rdp-key" data-code="F9">F9</button>
                        <button class="rdp-key" data-code="F10">F10</button>
                        <button class="rdp-key" data-code="F11">F11</button>
                        <button class="rdp-key" data-code="F12">F12</button>
                        <button class="rdp-key rdp-key-wide" data-code="Delete">Del</button>
                    </div>
                    <!-- Row 2: Numbers -->
                    <div class="rdp-keyboard-row">
                        <button class="rdp-key" data-code="Backquote" data-key="\`" data-shift="~">\`</button>
                        <button class="rdp-key" data-code="Digit1" data-key="1" data-shift="!" data-altgr="¡" data-shift-altgr="¹">1</button>
                        <button class="rdp-key" data-code="Digit2" data-key="2" data-shift="@" data-altgr="²">2</button>
                        <button class="rdp-key" data-code="Digit3" data-key="3" data-shift="#" data-altgr="³">3</button>
                        <button class="rdp-key" data-code="Digit4" data-key="4" data-shift="$" data-altgr="¤" data-shift-altgr="£">4</button>
                        <button class="rdp-key" data-code="Digit5" data-key="5" data-shift="%" data-altgr="€">5</button>
                        <button class="rdp-key" data-code="Digit6" data-key="6" data-shift="^" data-altgr="¼">6</button>
                        <button class="rdp-key" data-code="Digit7" data-key="7" data-shift="&" data-altgr="½">7</button>
                        <button class="rdp-key" data-code="Digit8" data-key="8" data-shift="*" data-altgr="¾">8</button>
                        <button class="rdp-key" data-code="Digit9" data-key="9" data-shift="(" data-altgr="'">9</button>
                        <button class="rdp-key" data-code="Digit0" data-key="0" data-shift=")" data-altgr="'">0</button>
                        <button class="rdp-key" data-code="Minus" data-key="-" data-shift="_" data-altgr="¥">-</button>
                        <button class="rdp-key" data-code="Equal" data-key="=" data-shift="+" data-altgr="×" data-shift-altgr="÷">=</button>
                        <button class="rdp-key rdp-key-wider" data-code="Backspace">⌫</button>
                    </div>
                    <!-- Row 3: QWERTY top -->
                    <div class="rdp-keyboard-row">
                        <button class="rdp-key rdp-key-wide" data-code="Tab">Tab</button>
                        <button class="rdp-key" data-code="KeyQ" data-key="q" data-shift="Q">Q</button>
                        <button class="rdp-key" data-code="KeyW" data-key="w" data-shift="W">W</button>
                        <button class="rdp-key" data-code="KeyE" data-key="e" data-shift="E">E</button>
                        <button class="rdp-key" data-code="KeyR" data-key="r" data-shift="R">R</button>
                        <button class="rdp-key" data-code="KeyT" data-key="t" data-shift="T">T</button>
                        <button class="rdp-key" data-code="KeyY" data-key="y" data-shift="Y">Y</button>
                        <button class="rdp-key" data-code="KeyU" data-key="u" data-shift="U">U</button>
                        <button class="rdp-key" data-code="KeyI" data-key="i" data-shift="I">I</button>
                        <button class="rdp-key" data-code="KeyO" data-key="o" data-shift="O">O</button>
                        <button class="rdp-key" data-code="KeyP" data-key="p" data-shift="P">P</button>
                        <button class="rdp-key" data-code="BracketLeft" data-key="[" data-shift="{">[</button>
                        <button class="rdp-key" data-code="BracketRight" data-key="]" data-shift="}">]</button>
                        <button class="rdp-key rdp-key-wide" data-code="Backslash" data-key="\\" data-shift="|">\\</button>
                    </div>
                    <!-- Row 4: ASDF middle -->
                    <div class="rdp-keyboard-row">
                        <button class="rdp-key rdp-key-wider" data-code="CapsLock">Caps</button>
                        <button class="rdp-key" data-code="KeyA" data-key="a" data-shift="A" data-altgr="á" data-shift-altgr="Á">A</button>
                        <button class="rdp-key" data-code="KeyS" data-key="s" data-shift="S" data-altgr="ß" data-shift-altgr="§">S</button>
                        <button class="rdp-key" data-code="KeyD" data-key="d" data-shift="D" data-altgr="ð" data-shift-altgr="Ð">D</button>
                        <button class="rdp-key" data-code="KeyF" data-key="f" data-shift="F">F</button>
                        <button class="rdp-key" data-code="KeyG" data-key="g" data-shift="G">G</button>
                        <button class="rdp-key" data-code="KeyH" data-key="h" data-shift="H">H</button>
                        <button class="rdp-key" data-code="KeyJ" data-key="j" data-shift="J">J</button>
                        <button class="rdp-key" data-code="KeyK" data-key="k" data-shift="K">K</button>
                        <button class="rdp-key" data-code="KeyL" data-key="l" data-shift="L" data-altgr="ø" data-shift-altgr="Ø">L</button>
                        <button class="rdp-key" data-code="Semicolon" data-key=";" data-shift=":" data-altgr="¶" data-shift-altgr="°">;</button>
                        <button class="rdp-key" data-code="Quote" data-key="'" data-shift='"' data-altgr="´" data-shift-altgr="¨">'</button>
                        <button class="rdp-key rdp-key-widest" data-code="Enter">Enter</button>
                    </div>
                    <!-- Row 5: ZXCV bottom -->
                    <div class="rdp-keyboard-row">
                        <button class="rdp-key rdp-key-widest rdp-key-modifier" data-code="ShiftLeft" data-modifier="shift">Shift</button>
                        <button class="rdp-key" data-code="KeyZ" data-key="z" data-shift="Z" data-altgr="æ" data-shift-altgr="Æ">Z</button>
                        <button class="rdp-key" data-code="KeyX" data-key="x" data-shift="X">X</button>
                        <button class="rdp-key" data-code="KeyC" data-key="c" data-shift="C" data-altgr="©" data-shift-altgr="¢">C</button>
                        <button class="rdp-key" data-code="KeyV" data-key="v" data-shift="V">V</button>
                        <button class="rdp-key" data-code="KeyB" data-key="b" data-shift="B">B</button>
                        <button class="rdp-key" data-code="KeyN" data-key="n" data-shift="N" data-altgr="ñ" data-shift-altgr="Ñ">N</button>
                        <button class="rdp-key" data-code="KeyM" data-key="m" data-shift="M" data-altgr="µ">M</button>
                        <button class="rdp-key" data-code="Comma" data-key="," data-shift="<" data-altgr="ç" data-shift-altgr="Ç">,</button>
                        <button class="rdp-key" data-code="Period" data-key="." data-shift=">">.</button>
                        <button class="rdp-key" data-code="Slash" data-key="/" data-shift="?" data-altgr="¿">?</button>
                        <button class="rdp-key rdp-key-widest rdp-key-modifier" data-code="ShiftRight" data-modifier="shift">Shift</button>
                    </div>
                    <!-- Row 6: Bottom row -->
                    <div class="rdp-keyboard-row">
                        <button class="rdp-key rdp-key-wide rdp-key-modifier" data-code="ControlLeft" data-modifier="ctrl">Ctrl</button>
                        <button class="rdp-key rdp-key-wide rdp-key-modifier" data-code="MetaLeft" data-modifier="meta">Win</button>
                        <button class="rdp-key rdp-key-wide rdp-key-modifier" data-code="AltLeft" data-modifier="alt">Alt</button>
                        <button class="rdp-key rdp-key-space" data-code="Space" data-key=" ">Space</button>
                        <button class="rdp-key rdp-key-wide rdp-key-modifier" data-code="AltRight" data-modifier="altgr">AltGr</button>
                        <button class="rdp-key rdp-key-wide rdp-key-modifier" data-code="ControlRight" data-modifier="ctrl">Ctrl</button>
                        <button class="rdp-key" data-code="ArrowLeft">←</button>
                        <button class="rdp-key" data-code="ArrowUp">↑</button>
                        <button class="rdp-key" data-code="ArrowDown">↓</button>
                        <button class="rdp-key" data-code="ArrowRight">→</button>
                    </div>
                        <!-- Row 7: Special combos -->
                        <div class="rdp-keyboard-row">
                            <button class="rdp-key rdp-key-widest rdp-key-special" data-combo="alt+tab">Alt+Tab</button>
                            <button class="rdp-key rdp-key-widest rdp-key-special" data-combo="ctrl+alt+delete">Ctrl+Alt+Del</button>
                        </div>
                    </div>
                </div>
                <div class="rdp-keyboard-resize"></div>
            </div>
        </div>
    </div>

    <div class="rdp-modal">
        <div class="rdp-modal-content" role="dialog" aria-modal="true" aria-labelledby="rdp-modal-title">
            <h2 id="rdp-modal-title">Connect to Remote Desktop</h2>
            <div class="rdp-modal-error" role="alert"></div>
            <div class="rdp-form-group">
                <label for="rdp-input-host">Host</label>
                <input id="rdp-input-host" type="text" class="rdp-input-host" placeholder="192.168.1.100" autocomplete="off">
            </div>
            <div class="rdp-form-group">
                <label for="rdp-input-port">Port</label>
                <input id="rdp-input-port" type="number" class="rdp-input-port" value="3389" min="1" max="65535">
            </div>
            <div class="rdp-form-group">
                <label for="rdp-input-user">Username</label>
                <input id="rdp-input-user" type="text" class="rdp-input-user" placeholder="Administrator" autocomplete="username">
            </div>
            <div class="rdp-form-group">
                <label for="rdp-input-pass">Password</label>
                <input id="rdp-input-pass" type="password" class="rdp-input-pass" placeholder="Password" autocomplete="current-password">
            </div>
            <div class="rdp-form-group rdp-form-checkbox">
                <label for="rdp-input-remember"><input id="rdp-input-remember" type="checkbox" class="rdp-input-remember" checked> Remember</label>
            </div>
            <div class="rdp-modal-buttons">
                <button class="rdp-btn rdp-btn-primary rdp-modal-connect">Connect</button>
                <button class="rdp-btn rdp-modal-cancel">Cancel</button>
            </div>
        </div>
    </div>
</div>
`;

// ============================================================
function getDefaultWsUrl() {
    try {
        if (typeof window !== 'undefined') {
            const params = new URLSearchParams(window.location?.search || '');
            const queryUrl = params.get('wsUrl') || params.get('ws');
            if (queryUrl && queryUrl.startsWith('/')) {
                const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                return `${proto}//${window.location.host}${queryUrl}`;
            }
            if (window.location?.host) {
                const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                return `${proto}//${window.location.host}/ws/`;
            }
        }
    } catch {}
    return 'ws://localhost:8765';
}

// RDP CLIENT CLASS
// ============================================================
export class RDPClient {
    /** @type {RDPSecurityPolicy} */
    #securityPolicy;
    
    /**
     * Create an RDP Client instance
     * @param {HTMLElement} container - Container element to attach to
     * @param {Object} options - Configuration options
     * @param {string} [options.wsUrl='ws://localhost:8765'] - WebSocket server URL
     * @param {boolean} [options.showTopBar=true] - Show top toolbar
     * @param {boolean} [options.showBottomBar=true] - Show bottom status bar
     * @param {number} [options.reconnectDelay=10000] - Reconnection delay in ms
     * @param {number} [options.reconnectMaxAttempts=3] - Max auto reconnect attempts
     * @param {boolean} [options.autoReconnect=false] - Auto reconnect on disconnect
     * @param {boolean} [options.keepConnectionModalOpen=false] - Keep connection modal open when disconnected (cannot be closed)
     * @param {boolean} [options.autoHideChrome=true] - Fold the floating HUD away while a session is in use
     * @param {number} [options.chromeHideDelayMs=2600] - Idle delay (ms) before the HUD folds away
     * @param {boolean} [options.keepChromeVisible=false] - Start with the HUD pinned open
     * @param {'top'|'right'|'bottom'|'left'} [options.hudDock='top'] - Edge the floating HUD docks to
     * @param {boolean} [options.loadingSpinnerOpensModal=true] - Whether clicking the loading area opens the connection modal
     * @param {number} [options.minWidth=0] - Minimum canvas width in pixels (0 = no minimum, scrollbar appears if container is smaller)
     * @param {number} [options.minHeight=0] - Minimum canvas height in pixels (0 = no minimum, scrollbar appears if container is smaller)
     * @param {number} [options.maxPixelRatio=2] - Cap on devicePixelRatio used to request a 1:1 physical-pixel session resolution (1 = CSS pixels only)
     * @param {import('./rdp-themes.js').RDPTheme} [options.theme] - Theme configuration
     * @param {import('./rdp-security.js').SecurityPolicy} [options.securityPolicy] - Security policy for connection restrictions
     * @param {Object} [options.visibleTopBarButtons] - Control visibility of top bar buttons
     * @param {boolean} [options.visibleTopBarButtons.connect=true] - Deprecated: the status icon is the connect affordance
     * @param {boolean} [options.visibleTopBarButtons.disconnect=true] - Show Disconnect button
     * @param {boolean} [options.visibleTopBarButtons.keyboard=true] - Show Keyboard button
     * @param {boolean} [options.visibleTopBarButtons.mute=true] - Show Mute button
     * @param {boolean} [options.visibleTopBarButtons.screenshot=false] - Show Screenshot button (hidden by default)
     * @param {boolean} [options.visibleTopBarButtons.clipboard=true] - Show Clipboard button
     * @param {boolean} [options.visibleTopBarButtons.fullscreen=true] - Show Fullscreen button
     * @param {Array<{name: string, click: function}>} [options.additionalTopBarButtons=[]] - Custom buttons (max 10) added before built-in controls. Buttons collapse into overflow menu when space is limited.
     */
    constructor(container, options = {}) {
        // Extract security policy before spreading options (we don't store it in this.options)
        const { securityPolicy, additionalTopBarButtons, visibleTopBarButtons, ...restOptions } = options;
        
        this.options = {
            wsUrl: getDefaultWsUrl(),
            showTopBar: true,
            showBottomBar: true,
            mouseThrottleMs: 16,
            resizeDebounceMs: 250,   // Short debounce: window drags settle quickly; fullscreen sends almost immediately
            maxPixelRatio: 2,   // Cap on devicePixelRatio used for 1:1 physical-pixel resolution (keeps 4K/retina frames sane)
            keepConnectionModalOpen: false,
            loadingSpinnerOpensModal: true,
            autoHideChrome: true,          // Fold the HUD away while a live session is in use
            chromeHideDelayMs: 2600,       // Idle delay before the floating HUD hides
            keepChromeVisible: false,      // Start with the HUD pinned open
            hudDock: 'top',                // HUD edge: 'top' | 'right' | 'bottom' | 'left'
            minWidth: 0,    // Minimum canvas width (0 = no minimum, scrollbar appears if container is smaller)
            minHeight: 0,   // Minimum canvas height (0 = no minimum, scrollbar appears if container is smaller)
            theme: null,
            themeMode: null,               // 'dark' | 'light' | 'auto' (defaults to the theme preset)
            visibleTopBarButtons: {
                connect: true,
                disconnect: true,
                reconnect: true,
                keyboard: true,
                mute: true,
                screenshot: false,   // hidden by default; screenshots are available via the API
                clipboard: true,
                fullscreen: true,
                ...visibleTopBarButtons
            },
            autoReconnect: false,
            reconnectDelay: 10000,
            reconnectMaxAttempts: 3,
            ...restOptions
        };
        
        // Validate and freeze additional top bar buttons (max 10)
        // Deep copy to prevent external mutation, callbacks stored separately
        this._additionalButtonConfigs = this._validateAdditionalButtons(additionalTopBarButtons || []);
        
        // Initialize security policy as private frozen field
        // Deep frozen by default to prevent tampering
        this.#securityPolicy = new RDPSecurityPolicy(securityPolicy || {}, true);

        this._container = container;
        this._initShadowDOM();
        // Resolve an auto theme mode before first paint so the page never
        // flashes the wrong palette.
        if (this.options.themeMode === 'auto') {
            const mode = this._prefersLight() ? 'light' : 'dark';
            this.options.theme = { ...(this.options.theme || {}), preset: mode, mode };
        } else if (this.options.themeMode === 'light' || this.options.themeMode === 'dark') {
            this.options.theme = { ...(this.options.theme || {}), preset: this.options.themeMode, mode: this.options.themeMode };
        }
        this._applyTheme(this.options.theme);
        this._applyMinDimensions();  // Apply min dimension CSS vars
        this._initState();
        this._bindElements();
        // Re-apply so the theme mode reaches the container/button that only
        // exist after _bindElements (the first _applyTheme had no DOM refs).
        this._applyTheme(this.options.theme || { preset: 'dark' });
        this._initResponsiveToolbar();  // Setup responsive overflow handling
        this._setupEventListeners();
        this._restoreRememberedConnection();
        this._setupFullscreenAutohide();
        this._setupChromeAutohide();
        
        // Auto-show modal on init when keepConnectionModalOpen is enabled
        if (this.options.keepConnectionModalOpen) {
            this._showModal();
        }
        
        console.log('[RDPClient] Initialized');
    }

    // --------------------------------------------------
    // INITIALIZATION
    // --------------------------------------------------
    
    _initShadowDOM() {
        this._shadow = this._container.attachShadow({ mode: 'open' });
        
        // Main styles
        const style = document.createElement('style');
        style.textContent = STYLES;
        style.id = 'rdp-main-styles';
        
        // Theme overrides (separate style element for easy updates)
        this._themeStyle = document.createElement('style');
        this._themeStyle.id = 'rdp-theme-styles';
        
        const template = document.createElement('template');
        template.innerHTML = TEMPLATE;
        
        this._shadow.appendChild(style);
        this._shadow.appendChild(this._themeStyle);
        this._shadow.appendChild(template.content.cloneNode(true));
        
        // Apply visibility options
        if (!this.options.showTopBar) {
            this._shadow.querySelector('.rdp-topbar').classList.add('hidden');
        }
        if (!this.options.showBottomBar) {
            this._shadow.querySelector('.rdp-bottombar').classList.add('hidden');
        }
        // An entirely empty HUD (both rows hidden) should not float over the screen.
        if (!this.options.showTopBar && !this.options.showBottomBar) {
            this._shadow.querySelector('.rdp-hud').classList.add('hidden');
            this._shadow.querySelector('.rdp-hud-handle').classList.add('hidden');
        }
    }
    
    /**
     * Apply theme configuration
     * Can be called after initialization to change theme dynamically
     * @param {import('./rdp-themes.js').RDPTheme} themeConfig - Theme configuration
     */
    _applyTheme(themeConfig) {
        if (!themeConfig) return;
        
        // Sanitize and resolve theme
        const sanitized = sanitizeTheme(themeConfig);
        const resolved = resolveTheme(sanitized);
        const cssVars = themeToCssVars(resolved);
        
        // Generate font imports CSS
        const fontCss = fontsToCss(sanitized.fonts);
        
        // Apply as :host styles with optional font imports
        this._themeStyle.textContent = `${fontCss}\n:host { ${cssVars}; }`;

        // Track the resolved mode so the theme toggle can swap icons and the
        // stylesheet can apply light-specific corrections.
        const mode = resolved.mode || 'dark';
        this._themeMode = mode;
        const container = this._el?.container;
        if (container) container.dataset.themeMode = mode;
        const btn = this._el?.btnTheme;
        if (btn) {
            const next = mode === 'light' ? 'dark' : 'light';
            btn.title = `Switch to ${next} theme`;
            btn.setAttribute('aria-label', btn.title);
            btn.setAttribute('aria-pressed', String(mode === 'light'));
        }
    }
    
    /**
     * Set theme dynamically after initialization
     * @param {import('./rdp-themes.js').RDPTheme} themeConfig - Theme configuration
     * @example
     * client.setTheme({ preset: 'light' });
     * client.setTheme({ colors: { accent: '#ff5722' } });
     */
    setTheme(themeConfig) {
        this.options.theme = themeConfig;
        this._applyTheme(themeConfig);
    }

    /** @public @returns {'dark'|'light'} The theme mode currently in effect. */
    getThemeMode() {
        return this._themeMode || 'dark';
    }

    /**
     * Switch between the light and dark presets.
     *
     * Only the mode is changed: any explicit colour overrides in the original
     * theme config are preserved, so a brand accent survives a mode switch.
     *
     * @public
     * @param {'dark'|'light'|'auto'} mode - 'auto' follows prefers-color-scheme
     * @returns {'dark'|'light'} The resolved mode
     */
    setThemeMode(mode) {
        let target = mode;
        if (target === 'auto' || target == null) target = this._prefersLight() ? 'light' : 'dark';
        if (target !== 'light' && target !== 'dark') target = 'dark';

        const base = this.options.theme || {};
        // Keep user colour/typography/shape overrides, swap only the preset.
        const next = { ...base, preset: target, mode: target };
        this.options.theme = next;
        this.options.themeMode = mode === 'auto' ? 'auto' : target;
        this._applyTheme(next);
        return target;
    }

    /** @public Toggle light/dark and return the new mode. */
    toggleThemeMode() {
        return this.setThemeMode(this.getThemeMode() === 'light' ? 'dark' : 'light');
    }

    /** True when the OS asks for a light colour scheme. */
    _prefersLight() {
        try {
            return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
        } catch { return false; }
    }
    
    /**
     * Apply minimum dimension constraints
     * Sets CSS custom properties to control canvas min size and scrollbar visibility
     */
    _applyMinDimensions() {
        const { minWidth, minHeight } = this.options;
        const host = this._shadow.host;
        
        // Set canvas minimum dimensions (0 means no constraint)
        host.style.setProperty('--rdp-canvas-min-width', minWidth > 0 ? `${minWidth}px` : '0');
        host.style.setProperty('--rdp-canvas-min-height', minHeight > 0 ? `${minHeight}px` : '0');
        host.style.setProperty('--rdp-screen-min-width', minWidth > 0 ? `${minWidth + 4}px` : '0');  // +4 for border
        
        // Enable scrollbars only when min dimensions are set
        host.style.setProperty('--rdp-overflow-x', minWidth > 0 ? 'auto' : 'hidden');
        host.style.setProperty('--rdp-overflow-y', minHeight > 0 ? 'auto' : 'hidden');
    }
    
    /**
     * Set minimum dimensions dynamically
     * @param {number} minWidth - Minimum canvas width in pixels (0 = no minimum)
     * @param {number} minHeight - Minimum canvas height in pixels (0 = no minimum)
     */
    setMinDimensions(minWidth, minHeight) {
        this.options.minWidth = minWidth || 0;
        this.options.minHeight = minHeight || 0;
        this._applyMinDimensions();
    }

    _initState() {
        this._transport = null;
        this._isConnected = false;
        this._canvas = null;
        this._ctx = null;
        this._lastMouseSend = 0;
        this._lastLatency = null;
        this._mediaPath = 'ws';
        this._rtc = null;
        this._latSamples = [];
        this._pingTimer = null;
        this._rtcLink = { candidateType: null, rttMs: null, jitterMs: null, lossPct: null };
        this._rtcFailCount = 0;
        this._rtcGiveUp = false;
        this._rtcMaxRetries = 3;
        this._wsQuality = { sent: 0, lost: 0, jitterMs: null, lossPct: null, lastRtt: null, window: [] };
        this._pingSeq = 0;
        this._pingPending = new Map();
        this._rttTimes = [];
        this._rttValues = [];
        this._rtcRttTimes = [];
        this._rtcRttValues = [];
        this._rtcRttTimes = [];
        this._rtcRttValues = [];
        this._pingIntervalMs = this.options.pingIntervalMs || 2000;
        this._pingTimeoutMs = this.options.pingTimeoutMs || 3000;
        const queryMode = getTransportModeFromQuery();
        const initRouteRaw = this.options.routeMode || this.options.transportMode || queryMode || this.options.transport || 'auto';
        const initRoute = (initRouteRaw === 'p2p' || initRouteRaw === 'turn') ? 'rtc' : initRouteRaw;
        this._routeMode = ['auto', 'ws', 'rtc'].includes(initRoute) ? initRoute : 'auto';
        this._transportMode = this._routeMode === 'ws' ? 'ws' : this._routeMode === 'auto' ? 'auto' : 'rtc';
        const queryStun = getStunUrlsFromQuery();
        this._stunUrls = expandStunServers(this.options.stunUrls || queryStun);
        const queryTurn = getTurnFromQuery();
        this._turnUrls = this.options.turnUrls || queryTurn?.urls || [];
        this._turnUsername = this.options.turnUsername || queryTurn?.username || '';
        this._turnCredential = this.options.turnCredential || queryTurn?.credential || '';
        this._iceServers = expandIceServers({
            stunUrls: this._stunUrls,
            turnUrls: this._turnUrls,
            turnUsername: this._turnUsername,
            turnCredential: this._turnCredential,
        });
        this._iceServersReady = null;
        this._pendingRtc = null;
        this._standbyRtc = null;
        this._rtcDialing = null;
        this._routeStats = {
            ws: { rttMs: null, lossPct: null, jitterMs: null, score: null, updatedAt: 0 },
            rtc: { rttMs: null, lossPct: null, jitterMs: null, score: null, updatedAt: 0 },
        };
        this._routeTimer = null;
        this._routeIntervalMs = this.options.routeIntervalMs || 30000;
        this._keepaliveMs = this.options.keepaliveMs || 20000;
        this._lastAutoSwitchAt = 0;
        this._autoCooldownMs = this.options.autoCooldownMs || 15000;
        this._autoWarmupMs = this.options.autoWarmupMs || 8000;
        this._connectedAt = 0;
        this._lastFrameGapAt = 0;
        this._frameGapCount = 0;
        this._lastRefreshAt = 0;
        this._graceMs = this.options.rtcGraceMs || 4000;
        this._graceTimer = null;
        this._resizeTimeout = null;
        this._lastRequestedWidth = 0;
        this._lastRequestedHeight = 0;
        
        // Audio state - AudioWorklet low-latency system
        this._audioContext = null;
        this._audioGainNode = null;
        this._audioWorklet = null;           // AudioWorkletNode
        this._audioWorkletReady = false;
        this._audioWorkletWarned = false;    // Only warn once if worklet not ready
        this._audioSharedBuffer = null;      // SharedArrayBuffer for ring buffer
        this._audioControlView = null;       // Uint32Array for write index
        this._audioDataView = null;          // Float32Array for audio samples
        this._audioWriteIndex = 0;
        this._audioBufferSize = 24000;       // ~500ms at 48kHz (samples per channel)
        this._audioChannels = 2;
        this._isMuted = false;
        
        // Opus decoder (WebCodecs)
        this._opusDecoder = null;
        this._opusInitialized = false;
        this._opusSampleRate = 48000;
        this._opusChannels = 2;
        
        // GFX Worker for progressive/tile rendering
        this._gfxWorker = null;
        this._gfxWorkerReady = false;
        this._useOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';
        this._pendingGfxMessages = [];
        this._wasmAvailable = false;  // Set by GFX worker on load
        
        // Screenshot pending requests
        this._screenshotRequests = new Map();
        this._screenshotRequestId = 0;
        
        // API cursor state (for programmatic mouse control)
        this._apiCursorVisible = false;
        this._apiCursorPos = { x: 0, y: 0 };
        
        // Virtual keyboard state
        this._keyboardVisible = false;
        this._keyboardModifiers = { ctrl: false, alt: false, shift: false, meta: false, altgr: false };
        this._keyboardDragging = false;
        this._keyboardResizing = false;
        this._keyboardDragOffset = { x: 0, y: 0 };
        this._keyboardBaseWidth = 0;    // Natural width of keyboard content
        this._keyboardBaseHeight = 0;   // Natural height of keyboard content (rows only)
        this._keyboardTitlebarHeight = 0; // Height of titlebar (not scaled)
        this._keyboardActiveKey = null;  // Currently pressed key element
        
        // Event callbacks
        this._eventHandlers = {};
        
        // Disconnect state
        this._pendingDisconnect = null;
        this._disconnectTimeout = null;
        this._autoReconnect = !!this.options.autoReconnect;
        this._reconnectTimer = null;
        this._reconnectAttempts = 0;
        this._manualDisconnect = false;
        this._lastCredentials = null;
        this._lastError = null;
        this._connectFailed = false;
        this._composing = false;
        this._toastTimer = null;

        // Physical keys currently held down on the remote, keyed by KeyboardEvent.code.
        // Used to guarantee a matching key-up is always delivered (see _releaseAllKeys).
        this._pressedKeys = new Map();

        // Floating chrome auto-hide state (see _setupChromeAutohide).
        this._chromeHidden = false;
        this._chromePinned = false;
        this._chromeHideTimer = null;
        this._dockPopOpen = false;
        this._hudDock = 'top';
        this._releaseAllKeysHandler = () => this._releaseAllKeys();
    }

    _bindElements() {
        const $ = sel => this._shadow.querySelector(sel);
        
        this._el = {
            container: $('.rdp-container'),
            hud: $('.rdp-hud'),
            hudHandle: $('.rdp-hud-handle'),
            btnPin: $('.rdp-btn-pin'),
            btnDock: $('.rdp-btn-dock'),
            dockPop: $('.rdp-dock-pop'),
            topbar: $('.rdp-topbar'),
            bottombar: $('.rdp-bottombar'),
            screen: $('.rdp-screen'),
            canvas: $('.rdp-canvas'),
            toast: $('.rdp-toast'),
            loading: $('.rdp-loading'),
            ime: $('.rdp-ime'),
            statusDot: $('.rdp-status-icon'),
            status: $('.rdp-status'),
            statusText: $('.rdp-status-text'),
            btnDisconnect: $('.rdp-btn-disconnect'),
            btnTheme: $('.rdp-btn-theme'),
            btnReconnect: $('.rdp-btn-reconnect'),
            btnMute: $('.rdp-btn-mute'),
            btnScreenshot: $('.rdp-btn-screenshot'),
            btnClipboard: $('.rdp-btn-clipboard'),
            btnFullscreen: $('.rdp-btn-fullscreen'),
            modal: $('.rdp-modal'),
            modalConnect: $('.rdp-modal-connect'),
            modalCancel: $('.rdp-modal-cancel'),
            modalError: $('.rdp-modal-error'),
            inputHost: $('.rdp-input-host'),
            inputPort: $('.rdp-input-port'),
            inputUser: $('.rdp-input-user'),
            inputPass: $('.rdp-input-pass'),
            inputRemember: $('.rdp-input-remember'),
            latency: $('.rdp-latency'),
            transport: $('.rdp-transport'),
            transportText: $('.rdp-transport-text'),
            routePop: $('.rdp-route-pop'),
            // Virtual keyboard elements
            btnKeyboard: $('.rdp-btn-keyboard'),
            keyboardOverlay: $('.rdp-keyboard-overlay'),
            keyboardContent: $('.rdp-keyboard-content'),
            keyboardTitlebar: $('.rdp-keyboard-titlebar'),
            keyboardClose: $('.rdp-keyboard-close'),
            keyboardResize: $('.rdp-keyboard-resize'),
            // Overflow menu elements
            controls: $('.rdp-controls'),
            btnOverflow: $('.rdp-btn-overflow'),
            overflowDropdown: $('.rdp-overflow-dropdown'),
            // API cursor overlay
            apiCursor: $('.rdp-api-cursor'),
        };
        
        // Apply button visibility based on visibleTopBarButtons option
        const btns = this.options.visibleTopBarButtons;
        if (!btns.disconnect) this._el.btnDisconnect.style.display = 'none';
        if (!btns.reconnect && this._el.btnReconnect) this._el.btnReconnect.style.display = 'none';
        if (!btns.keyboard) this._el.btnKeyboard.style.display = 'none';
        if (!btns.mute) this._el.btnMute.style.display = 'none';
        if (!btns.screenshot) this._el.btnScreenshot.style.display = 'none';
        if (!btns.clipboard) this._el.btnClipboard.style.display = 'none';
        if (!btns.fullscreen) this._el.btnFullscreen.style.display = 'none';
        
        // Create additional custom buttons at the start of controls
        this._createAdditionalButtons();

        // Reflect the initial mute state in the SVG icon + aria-pressed.
        this._updateMuteIcon();
        
        this._canvas = this._el.canvas;
        
        // Initialize GFX worker - OffscreenCanvas is required
        this._initGfxWorker();
    }
    
    /**
     * Validate and sanitize additional button configurations
     * @param {Array} buttons - Raw button config array
     * @returns {Array} Validated and frozen button configs with callbacks stored separately
     * @private
     */
    _validateAdditionalButtons(buttons) {
        if (!Array.isArray(buttons)) {
            console.warn('[RDPClient] additionalTopBarButtons must be an array, ignoring');
            return [];
        }
        
        const MAX_BUTTONS = 10;
        const validated = [];
        
        for (let i = 0; i < Math.min(buttons.length, MAX_BUTTONS); i++) {
            const btn = buttons[i];
            
            // Validate required properties
            if (!btn || typeof btn !== 'object') {
                console.warn(`[RDPClient] additionalTopBarButtons[${i}] is not an object, skipping`);
                continue;
            }
            
            if (typeof btn.name !== 'string' || btn.name.trim() === '') {
                console.warn(`[RDPClient] additionalTopBarButtons[${i}].name must be a non-empty string, skipping`);
                continue;
            }
            
            if (typeof btn.click !== 'function') {
                console.warn(`[RDPClient] additionalTopBarButtons[${i}].click must be a function, skipping`);
                continue;
            }
            
            // Truncate name to 30 characters max
            const MAX_NAME_LENGTH = 30;
            let displayName = btn.name.trim();
            const fullName = displayName;  // Store original for title attribute
            
            if (displayName.length > MAX_NAME_LENGTH) {
                displayName = displayName.substring(0, MAX_NAME_LENGTH) + '...';
                console.warn(`[RDPClient] additionalTopBarButtons[${i}].name exceeded ${MAX_NAME_LENGTH} characters, truncated to "${displayName}"`);
            }
            
            // Store config with callback reference (callbacks can't be frozen/cloned)
            validated.push({
                name: displayName,
                fullName: fullName,  // Original name for title tooltip
                callback: btn.click  // Store original function reference
            });
        }
        
        if (buttons.length > MAX_BUTTONS) {
            console.warn(`[RDPClient] additionalTopBarButtons limited to ${MAX_BUTTONS} buttons, ignoring extras`);
        }
        
        return validated;
    }
    
    /**
     * Create additional custom buttons in the top bar controls
     * Buttons are inserted at the beginning of .rdp-controls
     * Click handlers are isolated to prevent access to RDPClient internals
     * Buttons get collapse priority based on their index (lower = collapses first)
     * @private
     */
    _createAdditionalButtons() {
        if (!this._additionalButtonConfigs || this._additionalButtonConfigs.length === 0) {
            return;
        }
        
        const controlsContainer = this._shadow.querySelector('.rdp-controls');
        if (!controlsContainer) {
            console.warn('[RDPClient] Could not find .rdp-controls container');
            return;
        }
        
        // Create buttons in reverse order so they appear in original order when prepended
        const fragment = document.createDocumentFragment();
        
        // Priority starts at 10 for additional buttons (lower than built-in connect/disconnect)
        // First additional button collapses first (priority 10), then 11, etc.
        let priorityCounter = 10;
        
        for (const config of this._additionalButtonConfigs) {
            const btn = document.createElement('button');
            btn.className = 'rdp-btn rdp-btn-no-wrap';
            btn.textContent = config.name;
            btn.title = config.fullName;  // Use full name for tooltip
            btn.dataset.collapsePriority = String(priorityCounter++);
            
            // Isolate callback - call with null context and catch errors
            // This prevents the user's callback from accessing 'this' (RDPClient)
            const userCallback = config.callback;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                try {
                    // Call with null context, pass only button name for identification (use fullName)
                    userCallback.call(null, { buttonName: config.fullName });
                } catch (err) {
                    console.error('[RDPClient] Additional button callback error:', err);
                }
            });
            
            fragment.appendChild(btn);
        }
        
        // Insert all buttons at the start of controls
        controlsContainer.prepend(fragment);
    }
    
    /**
     * Initialize responsive toolbar with overflow handling
     * Sets up ResizeObserver to detect when buttons need to collapse into dropdown
     * @private
     */
    _initResponsiveToolbar() {
        // Track collapsed state
        this._collapsedButtons = new Set();
        this._overflowMenuOpen = false;
        
        // Get all collapsible buttons (those with data-collapse-priority that's not "never")
        this._updateCollapsibleButtons();
        
        // Set up overflow button click handler
        this._el.btnOverflow.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleOverflowMenu();
        });
        
        // Close overflow menu when clicking outside
        this._shadow.addEventListener('click', (e) => {
            if (this._overflowMenuOpen && !e.target.closest('.rdp-overflow-container')) {
                this._closeOverflowMenu();
            }
        });

        // Keyboard: Esc closes the menu, arrows move between items.
        this._shadow.addEventListener('keydown', (e) => {
            if (!this._overflowMenuOpen) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                this._closeOverflowMenu();
                this._el.btnOverflow?.focus();
                return;
            }
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            const items = Array.from(
                this._el.overflowDropdown.querySelectorAll('.rdp-btn:not(:disabled)')
            );
            if (!items.length) return;
            e.preventDefault();
            const idx = items.indexOf(this._shadow.activeElement);
            const next = e.key === 'ArrowDown'
                ? (idx + 1) % items.length
                : (idx <= 0 ? items.length - 1 : idx - 1);
            items[next].focus();
        });

        // Move focus into the menu as soon as it opens so it is usable by keyboard.
        this._el.btnOverflow?.addEventListener('click', () => {
            if (!this._overflowMenuOpen) return;
            requestAnimationFrame(() => {
                this._el.overflowDropdown
                    .querySelector('.rdp-btn:not(:disabled)')
                    ?.focus();
            });
        });
        
        // Set up ResizeObserver on the topbar
        const topbar = this._shadow.querySelector('.rdp-topbar');
        if (topbar && typeof ResizeObserver !== 'undefined') {
            this._toolbarResizeObserver = new ResizeObserver(() => {
                this._updateToolbarOverflow();
            });
            this._toolbarResizeObserver.observe(topbar);
            
            // Initial check
            requestAnimationFrame(() => this._updateToolbarOverflow());
        }
    }
    
    /**
     * Update the list of collapsible buttons based on data-collapse-priority
     * Should be called after adding/removing buttons
     * @private
     */
    _updateCollapsibleButtons() {
        const controls = this._el.controls;
        if (!controls) return;
        
        // Get all buttons with collapse priority (not "never")
        this._collapsibleButtons = Array.from(
            controls.querySelectorAll('.rdp-btn[data-collapse-priority]')
        ).filter(btn => btn.dataset.collapsePriority !== 'never')
         .sort((a, b) => {
             // Higher priority number = collapses first
             const priorityA = parseInt(a.dataset.collapsePriority, 10) || 0;
             const priorityB = parseInt(b.dataset.collapsePriority, 10) || 0;
             return priorityB - priorityA;  // Descending order (highest first to collapse)
         });
    }
    
    /**
     * Collapse lower-priority buttons into the overflow menu when the HUD would
     * not fit. The panel is content-sized, so the budget comes from the
     * container. When docked left/right the rails run vertically, so the
     * measuring axis flips from width to height.
     * @private
     */
    _updateToolbarOverflow() {
        const controls = this._el.controls;
        const topbar = this._el.topbar;
        const hud = this._el.hud;
        if (!controls || !topbar || !hud) return;

        const vertical = this._isHudVertical();
        const container = this._el.container;
        const status = this._shadow.querySelector('.rdp-status');

        // Budget along the stacking axis, minus panel padding, the status block
        // and the gap that separates it from the controls.
        const panelPadding = 16;
        const gap = vertical ? 8 : 12;
        const statusSize = status
            ? (vertical ? status.offsetHeight : status.offsetWidth)
            : 0;
        const containerSize = vertical ? container.clientHeight : container.clientWidth;
        const available = Math.max(0, (containerSize || 0) - (2 * panelPadding) - statusSize - gap - panelPadding);

        // Temporarily show all buttons to measure
        const wasCollapsed = new Set(this._collapsedButtons);
        for (const btn of wasCollapsed) {
            btn.classList.remove('rdp-collapsed');
        }
        this._el.btnOverflow.classList.remove('visible');

        if (this._measureVisibleControlsSize() <= available) {
            this._collapsedButtons.clear();
            this._syncOverflowDropdown();
            return;
        }

        // Need to collapse buttons - start with highest priority (first to collapse)
        this._collapsedButtons.clear();
        const overflowBtnSize = this._el.btnOverflow?.offsetHeight
            || this._el.btnOverflow?.offsetWidth
            || 34;

        for (const btn of this._collapsibleButtons) {
            if (btn.style.display === 'none') continue;

            const current = this._measureVisibleControlsSize();
            if (current + (this._collapsedButtons.size > 0 ? overflowBtnSize : 0) <= available) {
                break;
            }

            btn.classList.add('rdp-collapsed');
            this._collapsedButtons.add(btn);
        }

        // Show overflow button if we have collapsed buttons
        this._syncOverflowDropdown();
    }

    /** True when the HUD is docked to a vertical edge (left/right). */
    _isHudVertical() {
        const dock = this._hudDock || 'top';
        return dock === 'left' || dock === 'right';
    }

    /**
     * Measure the size of visible (non-collapsed) controls along the stacking
     * axis: width for a horizontal HUD, height for a vertical one.
     * @returns {number} Pixels
     * @private
     */
    _measureVisibleControlsSize() {
        const controls = this._el.controls;
        if (!controls) return 0;
        const vertical = this._isHudVertical();
        let size = 0;
        const gap = vertical ? 8 : 6;
        let visibleCount = 0;

        for (const child of controls.children) {
            if (child.classList.contains('rdp-overflow-container')) continue;
            if (child.classList.contains('rdp-collapsed')) continue;
            if (child.style.display === 'none') continue;

            size += vertical ? child.offsetHeight : child.offsetWidth;
            visibleCount++;
        }

        if (visibleCount > 1) size += (visibleCount - 1) * gap;
        return size;
    }
    
    /**
     * Sync the overflow dropdown with collapsed buttons
     * @private
     */
    _syncOverflowDropdown() {
        const dropdown = this._el.overflowDropdown;
        if (!dropdown) return;
        
        // Clear dropdown
        dropdown.innerHTML = '';
        
        if (this._collapsedButtons.size === 0) {
            this._el.btnOverflow.classList.remove('visible');
            this._closeOverflowMenu();
            return;
        }
        
        // Show overflow button
        this._el.btnOverflow.classList.add('visible');
        
        // Add collapsed buttons to dropdown (in reverse order so first collapsed appears last)
        const sortedButtons = Array.from(this._collapsedButtons).reverse();
        
        for (const originalBtn of sortedButtons) {
            const dropdownBtn = document.createElement('button');
            dropdownBtn.className = 'rdp-btn rdp-btn-menu-item';
            // Icon-only buttons have no text, so fall back to their label/title.
            const label = originalBtn.getAttribute('aria-label') || originalBtn.title || originalBtn.textContent.trim();
            const icon = originalBtn.querySelector('svg');
            if (icon) {
                const clone = icon.cloneNode(true);
                clone.setAttribute('aria-hidden', 'true');
                dropdownBtn.appendChild(clone);
            }
            const textSpan = document.createElement('span');
            textSpan.textContent = label;
            dropdownBtn.appendChild(textSpan);
            dropdownBtn.title = originalBtn.title || label;
            dropdownBtn.disabled = originalBtn.disabled;
            dropdownBtn.setAttribute('role', 'menuitem');

            // Clone click behavior
            dropdownBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._closeOverflowMenu();
                originalBtn.click();
            });

            dropdown.appendChild(dropdownBtn);
        }
    }
    
    /**
     * Toggle the overflow dropdown menu
     * @private
     */
    _toggleOverflowMenu() {
        if (this._overflowMenuOpen) {
            this._closeOverflowMenu();
        } else {
            this._openOverflowMenu();
        }
    }
    
    /**
     * Open the overflow dropdown menu
     * @private
     */
    _openOverflowMenu() {
        this._el.overflowDropdown.classList.add('open');
        this._overflowMenuOpen = true;
        this._el.btnOverflow?.setAttribute('aria-expanded', 'true');
        this._showChrome(false);   // pin the toolbar while the menu is open
    }

    /**
     * Close the overflow dropdown menu
     * @private
     */
    _closeOverflowMenu() {
        this._el.overflowDropdown.classList.remove('open');
        this._overflowMenuOpen = false;
        this._el.btnOverflow?.setAttribute('aria-expanded', 'false');
        this._scheduleChromeHide();
    }
    
    /**
     * Initialize the GFX compositor worker
     * OffscreenCanvas is REQUIRED - will fail if not supported
     */
    _initGfxWorker() {
        if (!this._useOffscreenCanvas) {
            const msg = 'OffscreenCanvas is required but not supported by this browser';
            console.error('[RDPClient]', msg);
            this._handleError(msg);
            return;
        }
        
        try {
            this._gfxWorker = new Worker(RDP_CLIENT_BASE_URL + 'gfx-worker.js', { type: 'module' });
            
            this._gfxWorker.onmessage = (event) => {
                this._handleGfxWorkerMessage(event.data);
            };
            
            this._gfxWorker.onerror = (err) => {
                console.error('[RDPClient] GFX Worker error:', err);
                this._gfxWorker = null;
                this._gfxWorkerReady = false;
                this._handleError('GFX Worker failed to initialize');
            };
            
            console.log('[RDPClient] GFX Worker created');
        } catch (err) {
            console.error('[RDPClient] Failed to create GFX Worker:', err);
            this._gfxWorker = null;
            this._handleError('Failed to create GFX Worker: ' + err.message);
        }
    }
    
    /**
     * Handle messages from GFX worker
     */
    _handleGfxWorkerMessage(msg) {
        switch (msg.type) {
            case 'loaded':
                // Worker loaded with WASM pre-initialized
                this._wasmAvailable = !!msg.wasmReady;
                console.log('[RDPClient] GFX Worker loaded, WASM:', this._wasmAvailable);
                if (!this._wasmAvailable) {
                    console.warn('[RDPClient] Progressive WASM not available - will use fallback decoders');
                }
                break;
                
            case 'ready':
                this._gfxWorkerReady = true;
                console.log('[RDPClient] GFX Worker ready, WASM:', msg.wasmReady);
                // Flush pending messages
                for (const pending of this._pendingGfxMessages) {
                    this._gfxWorker.postMessage(pending.msg, pending.transfer);
                }
                this._pendingGfxMessages = [];
                break;
                
                case 'frameAck':
                    // Send frame acknowledgment back to server (RTC control DC preferred)
                    if (msg.data) {
                        this._sendBinary(msg.data);
                    }
                    break;

                case 'frameGap':
                    // A frame was started but never completed -> real loss. A single
                    // isolated drop doesn't need a full keyframe refresh (the next
                    // delta usually repairs it); only a burst does. Record the time
                    // so the path-switch heuristic still sees recent loss.
                    this._lastFrameGapAt = Date.now();
                    this._frameGapCount = (this._frameGapCount || 0) + 1;
                    console.warn(`[RDPClient] Frame gap detected (${msg.expected} -> ${msg.got})`);
                    break;
                
            case 'unhandled':
                // Unhandled message from worker - process on main thread
                if (msg.data) {
                    this._handleFrameUpdate(msg.data);
                }
                break;
                
            case 'screenshotResult':
                // Resolve pending screenshot request
                const pending = this._screenshotRequests.get(msg.requestId);
                if (pending) {
                    this._screenshotRequests.delete(msg.requestId);
                    if (msg.error) {
                        pending.reject(new Error(msg.error));
                    } else {
                        pending.resolve({
                            blob: msg.blob,
                            width: msg.width,
                            height: msg.height
                        });
                    }
                }
                break;
        }
    }
    
    /**
     * Set a custom cursor from server-provided BGRA bitmap data
     * Uses CSS cursor with data URL for cursors up to 128x128 (browser limit)
     * @param {number} width - Cursor width in pixels
     * @param {number} height - Cursor height in pixels
     * @param {number} hotspotX - Hotspot X offset
     * @param {number} hotspotY - Hotspot Y offset
     * @param {Uint8Array} bgraData - BGRA pixel data (4 bytes per pixel)
     */
    _setCustomCursor(width, height, hotspotX, hotspotY, bgraData) {
        try {
            // Create temporary canvas to convert BGRA to image
            const cursorCanvas = document.createElement('canvas');
            cursorCanvas.width = width;
            cursorCanvas.height = height;
            const ctx = cursorCanvas.getContext('2d');
            
            // Create ImageData and convert BGRA to RGBA
            const imageData = ctx.createImageData(width, height);
            const rgba = imageData.data;
            
            for (let i = 0; i < bgraData.length; i += 4) {
                // BGRA -> RGBA: swap B and R channels
                rgba[i]     = bgraData[i + 2];  // R <- B
                rgba[i + 1] = bgraData[i + 1];  // G <- G
                rgba[i + 2] = bgraData[i];      // B <- R
                rgba[i + 3] = bgraData[i + 3];  // A <- A
            }
            
            ctx.putImageData(imageData, 0, 0);
            
            // Convert to data URL for CSS cursor
            const dataUrl = cursorCanvas.toDataURL('image/png');
            
            // Clamp hotspot to valid range
            const hx = Math.max(0, Math.min(hotspotX, width - 1));
            const hy = Math.max(0, Math.min(hotspotY, height - 1));
            
            // CSS cursor format: url(data:...), hotspot-x, hotspot-y, fallback
            // Note: Some browsers limit cursor size to 128x128
            this._canvas.style.cursor = `url(${dataUrl}) ${hx} ${hy}, auto`;
        } catch (err) {
            console.warn('[RDPClient] Failed to set custom cursor:', err);
            this._canvas.style.cursor = 'default';
        }
    }
    
    /**
     * Initialize GFX worker canvas when connected
     */
    _initGfxWorkerCanvas(width, height) {
        if (!this._gfxWorker || !this._useOffscreenCanvas) {
            this._handleError('GFX Worker not available');
            this.disconnect();
            return;
        }
        
        try {
            // Transfer canvas control to worker
            const offscreen = this._canvas.transferControlToOffscreen();
            
            this._gfxWorker.postMessage({
                type: 'init',
                data: { canvas: offscreen, width, height }
            }, [offscreen]);
            
            console.log('[RDPClient] Canvas transferred to GFX Worker');
        } catch (err) {
            console.error('[RDPClient] Failed to transfer canvas:', err);
            this._handleError('Failed to transfer canvas to worker: ' + err.message);
            this.disconnect();
        }
    }
    
    /**
     * Send message to GFX worker
     */
    _sendToGfxWorker(data) {
        if (!this._gfxWorker) return false;
        
        const msg = { type: 'binary', data };
        const transfer = data instanceof ArrayBuffer ? [data] : [];
        
        if (this._gfxWorkerReady) {
            this._gfxWorker.postMessage(msg, transfer);
        } else {
            this._pendingGfxMessages.push({ msg, transfer });
        }
        
        return true;
    }

    /**
     * Tell the worker to forget its frame-ID continuity baseline. Called on a
     * media-path switch: the new path can restart/skip frame IDs, which the
     * worker would otherwise report as a false "frame gap" (丢帧).
     */
    _resetWorkerFrameTracking() {
        if (!this._gfxWorker || !this._gfxWorkerReady) return;
        this._gfxWorker.postMessage({ type: 'resetFrameTracking' });
        // Baseline is gone, so any recent gap memory is stale too.
        this._lastFrameGapAt = 0;
    }

    _forceRefresh(reason) {
        if (!this._gfxWorker || !this._gfxWorkerReady) return;
        this._pendingGfxMessages = [];
        this._gfxWorker.postMessage({ type: 'refresh' });
        try { this._sendMessage({ type: 'refresh' }); } catch {}
        this._lastRefreshAt = Date.now();
        if (reason) console.log(`[RDPClient] Forced screen refresh (${reason})`);
    }

    /**
     * Decide whether a media-path switch needs a repaint. Only true when we
     * actually lost frames: a recent decoder gap, or the currently-active link
     * was showing real packet loss. A clean handover continues the same frame
     * stream and needs no refresh.
     */
    _shouldRefreshOnSwitch() {
        const now = Date.now();
        if (this._lastFrameGapAt && now - this._lastFrameGapAt < 8000) return true;
        // Require a minimum number of samples before trusting loss/jitter:
        // the first pings after connect can spuriously time out during GFX/RTC
        // init and would otherwise trigger a needless refresh.
        const win = this._wsQuality.window || [];
        const q = this._wsQuality;
        if (win.length >= 5) {
            if (q.lossPct != null && q.lossPct > 5) return true;
            if (q.jitterMs != null && q.jitterMs > 200) return true;
        }
        const rtcSamples = this._rtcRttValues.length;
        if (rtcSamples >= 5 && this._rtcLink && this._rtcLink.lossPct != null && this._rtcLink.lossPct > 5) {
            return true;
        }
        return false;
    }

    _setupEventListeners() {
        // UI buttons
        // The status icon is the connect affordance: it opens the dialog when
        // there is no live session, which removes the duplicate Connect button.
        this._el.status?.addEventListener('click', () => {
            if (this._isConnected || this._pendingConnect) return;
            this._showModal();
        });
        this._el.btnDisconnect.addEventListener('click', () => this.disconnect());
        if (this._el.btnReconnect) this._el.btnReconnect.addEventListener('click', () => this.setAutoReconnect(!this._autoReconnect));
        this._updateReconnectBtn();
        this._el.btnTheme?.addEventListener('click', () => this.toggleThemeMode());
        this._el.btnMute.addEventListener('click', () => this._toggleMute());
        this._el.btnKeyboard.addEventListener('click', () => this._toggleKeyboard());
        this._el.btnScreenshot.addEventListener('click', () => this._handleScreenshotClick());
        this._el.btnClipboard.addEventListener('click', () => this.pushClipboard());
        this._el.btnFullscreen.addEventListener('click', () => this._toggleFullscreen());
        
        // Loading area - click to open modal if not connected/connecting.
        // Make it a real button so keyboard users can trigger it too.
        if (this.options.loadingSpinnerOpensModal) {
            this._el.loading.setAttribute('role', 'button');
            this._el.loading.setAttribute('tabindex', '0');
            this._el.loading.setAttribute('aria-label', 'Open connection dialog');
            this._openModalIfIdle = () => {
                if (!this._isConnected && !this._pendingConnect) this._showModal();
            };
            this._el.loading.addEventListener('click', this._openModalIfIdle);
            this._el.loading.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this._openModalIfIdle();
                }
            });
            this._el.loading.style.cursor = 'pointer';
        }
        
        // Modal
        this._el.modalConnect.addEventListener('click', () => this._handleModalConnect());
        this._el.modalCancel.addEventListener('click', () => this._hideModal());
        this._el.modal.addEventListener('click', (e) => {
            if (e.target === this._el.modal) this._hideModal();
        });
        this._el.modal.addEventListener('keydown', (e) => this._handleModalKeyDown(e));
        // Clear stale REQUIRED-field warnings as soon as the user edits a field.
        // (Connection errors from the server are left alone until the next attempt.)
        for (const input of [this._el.inputHost, this._el.inputPort, this._el.inputUser, this._el.inputPass]) {
            input?.addEventListener('input', () => {
                if (this._el.modalError?.dataset.kind === 'validation') {
                    this._el.modalError.classList.remove('show');
                    delete this._el.modalError.dataset.kind;
                }
            });
        }

        // Canvas interactions
        this._canvas.setAttribute('tabindex', '0');
        this._canvas.addEventListener('click', () => this._focusInput());
        this._canvas.addEventListener('mousemove', (e) => this._handleMouseMove(e));
        this._canvas.addEventListener('mousedown', (e) => this._handleMouseDown(e));
        this._canvas.addEventListener('mouseup', (e) => this._handleMouseUp(e));
        this._canvas.addEventListener('wheel', (e) => this._handleMouseWheel(e));
        this._canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // IME capture field: routes keyboard focus to a focusable editable element
        // so CJK / dead-key composition works, then forwards committed text as Unicode.
        if (this._el.ime) {
            this._el.ime.addEventListener('click', () => this._focusInput());
            this._el.ime.addEventListener('compositionstart', () => { this._composing = true; });
            this._el.ime.addEventListener('compositionend', (e) => this._handleCompositionEnd(e));
            // Keep the field empty so it never accumulates text; physical keys are
            // forwarded via keydown/keyup and prevented from local echo.
            this._el.ime.addEventListener('input', () => {
                if (!this._composing) this._el.ime.value = '';
            });
        }

        // System-key interception. On Windows, Win/Meta is reserved by the OS:
        // a plain keydown preventDefault() in the shadow root is often too late
        // (the OS opens the Start menu before the page sees the event), and when
        // focus leaves our capture surface the shadow listener never fires at
        // all. Capture on window so we always get a first chance to block it.
        // We only block when focus is NOT on our input surface: if it is, the
        // normal _handleKeyDown path both forwards the key and preventDefaults.
        this._windowKeyDownCapture = (e) => {
            if (!this._isConnected) return;
            if (e.code !== 'MetaLeft' && e.code !== 'MetaRight' && e.key !== 'OS' && e.key !== 'Meta') return;
            if (this._isInputFocused()) return; // shadow handler will intercept
            e.preventDefault();
            e.stopImmediatePropagation();
        };
        this._windowKeyUpCapture = (e) => {
            if (!this._isConnected) return;
            if (e.code !== 'MetaLeft' && e.code !== 'MetaRight' && e.key !== 'OS' && e.key !== 'Meta') return;
            if (this._isInputFocused()) return;
            e.preventDefault();
            e.stopImmediatePropagation();
        };
        window.addEventListener('keydown', this._windowKeyDownCapture, { capture: true });
        window.addEventListener('keyup', this._windowKeyUpCapture, { capture: true });

        // Keyboard - scoped to shadow root
        this._shadow.addEventListener('keydown', (e) => this._handleKeyDown(e));
        this._shadow.addEventListener('keyup', (e) => this._handleKeyUp(e));

        // If the window loses focus while a key is held down, the matching keyup
        // never arrives. Without releasing it remotely, a stuck modifier (Win,
        // Ctrl, Alt, Shift) turns later keystrokes into shortcuts - e.g. a bare
        // "l" becomes Win+L and locks the remote session.
        this._releaseAllKeysHandler = () => this._releaseAllKeys();
        this._visibilityReleaseHandler = () => {
            if (document.hidden) this._releaseAllKeys();
        };
        window.addEventListener('blur', this._releaseAllKeysHandler);
        document.addEventListener('visibilitychange', this._visibilityReleaseHandler);
        window.addEventListener('pagehide', this._releaseAllKeysHandler);
        // When the window regains focus, restore keyboard focus to our capture
        // surface so Meta/system keys keep being intercepted.
        this._windowFocusHandler = () => {
            if (this._isConnected) this._focusInput();
        };
        window.addEventListener('focus', this._windowFocusHandler);
        
        // Virtual keyboard events
        this._setupVirtualKeyboard();

        // Resize observer
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => this._handleResize());
            this._resizeObserver.observe(this._el.screen);
        }

        // Browser zoom / DPR changes: a fluid layout keeps the screen element's
        // CSS size constant (so ResizeObserver never fires) while devicePixelRatio
        // changes. Watch the resolution media query so zoom re-triggers a resize.
        this._setupZoomListener();

        // Route switcher popup
        this._el.transport.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleRoutePop();
        });
        this._el.transport.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                this._toggleRoutePop();
            }
        });
        this._shadow.addEventListener('click', (e) => {
            if (this._el.routePop?.classList.contains('open')
                && !e.composedPath().includes(this._el.routePop)
                && !e.composedPath().includes(this._el.transport)) {
                this._el.routePop.classList.remove('open');
                this._el.transport?.setAttribute('aria-expanded', 'false');
            }
        });
        // Esc closes the route picker and returns focus to the badge.
        this._shadow.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (!this._el.routePop?.classList.contains('open')) return;
            e.preventDefault();
            this._el.routePop.classList.remove('open');
            this._el.transport?.setAttribute('aria-expanded', 'false');
            this._el.transport?.focus();
        });
    }

    /**
     * Re-arm a matchMedia listener whenever devicePixelRatio changes (browser
     * zoom, moving the window between displays). A fluid layout keeps the screen
     * element's CSS size constant under zoom, so ResizeObserver alone misses it.
     */
    _setupZoomListener() {
        if (typeof window.matchMedia !== 'function') return;
        // Reset devicePixelRatio-based canvas backing so zoomed output stays 1:1.
        this._lastDpr = window.devicePixelRatio || 1;
        const arm = () => {
            const prev = this._zoomMediaQuery;
            if (prev) {
                if (typeof prev.removeEventListener === 'function') {
                    prev.removeEventListener('change', this._zoomChangeHandler);
                } else if (typeof prev.removeListener === 'function' && this._zoomChangeHandler) {
                    prev.removeListener(this._zoomChangeHandler);
                }
            }
            const dpr = window.devicePixelRatio || 1;
            const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
            const onChange = () => {
                if (this._destroyed) return;
                this._lastDpr = window.devicePixelRatio || 1;
                // Force the size-dedup guard to re-evaluate under the new DPR.
                this._lastRequestedWidth = 0;
                this._lastRequestedHeight = 0;
                this._handleResize();
                arm();
            };
            this._zoomChangeHandler = onChange;
            this._zoomMediaQuery = mq;
            if (typeof mq.addEventListener === 'function') {
                mq.addEventListener('change', onChange);
            } else if (typeof mq.addListener === 'function') {
                mq.addListener(onChange);
            }
        };
        arm();
    }

    // --------------------------------------------------
    // PUBLIC API
    // --------------------------------------------------

    /**
     * Connect to an RDP server
     * @param {Object} credentials
     * @param {string} credentials.host - RDP server hostname/IP
     * @param {number} [credentials.port=3389] - RDP port
     * @param {string} credentials.user - Username
     * @param {string} credentials.pass - Password
     * @returns {Promise<void>}
     */
    connect(credentials, opts = {}) {
        return new Promise((resolve, reject) => {
            if (this._transport && this._transport.isOpen()) {
                reject(new Error('Already connected'));
                return;
            }

            // host, user and pass are required
            if (!credentials.host || !credentials.user || !credentials.pass) {
                reject(new Error('Missing required connection fields: host, user, pass'));
                return;
            }
            
            // Validate connection against security policy
            const port = credentials.port || 3389;
            const policyResult = this.#securityPolicy.validate(credentials.host, port);
            if (!policyResult.allowed) {
                reject(new Error(policyResult.reason || 'Connection blocked by security policy'));
                return;
            }

            // Hide modal if it's open (e.g., when connect() is called via API)
            if (this._el.modal.classList.contains('active')) {
                this._el.modal.classList.remove('active');
            }

            this._pendingConnect = { resolve, reject };
            this._manualDisconnect = false;
            this._connectFailed = false;
            if (!opts || !opts._retry) {
                this._reconnectAttempts = 0;
                this._clearReconnectTimer();
                this._lastError = null;
            }
            this._lastCredentials = { ...credentials };
            this._updateStatus('connecting', 'Connecting...');
            this._el.loading.querySelector('p').textContent = 'Connecting...';
            this._setLoadingMode('busy');

            const transport = new WsTransport(this.options.wsUrl);
            this._transport = transport;
            transport.onopen = () => {
                const { width, height } = this._getAvailableDimensions();
                this._lastRequestedWidth = width;
                this._lastRequestedHeight = height;
                this._canvas.width = width;
                this._canvas.height = height;

                this._sendMessage({
                    type: 'connect',
                    host: credentials.host,
                    port: credentials.port || 3389,
                    username: credentials.user,
                    password: credentials.pass,
                    width,
                    height
                });

                console.log('[RDPClient] Connect request to', credentials.host + ':' + (credentials.port || 3389));
            };

            transport.onmessage = (e) => this._handleMessage(e);
            transport.onerror = (e) => {
                const reason = 'Connection error (transport failed)';
                this._lastError = reason;
                if (this._pendingConnect) {
                    this._pendingConnect.reject(new Error(reason));
                    this._pendingConnect = null;
                    this._connectFailed = true;
                }
            };
            transport.onclose = () => this._handleDisconnect();
            transport.connect().catch((e) => {
                if (this._pendingConnect) {
                    const reason = (e instanceof Error && e.message) ? e.message : 'Transport error';
                    this._lastError = reason;
                    this._pendingConnect.reject(new Error(reason));
                    this._pendingConnect = null;
                    this._connectFailed = true;
                }
            });
        });
    }

    /**
     * Disconnect from the RDP server
     * @returns {Promise<void>} Resolves when disconnection is complete
     */
    disconnect() {
        return new Promise((resolve) => {
            this._manualDisconnect = true;
            this._clearReconnectTimer();
            // If already disconnected or no transport, resolve immediately
            if (!this._transport || this._transport.isClosed()) {
                if (this._isConnected) {
                    this._handleDisconnect();
                }
                resolve();
                return;
            }
            
            // If disconnect already in progress, chain to existing promise
            if (this._pendingDisconnect) {
                this._pendingDisconnect.then(resolve);
                return;
            }
            
            // Store pending disconnect resolver
            let resolveDisconnect;
            this._pendingDisconnect = new Promise((r) => { resolveDisconnect = r; });
            this._pendingDisconnect.resolve = resolveDisconnect;
            this._pendingDisconnect.then(resolve);
            
            // Send disconnect message to server
            this._sendMessage({ type: 'disconnect' });

            // Close transport (will trigger onclose -> _handleDisconnect)
            this._transport.close();
            
            // Timeout fallback - force cleanup after 3 seconds
            this._disconnectTimeout = setTimeout(() => {
                if (this._pendingDisconnect) {
                    console.warn('[RDPClient] Disconnect timeout, forcing cleanup');
                    this._handleDisconnect();
                    this._pendingDisconnect.resolve();
                    this._pendingDisconnect = null;
                }
            }, 3000);
        });
    }

    /**
     * Send keystrokes to the remote desktop
     * @param {string|string[]} keys - Keys to send
     * @param {Object} [options] - Modifier options
     * @returns {Promise<void>}
     */
    sendKeys(keys, options = {}) {
        return new Promise((resolve, reject) => {
            if (!this._isConnected) {
                reject(new Error('Not connected'));
                return;
            }

            const keyArray = Array.isArray(keys) ? keys : keys.split('');
            const delay = options.delay || 50;
            let index = 0;

            const sendNext = () => {
                if (index >= keyArray.length) {
                    resolve();
                    return;
                }

                const key = keyArray[index];
                this._sendMessage({
                    type: 'key', action: 'down', key,
                    code: `Key${key.toUpperCase()}`,
                    ctrlKey: options.ctrl || false,
                    shiftKey: options.shift || false,
                    altKey: options.alt || false,
                    metaKey: options.meta || false
                });

                setTimeout(() => {
                    this._sendMessage({
                        type: 'key', action: 'up', key,
                        code: `Key${key.toUpperCase()}`,
                        ctrlKey: options.ctrl || false,
                        shiftKey: options.shift || false,
                        altKey: options.alt || false,
                        metaKey: options.meta || false
                    });
                    index++;
                    setTimeout(sendNext, delay);
                }, 20);
            };

            sendNext();
        });
    }

    /**
     * Send a key combination (e.g., "Ctrl+Alt+Delete")
     * @param {string} combo - Key combination
     */
    sendKeyCombo(combo) {
        if (!this._isConnected) throw new Error('Not connected');
        this._sendMessage({ type: 'keycombo', combo });
    }

    /**
     * Send Ctrl+Alt+Delete
     */
    sendCtrlAltDel() {
        this.sendKeyCombo('Ctrl+Alt+Delete');
    }

    /**
     * Send key-up for every key still held on the remote.
     *
     * Useful after the browser loses keyboard focus (the matching key-up events
     * are then never delivered) to clear stuck modifiers such as Win/Ctrl/Alt.
     */
    releaseAllKeys() {
        this._releaseAllKeys();
    }

    /**
     * Send Backspace key press
     * @param {number} [count=1] - Number of backspace keys to send
     * @returns {Promise<void>} Resolves when all backspaces are sent
     */
    async sendBackspace(count = 1) {
        for (let i = 0; i < count; i++) {
            if (i > 0) {
                await this._delay(20);
            }
            this.sendKeyCombo('Backspace');
        }
    }

    // --------------------------------------------------
    // PUBLIC API: PROGRAMMATIC MOUSE CONTROL
    // --------------------------------------------------

    /**
     * Move the mouse cursor to a specific position
     * Shows a visual cursor overlay until real mouse movement is detected
     * @param {number} x - X coordinate in remote desktop pixels
     * @param {number} y - Y coordinate in remote desktop pixels
     * @returns {void}
     * @throws {Error} If not connected
     * @example
     * client.sendMouseMove(100, 200);
     */
    sendMouseMove(x, y) {
        if (!this._isConnected) throw new Error('Not connected');
        
        x = Math.round(x);
        y = Math.round(y);
        
        this._sendMessage({ type: 'mouse', action: 'move', x, y });
        this._showApiCursor(x, y);
    }

    /**
     * Perform a mouse click at the current cursor position or specified coordinates
     * Shows a visual cursor overlay until real mouse movement is detected
     * @param {Object} [options={}] - Click options
     * @param {number} [options.x] - X coordinate (if omitted, clicks at last API cursor position)
     * @param {number} [options.y] - Y coordinate (if omitted, clicks at last API cursor position)
     * @param {'left'|'right'|'middle'} [options.button='left'] - Mouse button to click
     * @param {number} [options.count=1] - Number of clicks (e.g., 2 for double-click)
     * @param {number} [options.delay=50] - Delay between clicks in ms (for multiple clicks)
     * @returns {Promise<void>} Resolves when all clicks are complete
     * @throws {Error} If not connected
     * @example
     * // Left click at current position
     * await client.sendMouseClick();
     * 
     * // Right click at specific position
     * await client.sendMouseClick({ x: 500, y: 300, button: 'right' });
     * 
     * // Double click
     * await client.sendMouseClick({ x: 100, y: 100, count: 2 });
     */
    async sendMouseClick(options = {}) {
        if (!this._isConnected) throw new Error('Not connected');
        
        const {
            x = this._apiCursorPos.x,
            y = this._apiCursorPos.y,
            button = 'left',
            count = 1,
            delay = 50
        } = options;
        
        const buttonCode = button === 'right' ? 2 : button === 'middle' ? 1 : 0;
        const posX = Math.round(x);
        const posY = Math.round(y);
        
        // Move to position first if coordinates provided
        if (options.x !== undefined || options.y !== undefined) {
            this._sendMessage({ type: 'mouse', action: 'move', x: posX, y: posY });
        }
        
        this._showApiCursor(posX, posY);
        
        for (let i = 0; i < count; i++) {
            if (i > 0) {
                await this._delay(delay);
            }
            this._sendMessage({ type: 'mouse', action: 'down', button: buttonCode, x: posX, y: posY });
            await this._delay(20);
            this._sendMessage({ type: 'mouse', action: 'up', button: buttonCode, x: posX, y: posY });
        }
    }

    /**
     * Perform a mouse scroll at the current cursor position or specified coordinates
     * Shows a visual cursor overlay until real mouse movement is detected
     * @param {Object} [options={}] - Scroll options
     * @param {number} [options.x] - X coordinate (if omitted, scrolls at last API cursor position)
     * @param {number} [options.y] - Y coordinate (if omitted, scrolls at last API cursor position)
     * @param {number} [options.deltaX=0] - Horizontal scroll amount (positive = right, negative = left)
     * @param {number} [options.deltaY=0] - Vertical scroll amount (positive = down, negative = up)
     * @returns {void}
     * @throws {Error} If not connected
     * @example
     * // Scroll down at current position
     * client.sendMouseScroll({ deltaY: 100 });
     * 
     * // Scroll up at specific position
     * client.sendMouseScroll({ x: 500, y: 300, deltaY: -100 });
     * 
     * // Horizontal scroll
     * client.sendMouseScroll({ deltaX: 50 });
     */
    sendMouseScroll(options = {}) {
        if (!this._isConnected) throw new Error('Not connected');
        
        const {
            x = this._apiCursorPos.x,
            y = this._apiCursorPos.y,
            deltaX = 0,
            deltaY = 0
        } = options;
        
        const posX = Math.round(x);
        const posY = Math.round(y);
        
        // Move to position first if coordinates provided
        if (options.x !== undefined || options.y !== undefined) {
            this._sendMessage({ type: 'mouse', action: 'move', x: posX, y: posY });
        }
        
        this._showApiCursor(posX, posY);
        
        this._sendMessage({
            type: 'mouse',
            action: 'wheel',
            deltaX,
            deltaY,
            x: posX,
            y: posY
        });
    }

    /**
     * Get current connection status
     * @returns {Object} Status object
     */
    getStatus() {
        return {
            connected: this._isConnected,
            resolution: this._isConnected ? 
                { width: this._canvas.width, height: this._canvas.height } : null,
            muted: this._isMuted
        };
    }

    /**
     * Set mute state
     * @param {boolean} muted
     */
    setMuted(muted) {
        this._isMuted = muted;
        if (this._audioGainNode) {
            this._audioGainNode.gain.value = muted ? 0 : 1;
        }
        // Notify AudioWorklet
        if (this._audioWorklet) {
            this._audioWorklet.port.postMessage({ type: 'mute', data: { muted } });
        }
        this._updateMuteIcon();
        this._emit('mute', { muted });
    }

    /**
     * Swap the mute button glyph between speaker and crossed-out speaker.
     * Keeps a stable accessible label instead of an emoji.
     */
    _updateMuteIcon() {
        const btn = this._el?.btnMute;
        if (!btn) return;
        btn.innerHTML = this._isMuted
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6.5 9H3v6h3.5L11 19V5Z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6.5 9H3v6h3.5L11 19V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 6a9 9 0 0 1 0 12"/></svg>`;
        btn.setAttribute('aria-label', this._isMuted ? 'Unmute audio' : 'Mute audio');
        btn.title = this._isMuted ? 'Unmute audio' : 'Mute audio';
        btn.setAttribute('aria-pressed', String(!!this._isMuted));
    }

    /**
     * Get current mute state
     * @returns {boolean} True if muted
     */
    getMuted() {
        return this._isMuted;
    }

    /**
     * Get current resolution
     * @returns {Object|null} Resolution object { width, height } or null if not connected
     */
    getResolution() {
        if (!this._isConnected) return null;
        return { width: this._canvas.width, height: this._canvas.height };
    }

    /**
     * Check if connected to RDP server
     * @returns {boolean} True if connected
     */
    isConnected() {
        return this._isConnected;
    }

    /**
     * Get current latency in milliseconds
     * @returns {number|null} Latency in ms, or null if not yet measured
     */
    getLatency() {
        if (!this._isConnected) return null;
        return this._lastLatency || null;
    }

    /**
     * Get the security policy configuration (read-only)
     * The returned object is frozen and cannot be modified
     * @returns {import('./rdp-security.js').SecurityPolicy} Security policy
     */
    getSecurityPolicy() {
        return this.#securityPolicy.getPolicy();
    }

    /**
     * Check if a destination would be allowed by the security policy
     * @param {string} host - Hostname or IP address
     * @param {number} [port=3389] - Port number
     * @returns {{allowed: boolean, reason?: string}} Validation result
     */
    validateDestination(host, port = 3389) {
        return this.#securityPolicy.validate(host, port);
    }

    /**
     * Capture a screenshot of the current remote desktop
     * @param {string} [type='png'] - Image type: 'png' or 'jpg'
     * @param {number} [quality=0.9] - JPEG quality (0-1), ignored for PNG
     * @returns {Promise<{blob: Blob, width: number, height: number}>} Screenshot data
     * @throws {Error} If not connected or screenshot fails
     * @example
     * const { blob, width, height } = await client.getScreenshot();
     * const url = URL.createObjectURL(blob);
     */
    getScreenshot(type = 'png', quality = 0.9) {
        return new Promise((resolve, reject) => {
            if (!this._isConnected) {
                reject(new Error('Not connected'));
                return;
            }
            
            if (!this._gfxWorker || !this._gfxWorkerReady) {
                reject(new Error('GFX Worker not ready'));
                return;
            }
            
            const requestId = ++this._screenshotRequestId;
            const mimeType = type === 'jpg' || type === 'jpeg' ? 'image/jpeg' : 'image/png';
            if (typeof quality !== 'number' || quality < 0 || quality > 1) {
                quality = 0.9;
            }
            
            this._screenshotRequests.set(requestId, { resolve, reject });
            
            this._gfxWorker.postMessage({
                type: 'screenshot',
                data: { requestId, mimeType, quality }
            });
            
            // Timeout after 5 seconds
            setTimeout(() => {
                if (this._screenshotRequests.has(requestId)) {
                    this._screenshotRequests.delete(requestId);
                    reject(new Error('Screenshot timeout'));
                }
            }, 5000);
        });
    }

    /**
     * Capture and download a screenshot of the remote desktop
     * @param {string} [type='png'] - Image type: 'png' or 'jpg'
     * @param {number} [quality=0.9] - JPEG quality (0-1), ignored for PNG
     * @returns {Promise<void>} Resolves when download starts
     * @example
     * // Downloads as 'screenshot-2026-01-12--14-30.png'
     * await client.downloadScreenshot();
     * 
     * // Download as JPEG
     * await client.downloadScreenshot('jpg');
     */
    async downloadScreenshot(type = 'png', quality = 0.9) {
        const { blob } = await this.getScreenshot(type, quality);
        
        // Generate filename with timestamp: screenshot-YYYY-mm-dd--hh-mm.ext
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}--${pad(now.getHours())}-${pad(now.getMinutes())}`;
        const ext = (type === 'jpg' || type === 'jpeg') ? 'jpg' : 'png';
        const filename = `screenshot-${timestamp}.${ext}`;
        
        // Create download link and trigger
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * Register an event handler
     * @param {string} event - Event name ('connected', 'disconnected', 'error')
     * @param {Function} handler - Callback function
     */
    on(event, handler) {
        if (!this._eventHandlers[event]) {
            this._eventHandlers[event] = [];
        }
        this._eventHandlers[event].push(handler);
    }

    /**
     * Remove an event handler
     * @param {string} event
     * @param {Function} handler
     */
    off(event, handler) {
        if (this._eventHandlers[event]) {
            this._eventHandlers[event] = this._eventHandlers[event]
                .filter(h => h !== handler);
        }
    }

    /**
     * Destroy the client and clean up resources
     * @returns {Promise<void>} Resolves when destruction is complete
     */
    async destroy() {
        this._manualDisconnect = true;
        this._destroyed = true;
        this._clearReconnectTimer();
        await this.disconnect();
        if (this._gfxWorker) {
            this._gfxWorker.terminate();
            this._gfxWorker = null;
        }
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
        }
        if (this._toolbarResizeObserver) {
            this._toolbarResizeObserver.disconnect();
        }
        if (this._zoomMediaQuery && this._zoomChangeHandler) {
            if (typeof this._zoomMediaQuery.removeEventListener === 'function') {
                this._zoomMediaQuery.removeEventListener('change', this._zoomChangeHandler);
            } else if (typeof this._zoomMediaQuery.removeListener === 'function') {
                this._zoomMediaQuery.removeListener(this._zoomChangeHandler);
            }
        }
        clearTimeout(this._toastTimer);
        clearTimeout(this._chromeHideTimer);
        this._dockPopOpen = false;
        window.removeEventListener('blur', this._releaseAllKeysHandler);
        document.removeEventListener('visibilitychange', this._visibilityReleaseHandler);
        window.removeEventListener('pagehide', this._releaseAllKeysHandler);
        window.removeEventListener('focus', this._windowFocusHandler);
        window.removeEventListener('keydown', this._windowKeyDownCapture, { capture: true });
        window.removeEventListener('keyup', this._windowKeyUpCapture, { capture: true });
        if (navigator.keyboard?.unlock) navigator.keyboard.unlock().catch(() => {});
        this._pressedKeys.clear();
        this._shadow.innerHTML = '';
    }

    // --------------------------------------------------
    // PRIVATE: UI
    // --------------------------------------------------

    _emit(event, data) {
        if (this._eventHandlers[event]) {
            this._eventHandlers[event].forEach(h => h(data));
        }
    }

    _showModal() {
        // Remember what had focus so it can be restored on close.
        this._preModalFocus = this._shadow.activeElement;
        this._el.modal.classList.add('active');
        this._showChrome(false);   // never hide the toolbar behind a dialog
        // Hide cancel button when keepConnectionModalOpen is enabled
        this._el.modalCancel.style.display = this.options.keepConnectionModalOpen ? 'none' : '';
        // Show the last failure reason if there is one
        if (this._el.modalError) {
            if (this._lastError) {
                this._el.modalError.textContent = this._lastError;
                this._el.modalError.classList.add('show');
                this._el.modalError.dataset.kind = 'connection';
            } else {
                this._el.modalError.textContent = '';
                this._el.modalError.classList.remove('show');
                delete this._el.modalError.dataset.kind;
            }
        }
        // Prefill remembered connection
        this._restoreRememberedConnection();
        this._el.inputHost.focus();
    }

    _hideModal() {
        // Don't allow hiding modal if keepConnectionModalOpen is enabled and not connected
        if (this.options.keepConnectionModalOpen && !this._isConnected) {
            return;
        }
        const wasActive = this._el.modal.classList.contains('active');
        this._el.modal.classList.remove('active');
        if (wasActive) this._scheduleChromeHide();
        // Restore focus to whatever opened the dialog, so keyboard users are
        // not dropped back at the top of the document.
        if (wasActive) {
            const prev = this._preModalFocus;
            this._preModalFocus = null;
            if (prev && typeof prev.focus === 'function' && prev.isConnected) {
                try { prev.focus({ preventScroll: true }); } catch {}
            } else {
                try { this._el.status?.focus({ preventScroll: true }); } catch {}
            }
        }
    }

    /** True when the connection dialog is open. */
    _isModalOpen() {
        return !!this._el?.modal?.classList.contains('active');
    }

    /**
     * Dialog keyboard behaviour: Esc closes it, Enter submits, and Tab is kept
     * inside the dialog so focus cannot wander behind the scrim.
     */
    _handleModalKeyDown(e) {
        if (!this._isModalOpen()) return;
        if (e.key === 'Escape') {
            if (this.options.keepConnectionModalOpen && !this._isConnected) return;
            e.preventDefault();
            this._hideModal();
            return;
        }
        if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
            e.preventDefault();
            this._handleModalConnect();
            return;
        }
        if (e.key === 'Tab') {
            const focusable = this._el.modal.querySelectorAll(
                'input:not([disabled]), button:not([disabled]):not([style*="display: none"])'
            );
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = this._shadow.activeElement;
            if (e.shiftKey && active === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && active === last) {
                e.preventDefault();
                first.focus();
            }
        }
    }

    _handleModalConnect() {
        const host = this._el.inputHost.value.trim();
        const port = parseInt(this._el.inputPort.value) || 3389;
        const user = this._el.inputUser.value.trim();
        const pass = this._el.inputPass.value;

        if (!host || !user) {
            // Inline, announced feedback instead of a blocking alert()
            if (this._el.modalError) {
                this._el.modalError.textContent = 'Host and username are required';
                this._el.modalError.classList.add('show');
                this._el.modalError.dataset.kind = 'validation';
            }
            (host ? this._el.inputUser : this._el.inputHost).focus();
            return;
        }

        this._rememberConnection(host, port, user, pass);
        this._hideModal();
        this.connect({ host, port, user, pass }).catch(() => {});
    }

    _rememberConnection(host, port, user, pass) {
        try {
            if (!this._el.inputRemember || !this._el.inputRemember.checked) {
                localStorage.removeItem(RDP_REMEMBER_KEY);
                return;
            }
            localStorage.setItem(RDP_REMEMBER_KEY, JSON.stringify({ host, port, user, pass }));
        } catch {}
    }

    _restoreRememberedConnection() {
        try {
            const raw = localStorage.getItem(RDP_REMEMBER_KEY);
            if (!raw || !this._el.inputHost) return;
            const saved = JSON.parse(raw);
            if (saved.host) this._el.inputHost.value = saved.host;
            if (saved.port) this._el.inputPort.value = saved.port;
            if (saved.user) this._el.inputUser.value = saved.user;
            if (this._el.inputPass && saved.pass) this._el.inputPass.value = saved.pass;
            if (this._el.inputRemember) this._el.inputRemember.checked = true;
        } catch {}
    }

    _setupFullscreenAutohide() {
        this._lastFullscreenChange = 0;
        const sync = () => {
            this._lastFullscreenChange = Date.now();
            const isFs = !!document.fullscreenElement;
            this._el.container.classList.toggle('fs-autohide', isFs);
            this._el.btnFullscreen?.setAttribute('aria-pressed', String(isFs));
            this._el.btnFullscreen?.setAttribute('aria-label', isFs ? 'Exit fullscreen' : 'Enter fullscreen');
            // Keep reserved keys (Win/Esc) in the remote session while fullscreen.
            if (isFs && navigator.keyboard?.lock) {
                navigator.keyboard.lock().catch(() => {});
                this._focusInput();
            } else if (!isFs && navigator.keyboard?.unlock) {
                navigator.keyboard.unlock().catch(() => {});
            }
            this._handleResize();
        };
        document.addEventListener('fullscreenchange', sync);
        document.addEventListener('fullscreenerror', () => {
            this._el.container.classList.remove('fs-autohide');
            this._el.btnFullscreen?.setAttribute('aria-pressed', 'false');
        });
    }

    /**
     * Write a bottom-bar metric without wasting space on a visible label.
     *
     * Only the value is rendered; the full description goes to the tooltip and
     * aria-label so the information is still available on hover and to screen
     * readers.
     *
     * @param {'latency'} key
     * @param {string} value - Compact value, e.g. "1920×1080" or "42ms"
     * @param {string} [label] - Full description for title/aria-label
     */
    _setMetric(key, value, label) {
        const el = this._el?.[key];
        if (!el) return;
        const valueEl = el.querySelector('.rdp-metric-value') || el;
        valueEl.textContent = value;
        if (label) {
            el.setAttribute('title', label);
            el.setAttribute('aria-label', label);
        }
        el.dataset.value = value;
    }

    _updateStatus(state, text) {
        const status = this._el?.status;
        if (status) {
            // The glyph is chosen by CSS from data-state, so one attribute swap
            // switches between the disconnected / live / error icons.
            status.dataset.state = state;
            const connectable = state === 'disconnected' || state === 'error';
            status.title = connectable ? `${text || state} — click to connect` : (text || state);
            status.setAttribute('aria-label', connectable
                ? `${text || state}. Click to connect.`
                : (text || state));
            // Only offer the dialog affordance when there is no live session.
            status.disabled = !connectable;
            status.style.cursor = connectable ? 'pointer' : 'default';
        }
        // Text stays for assistive tech only; nothing is rendered visually.
        if (this._el?.statusText) this._el.statusText.textContent = text;
    }

    // --------------------------------------------------
    // PRIVATE: FLOATING HUD AUTO-HIDE
    // --------------------------------------------------

    /**
     * Wire up the floating HUD: one compact panel that folds away when idle.
     *
     * Reopening is deliberately explicit - the user presses the slim grip that
     * remains at the top edge, or the pin button. Simply moving the pointer in
     * the remote desktop never reopens it, which is what made the earlier
     * two-bar layout feel like it was constantly jumping into view.
     */
    _setupChromeAutohide() {
        this._chromeHideDelay = this.options.chromeHideDelayMs ?? 2600;
        this._chromeHidden = false;
        this._chromeHideTimer = null;
        this._chromePinned = false;

        const container = this._el.container;

        // The grip is the only affordance that reopens the HUD.
        this._el.hudHandle?.addEventListener('click', () => {
            this._showChrome(true);
        });

        // Plain activity in the remote desktop only postpones hiding; it never
        // reveals the HUD. Keeps the picture unobstructed during real work.
        this._chromeActivityHandler = () => {
            if (!this._chromeHidden) this._scheduleChromeHide();
        };
        container.addEventListener('mousemove', this._chromeActivityHandler);
        container.addEventListener('mousedown', this._chromeActivityHandler);
        container.addEventListener('wheel', this._chromeActivityHandler, { passive: true });

        // Hovering or focusing the panel itself keeps it open.
        const hud = this._el.hud;
        hud?.addEventListener('mouseenter', () => this._pinChrome(true));
        hud?.addEventListener('mouseleave', () => this._pinChrome(false));
        container.addEventListener('focusin', (e) => {
            // Only the HUD pins it; focus in the remote screen (the hidden IME
            // field) is normal usage and must not block hiding.
            if (this._isChromeElement(e.target)) this._pinChrome(true);
        });
        container.addEventListener('focusout', (e) => {
            if (this._isChromeElement(e.target) && !this._isChromeElement(e.relatedTarget)) {
                this._pinChrome(false);
            }
        });

        // Leaving the component entirely should not leave it revealed.
        container.addEventListener('mouseleave', () => {
            if (!this._chromePinned) this._scheduleChromeHide();
        });

        // Explicit pin toggle: keeps the HUD on screen regardless of idle time.
        this._el.btnPin?.addEventListener('click', () => this._toggleChromePin());
        this._updatePinButton();

        // Dock picker: move the HUD to any screen edge.
        this._el.btnDock?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleDockPop();
        });
        this._el.btnDock?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                this._toggleDockPop();
            }
        });
        this._shadow.addEventListener('click', (e) => {
            if (!this._dockPopOpen) return;
            if (e.composedPath().includes(this._el.dockPop)) return;
            if (e.composedPath().includes(this._el.btnDock)) return;
            this._closeDockPop();
        });
        this._shadow.addEventListener('keydown', (e) => {
            if (!this._dockPopOpen || e.key !== 'Escape') return;
            e.preventDefault();
            this._closeDockPop();
            this._el.btnDock?.focus();
        });
        this.setHudDock(this.options.hudDock);
    }

    // --------------------------------------------------
    // PRIVATE: HUD DOCKING (top / right / bottom / left)
    // --------------------------------------------------

    /** @public @returns {'top'|'right'|'bottom'|'left'} Current dock edge. */
    getHudDock() {
        return this._hudDock || 'top';
    }

    /**
     * Move the floating HUD to another screen edge.
     *
     * Horizontally docked panels lay out as a single row; vertically docked ones
     * stack into a column. The markup is shared, so only layout direction and
     * edge offsets change.
     *
     * @public
     * @param {'top'|'right'|'bottom'|'left'} dock
     * @returns {string} The applied dock edge
     */
    setHudDock(dock) {
        const allowed = ['top', 'right', 'bottom', 'left'];
        const next = allowed.includes(dock) ? dock : 'top';
        this._hudDock = next;
        this.options.hudDock = next;

        const container = this._el?.container;
        if (container) container.dataset.hudDock = next;

        const labels = { top: 'top', right: 'right', bottom: 'bottom', left: 'left' };
        if (this._el?.btnDock) {
            this._el.btnDock.title = `Move controls (currently ${labels[next]})`;
            this._el.btnDock.setAttribute('aria-label', this._el.btnDock.title);
        }

        this._closeDockPop();
        // Geometry changes invalidate the collapsed toolbar measurements.
        this._lastRequestedWidth = 0;
        this._lastRequestedHeight = 0;
        requestAnimationFrame(() => this._updateToolbarOverflow());
        try { this._emit('dock', { dock: next }); } catch {}
        return next;
    }

    _toggleDockPop() {
        if (this._dockPopOpen) this._closeDockPop();
        else this._openDockPop();
    }

    _openDockPop() {
        const pop = this._el?.dockPop;
        if (!pop) return;
        this._renderDockPop();
        pop.classList.add('open');
        this._dockPopOpen = true;
        this._el.btnDock?.setAttribute('aria-expanded', 'true');
        this._showChrome(false);
        requestAnimationFrame(() => pop.querySelector('.rdp-dock-item')?.focus());
    }

    _closeDockPop() {
        const pop = this._el?.dockPop;
        if (!pop) return;
        pop.classList.remove('open');
        this._dockPopOpen = false;
        this._el.btnDock?.setAttribute('aria-expanded', 'false');
        this._scheduleChromeHide();
    }

    _renderDockPop() {
        const pop = this._el?.dockPop;
        if (!pop) return;
        // Edge glyphs: a frame with the active edge filled.
        const icon = (edge) => {
            const paths = {
                top: '<path d="M3 9h18"/>',
                bottom: '<path d="M3 15h18"/>',
                left: '<path d="M9 3v18"/>',
                right: '<path d="M15 3v18"/>',
            };
            return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/>${paths[edge]}</svg>`;
        };
        const rows = [
            ['top', 'Dock top', 'row'],
            ['bottom', 'Dock bottom', 'row'],
            ['left', 'Dock left', 'column'],
            ['right', 'Dock right', 'column'],
        ];
        pop.innerHTML = rows.map(([edge, label]) => {
            const active = this.getHudDock() === edge;
            return `<button class="rdp-dock-item${active ? ' active' : ''}" role="menuitem" data-dock="${edge}" aria-pressed="${active}">`
                + `${icon(edge)}<span>${label}</span></button>`;
        }).join('');
        pop.querySelectorAll('[data-dock]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.setHudDock(btn.getAttribute('data-dock'));
            });
        });
    }

    /** Toggle the manual "keep controls visible" preference. */
    _toggleChromePin() {
        const pinned = !this.options.keepChromeVisible;
        this.setChromePinned(pinned);
        return pinned;
    }

    /**
     * Persistently keep the HUD visible (or return it to auto-hide).
     * @public
     * @param {boolean} pinned
     */
    setChromePinned(pinned) {
        this.options.keepChromeVisible = !!pinned;
        this._updatePinButton();
        if (this.options.keepChromeVisible) {
            this._showChrome(false);
            // Persisted pin disables auto-hide entirely.
            this._el.container.classList.remove('rdp-chrome-autohide');
            this._el.container.classList.remove('rdp-chrome-hidden');
            this._chromeHidden = false;
            if (this._chromeHideTimer) {
                clearTimeout(this._chromeHideTimer);
                this._chromeHideTimer = null;
            }
        } else {
            this._syncChromeAutohide();
        }
        return this.options.keepChromeVisible;
    }

    /** @public @returns {boolean} True when the HUD is manually pinned open. */
    isChromePinned() {
        return !!this.options.keepChromeVisible;
    }

    _updatePinButton() {
        const btn = this._el?.btnPin;
        if (!btn) return;
        const on = !!this.options.keepChromeVisible;
        btn.setAttribute('aria-pressed', String(on));
        btn.classList.toggle('on', on);
        btn.title = on ? 'Controls pinned open' : 'Keep controls visible';
    }

    /** Temporarily pin the HUD open (hover, focus, open menu). */
    _pinChrome(pinned) {
        this._chromePinned = !!pinned;
        if (pinned) this._showChrome(false);
        else this._scheduleChromeHide();
    }

    /** True when the node lives inside the floating HUD panel. */
    _isChromeElement(node) {
        if (!node || node.nodeType !== 1) return false;
        return !!this._el.hud?.contains(node);
    }

    _showChrome(schedule) {
        if (this._chromeHideTimer) {
            clearTimeout(this._chromeHideTimer);
            this._chromeHideTimer = null;
        }
        if (this._chromeHidden) {
            this._chromeHidden = false;
            this._el.container.classList.remove('rdp-chrome-hidden');
        }
        this._el.hudHandle?.setAttribute('aria-expanded', 'true');
        if (schedule) this._scheduleChromeHide();
    }

    _scheduleChromeHide() {
        if (this._chromeHideTimer) clearTimeout(this._chromeHideTimer);
        if (!this._chromeAutohideEnabled() || this._chromePinned) return;
        this._chromeHideTimer = setTimeout(() => {
            this._chromeHideTimer = null;
            if (!this._chromeAutohideEnabled() || this._chromePinned) return;
            // Never hide under a pointer that is resting on the panel.
            if (this._el.hud?.matches(':hover')) return;
            this._chromeHidden = true;
            this._el.container.classList.add('rdp-chrome-hidden');
            this._el.hudHandle?.setAttribute('aria-expanded', 'false');
        }, this._chromeHideDelay);
    }

    /** Auto-hide only makes sense while a live session fills the screen. */
    _chromeAutohideEnabled() {
        if (this.options.keepChromeVisible) return false;
        if (!this._isConnected) return false;
        if (this._isModalOpen?.()) return false;
        if (this._overflowMenuOpen) return false;
        if (this._dockPopOpen) return false;
        if (this._el.routePop?.classList.contains('open')) return false;
        if (this._keyboardVisible) return false;
        return true;
    }

    /** Apply/remove the auto-hide capability and reset to the revealed state. */
    _syncChromeAutohide() {
        const container = this._el.container;
        const enabled = this._isConnected
            && this.options.autoHideChrome !== false
            && !this.options.keepChromeVisible;
        container.classList.toggle('rdp-chrome-autohide', enabled);
        if (!enabled) {
            this._chromeHidden = false;
            container.classList.remove('rdp-chrome-hidden');
            if (this._chromeHideTimer) {
                clearTimeout(this._chromeHideTimer);
                this._chromeHideTimer = null;
            }
            return;
        }
        this._showChrome(true);
    }

    /**
     * Switch the loading area between the idle "+" affordance and the busy spinner.
     * @param {'idle'|'busy'} mode - 'busy' while connecting/reconnecting, 'idle' otherwise
     */
    _setLoadingMode(mode) {
        if (!this._el?.loading) return;
        this._el.loading.classList.toggle('idle', mode !== 'busy');
    }

    setAutoReconnect(enabled) {
        this._autoReconnect = !!enabled;
        if (!this._autoReconnect) this._clearReconnectTimer();
        else this._reconnectAttempts = 0;
        this._updateReconnectBtn();
        return this._autoReconnect;
    }

    getAutoReconnect() {
        return !!this._autoReconnect;
    }

    _updateReconnectBtn() {
        const btn = this._el?.btnReconnect;
        if (!btn) return;
        const on = !!this._autoReconnect;
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', String(on));
        btn.title = on ? 'Auto reconnect: on' : 'Auto reconnect: off';
        btn.setAttribute('aria-label', btn.title);
    }

    _clearReconnectTimer() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    _scheduleReconnect() {
        if (!this._autoReconnect || this._manualDisconnect) return;
        if (!this._lastCredentials) return;
        const max = this.options.reconnectMaxAttempts || 3;
        if (this._reconnectAttempts >= max) {
            console.warn(`[RDPClient] Reconnect gave up after ${max} attempts`);
            this._autoReconnect = false;
            this._updateReconnectBtn();
            this._updateStatus('disconnected', 'Disconnected');
            this._setLoadingMode('idle');
            if (this._el?.loading) this._el.loading.querySelector('p').textContent = 'Click to connect';
            return;
        }
        const delay = this.options.reconnectDelay || 10000;
        this._clearReconnectTimer();
        const attempt = this._reconnectAttempts + 1;
        this._updateStatus('connecting', `Reconnecting ${attempt}/${max} in ${Math.round(delay / 1000)}s...`);
        if (this._el?.loading) {
            this._el.loading.style.display = 'block';
            this._el.loading.querySelector('p').textContent = `Reconnecting ${attempt}/${max} in ${Math.round(delay / 1000)}s...`;
            this._setLoadingMode('busy');
        }
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            if (!this._autoReconnect || this._manualDisconnect) return;
            if (this._isConnected || this._pendingConnect) return;
            this._reconnectAttempts = attempt;
            this.connect({ ...this._lastCredentials }, { _retry: true }).catch(() => {});
        }, delay);
    }

    _toggleMute() {
        this.setMuted(!this._isMuted);
    }

    async _handleScreenshotClick() {
        try {
            await this.downloadScreenshot();
        } catch (err) {
            console.error('[RDPClient] Screenshot failed:', err);
        }
    }

    /**
     * Show a transient message over the RDP screen
     * @param {string} message - Text to display
     * @param {'info'|'success'|'error'} [type='info'] - Visual variant
     * @param {number} [duration=1800] - Visible time in ms
     */
    _toast(message, type = 'info', duration = 1800) {
        const el = this._el?.toast;
        if (!el) return;
        el.textContent = message;
        el.classList.remove('success', 'error');
        if (type === 'success' || type === 'error') el.classList.add(type);
        el.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => el.classList.remove('show'), duration);
    }

    /**
     * Push local clipboard text to the remote session
     * Requires a secure context (HTTPS or localhost) for clipboard read
     * @returns {Promise<boolean>} True if sent
     */
    async pushClipboard() {
        if (!this._isConnected) {
            console.warn('[RDPClient] Clipboard push: not connected');
            this._toast('Not connected', 'error');
            return false;
        }
        try {
            if (!navigator.clipboard || !navigator.clipboard.readText) {
                console.warn('[RDPClient] Clipboard read not available (needs HTTPS or localhost)');
                this._toast('Clipboard needs HTTPS or localhost', 'error');
                return false;
            }
            const text = await navigator.clipboard.readText();
            if (!text) {
                console.warn('[RDPClient] Clipboard push: local clipboard empty');
                this._toast('Clipboard is empty', 'error');
                return false;
            }
            this._sendMessage({ type: 'clipboard', text });
            const chars = Array.from(text).length;
            this._toast(`Pasted ${chars} char${chars === 1 ? '' : 's'} to remote`, 'success');
            this._emit('clipboardPush', { text, chars });
            return true;
        } catch (err) {
            console.warn('[RDPClient] Clipboard push failed:', err.message);
            this._toast(`Paste failed: ${err.message}`, 'error');
            return false;
        }
    }

    async _handleRemoteClipboard(text) {
        if (!text) return;
        try {
            if (!navigator.clipboard || !navigator.clipboard.writeText) {
                console.warn('[RDPClient] Clipboard write not available (needs HTTPS or localhost)');
                return;
            }
            await navigator.clipboard.writeText(text);
            const chars = Array.from(text).length;
            this._toast(`Copied ${chars} char${chars === 1 ? '' : 's'} from remote`, 'success');
            this._emit('clipboard', { text });
        } catch (err) {
            console.warn('[RDPClient] Clipboard write failed:', err.message);
            this._toast(`Copy failed: ${err.message}`, 'error');
        }
    }

    _toggleFullscreen() {
        if (document.fullscreenElement) {
            if (navigator.keyboard?.unlock) {
                navigator.keyboard.unlock().catch(() => {});
            }
            document.exitFullscreen();
        } else {
            this._el.container.classList.add('fs-autohide');
            // Fullscreen is a user gesture: acquire Keyboard Lock so reserved
            // keys (Win, Esc, Alt+Tab) go to the remote session instead of the
            // local OS. Without this, a local Win menu can pop up over the
            // remote one. Then restore focus to our capture surface.
            this._container.requestFullscreen().then(() => {
                if (navigator.keyboard?.lock) {
                    navigator.keyboard.lock().catch(() => {});
                }
                this._focusInput();
            }).catch(() => {});
        }
    }

    // --------------------------------------------------
    // PRIVATE: WEBSOCKET
    // --------------------------------------------------

    _sendMessage(msg) {
        this._transport?.sendJson(msg);
    }

    _activeLink() {
        if (this._mediaPath === 'ws') return null;
        return this._rtc?.isOpen?.() ? this._rtc : null;
    }

    _sendBinary(data) {
        if (!data) return false;
        const active = this._activeLink();
        if (active) {
            if (active.sendControl(data)) return true;
        }
        if (this._transport?.isOpen()) {
            this._transport.sendBytes(data);
            return true;
        }
        return false;
    }

    getTransportInfo() {
        const scores = this._currentScores();
        return {
            mode: this._transportMode,
            routeMode: this._routeMode,
            mediaPath: this._mediaPath,
            latencyMs: this._lastLatency,
            rtcConnected: !!this._activeLink()?.isOpen(),
            candidateType: this._rtcLink?.candidateType || null,
            rtcRttMs: this._rtcLink?.rttMs ?? null,
            rtcLossPct: this._rtcLink?.lossPct ?? null,
            rtcJitterMs: this._rtcLink?.jitterMs ?? null,
            wsLossPct: this._wsQuality.lossPct,
            wsJitterMs: this._wsQuality.jitterMs,
            scores,
            routes: this.getRouteStats(),
            turnConfigured: this._iceServers.some((e) => String(e.urls || '').startsWith('turn')),
            webrtcSupported: typeof RTCPeerConnection !== 'undefined',
        };
    }

    setRouteMode(mode) {
        if (mode === 'p2p' || mode === 'turn') mode = 'rtc';
        if (!['auto', 'ws', 'rtc'].includes(mode)) return false;
        if (this._initialProbeTimer) {
            clearTimeout(this._initialProbeTimer);
            this._initialProbeTimer = null;
        }
        if (mode === this._routeMode) {
            if (mode === 'rtc' && this._isConnected && this._mediaPath !== 'rtc') {
                console.log('[RDPClient] WebRTC re-requested while media on ws, retrying switch');
            } else {
                return true;
            }
        }
        this._routeMode = mode;
        this._transportMode = mode === 'ws' ? 'ws' : mode === 'auto' ? 'auto' : 'rtc';
        console.log(`[RDPClient] Route mode: ${mode}`);
        this._emit('transport', { mediaPath: this._mediaPath, mode: this._transportMode, routeMode: mode });
        if (!this._isConnected) {
            this._renderRoutePop();
            return true;
        }
        if (mode === 'ws') {
            this._downgradeToWs('manual');
            this._toast('Route: RELAY (WS)');
        } else if (mode === 'rtc') {
            if (this._mediaPath === 'rtc') {
                this._renderRoutePop();
                return true;
            }
            this._rtcFailCount = 0;
            this._rtcGiveUp = false;
            this._toast(this._standbyRtc?.isOpen?.() ? 'Switching to WebRTC…' : 'Connecting WebRTC…');
            this._probeRtc(false);
        } else {
            this._toast('Route: AUTO');
            this._rtcFailCount = 0;
            this._rtcGiveUp = false;
            this._maybeDowngradeRtc();
            setTimeout(() => this._autoPickBestRoute(), 300);
            if (this._mediaPath === 'ws') setTimeout(() => this._runRouteLoop(), 500);
        }
        this._renderRoutePop();
        return true;
    }

    _webrtcDetail() {
        const l = this._rtcLink || {};
        const nat = String(l.candidateType || '').toLowerCase();
        const local = String(l.localType || '').toLowerCase();
        const remote = String(l.remoteType || '').toLowerCase();
        const relay = nat === 'relay' || local === 'relay' || remote === 'relay';
        if (relay) return { path: 'turn', label: 'TURN', title: 'WebRTC via TURN relay' };
        if (nat === 'srflx' || local === 'srflx' || remote === 'srflx') {
            return { path: 'p2p', label: 'P2P · STUN', title: 'WebRTC P2P via STUN' };
        }
        if (nat === 'host' || local === 'host' || remote === 'host') {
            return { path: 'p2p', label: 'P2P', title: 'WebRTC P2P direct (host)' };
        }
        return { path: 'p2p', label: 'P2P · RTC', title: 'WebRTC DataChannel media path' };
    }

    getRouteStats() {
        const out = {};
        for (const [k, v] of Object.entries(this._routeStats)) {
            out[k] = { ...v };
        }
        const { ws, rtc } = this._currentScores();
        if (ws.rttMs !== null) {
            out.ws = { rttMs: ws.rttMs, lossPct: ws.lossPct, jitterMs: ws.jitterMs, score: ws.score, updatedAt: Date.now() };
        }
        if (rtc) {
            out.rtc = {
                ...(out.rtc || {}),
                rttMs: rtc.rttMs, lossPct: rtc.lossPct, jitterMs: rtc.jitterMs,
                score: rtc.score, updatedAt: Date.now(),
            };
        } else if (this._rtc?.isOpen?.() || this._standbyRtc?.isOpen?.() || this._pendingRtc) {
            out.rtc = { ...(out.rtc || {}), connected: true, updatedAt: Date.now() };
        }
        return out;
    }

    _routeAvailability() {
        const webrtc = typeof RTCPeerConnection !== 'undefined';
        return {
            ws: { ok: true, reason: '' },
            rtc: { ok: webrtc, reason: webrtc ? '' : 'browser has no WebRTC' },
        };
    }

    _fmtRouteMeta(s) {
        if (s == null || (s.rttMs == null && s.lossPct == null)) return s?.connected ? 'connected…' : 'measuring…';
        const parts = [];
        if (typeof s.rttMs === 'number') parts.push(`${s.rttMs}ms`);
        if (typeof s.lossPct === 'number') parts.push(`loss ${s.lossPct.toFixed(1)}%`);
        if (typeof s.jitterMs === 'number') parts.push(`jit ${s.jitterMs}ms`);
        return parts.join(' · ') || '—';
    }

    _toggleRoutePop() {
        if (!this._el?.routePop) return;
        const pop = this._el.routePop;
        const isOpen = pop.classList.toggle('open');
        this._el.transport?.setAttribute('aria-expanded', String(isOpen));
        if (!isOpen) return;
        this._renderRoutePop();
        // Move focus into the popup so it is reachable by keyboard.
        requestAnimationFrame(() => {
            pop.querySelector('.rdp-route-item:not(:disabled)')?.focus();
        });
    }

    _renderRoutePop() {
        const pop = this._el?.routePop;
        if (!pop) return;
        const stats = this.getRouteStats();
        const avail = this._routeAvailability();
        const detail = this._mediaPath === 'rtc' ? this._webrtcDetail() : null;
        const activeKey = this._mediaPath === 'rtc' ? 'rtc' : 'ws';
        const detailSuffix = detail ? ` · ${detail.label}` : '';
        const rows = [
            { mode: 'auto', name: 'AUTO' },
            { mode: 'rtc', name: 'WebRTC', key: 'rtc' },
            { mode: 'ws', name: 'RELAY', key: 'ws' },
        ];
        let html = `<div class="rdp-route-head">Route · click to switch (default AUTO)</div>`;
        for (const r of rows) {
            if (r.mode === 'auto') {
                const sel = this._routeMode === 'auto';
                html += `<button class="rdp-route-item${sel ? ' active' : ''}" data-route="auto">`
                    + `<span class="rdp-route-name">AUTO</span>`
                    + `<span class="rdp-route-meta">auto best · ${activeKey.toUpperCase()}${detailSuffix} now</span>`
                    + `${sel ? '<span class="rdp-route-check">●</span>' : ''}</button>`;
                continue;
            }
            const a = avail[r.mode];
            const s = stats[r.key] || {};
            let meta = a.ok ? this._fmtRouteMeta(s) : (a.reason || 'unavailable');
            if (r.mode === 'rtc' && detail && this._mediaPath === 'rtc') {
                meta = `${detail.label} · ${meta}`;
            }
            const sel = this._routeMode === r.mode;
            const cur = activeKey === r.mode ? ' · in use' : '';
            html += `<button class="rdp-route-item${sel ? ' active' : ''}" data-route="${r.mode}"${a.ok ? '' : ' disabled'}>`
                + `<span class="rdp-route-name">${r.name}</span>`
                + `<span class="rdp-route-meta">${meta}${cur}</span>`
                + `${sel ? '<span class="rdp-route-check">●</span>' : ''}</button>`;
        }
        pop.innerHTML = html;
        pop.querySelectorAll('[data-route]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const mode = btn.getAttribute('data-route');
                this.setRouteMode(mode);
            });
        });
    }

    _updateTransportBadge() {
        if (!this._el?.transport || !this._el?.transportText) return;
        const badge = this._el.transport;
        const text = this._el.transportText;
        let label = 'RELAY';
        let cls = 'rdp-transport rdp-transport-ws';
        let title = 'Media over WebSocket relay';
        if (this._mediaPath === 'rtc') {
            const detail = this._webrtcDetail();
            label = detail.label;
            title = detail.title;
            cls = 'rdp-transport rdp-transport-rtc';
        } else if (this._mediaPath === 'rtc-pending') {
            label = 'WebRTC…';
            title = 'WebRTC handshake in progress, media still on WS';
        }
        // Debounce rapid label changes: coalesce brief transitional states
        // (e.g. rtc-pending for a few hundred ms) so the badge doesn't flicker.
        this._badgePending = { label, cls, title };
        if (this._badgeTimer) clearTimeout(this._badgeTimer);
        this._badgeTimer = setTimeout(() => {
            this._badgeTimer = null;
            const p = this._badgePending;
            if (!p) return;
            this._badgeLabel = p.label;
            badge.className = p.cls;
            text.textContent = p.label;
            badge.title = p.title;
        }, 400);
    }

    _scoreLink({ rttMs, lossPct, jitterMs }) {
        // Missing metrics must NOT be treated as "perfect" (0), or a link with
        // no data would look better than one with real numbers. Use neutral
        // small penalties so WS and RTC are scored on the same footing.
        const rtt = typeof rttMs === 'number' ? rttMs : 9999;
        const loss = typeof lossPct === 'number' ? lossPct : 0;
        const jit = typeof jitterMs === 'number' ? jitterMs : 0;
        let score = rtt + loss * 120 + jit * 2;
        if (typeof lossPct !== 'number') score += 10;   // unknown loss: mild penalty
        if (typeof jitterMs !== 'number') score += 10;  // unknown jitter: mild penalty
        return score;
    }

    _isStableScore(s) {
        if (!s || typeof s.rttMs !== 'number') return false;
        if (s.lossPct !== null && s.lossPct !== undefined && s.lossPct > 10) return false;
        if (s.jitterMs !== null && s.jitterMs !== undefined && s.jitterMs > 200) return false;
        if (s.rttMs > 600) return false;
        return true;
    }

    _isBadScore(s) {
        if (!s || typeof s.rttMs !== 'number') return false;
        return (s.lossPct !== null && s.lossPct !== undefined && s.lossPct > 10)
            || (s.jitterMs !== null && s.jitterMs !== undefined && s.jitterMs > 200)
            || s.rttMs > 600;
    }

    _autoCooldownOk() {
        return Date.now() - (this._lastAutoSwitchAt || 0) >= (this._autoCooldownMs || 15000);
    }

    _markAutoSwitch() {
        this._lastAutoSwitchAt = Date.now();
    }

    _currentScores() {
        const wsRtt = this._recentRtt();
        const rtcRtt = this._recentRtcRtt();
        const rtcLive = rtcRtt != null && (
            this._mediaPath === 'rtc'
            || this._rtc?.isOpen?.()
            || this._standbyRtc?.isOpen?.()
        );
        const rtcMetrics = rtcLive ? {
            rttMs: rtcRtt,
            lossPct: this._rtcLink?.lossPct ?? null,
            jitterMs: this._rtcLink?.jitterMs ?? null,
        } : null;
        return {
            ws: {
                rttMs: wsRtt,
                lossPct: this._wsQuality.lossPct,
                jitterMs: this._wsQuality.jitterMs,
                score: wsRtt !== null ? this._scoreLink({
                    rttMs: wsRtt,
                    lossPct: this._wsQuality.lossPct,
                    jitterMs: this._wsQuality.jitterMs,
                }) : Infinity,
            },
            rtc: rtcMetrics ? {
                ...rtcMetrics,
                score: this._scoreLink(rtcMetrics),
            } : null,
        };
    }

    _recentRtt() {
        return this._medianFresh(this._rttValues, this._rttTimes, 15000,
            typeof this._wsQuality.lastRtt === 'number' ? this._wsQuality.lastRtt : null);
    }

    _recentRtcRtt() {
        return this._medianFresh(this._rtcRttValues, this._rtcRttTimes, 15000,
            typeof this._rtcLink?.rttMs === 'number' ? this._rtcLink.rttMs : null);
    }

    _medianFresh(values, times, maxAgeMs, fallback) {
        const now = performance.now();
        const fresh = [];
        for (let i = values.length - 1; i >= 0; i--) {
            if (now - times[i] > maxAgeMs) break;
            fresh.push(values[i]);
        }
        if (!fresh.length) return fallback;
        fresh.sort((a, b) => a - b);
        const mid = fresh.length >> 1;
        return fresh.length % 2 ? fresh[mid] : Math.round((fresh[mid - 1] + fresh[mid]) / 2);
    }

    _recordLatency(latency) {
        this._lastLatency = latency;
        this._updateWsPanel();
        this._updateTransportBadge();
        this._emit('latency', {
            latencyMs: latency,
            transport: this._mediaPath,
            jitterMs: this._wsQuality.jitterMs,
            lossPct: this._wsQuality.lossPct,
        });
        this._latSamples.push(latency);
        if (this._latSamples.length > 12) this._latSamples.shift();
        this._maybeRecoverScreen();
        this._maybeAutoSwitch();
        if (this._el?.routePop?.classList.contains('open')) this._renderRoutePop();
    }

    _maybeRecoverScreen() {
        if (!this._isConnected) return;
        // Never trigger during the connect/GFX-init warmup: the first samples
        // are skewed by worker init and RTC dialing, not by a real bad link.
        if (Date.now() - (this._connectedAt || 0) < (this._autoWarmupMs || 8000)) return;
        const q = this._wsQuality;
        const bad = (q.lossPct != null && q.lossPct > 15)
            || (q.jitterMs != null && q.jitterMs > 250)
            || (q.lastRtt != null && q.lastRtt > 800);
        if (!bad) {
            this._badStreak = 0;
            return;
        }
        this._badStreak = (this._badStreak || 0) + 1;
        if (this._badStreak < 5) return;
        this._badStreak = 0;
        this._forceRefresh('link-degraded');
    }

    _rtcCandidateScore() {
        const s = this._routeStats.rtc;
        if (s && typeof s.rttMs === 'number' && Date.now() - (s.updatedAt || 0) < 120000) {
            const lossPct = s.lossPct ?? 0;
            const jitterMs = s.jitterMs ?? 0;
            return {
                rttMs: s.rttMs, lossPct, jitterMs,
                score: typeof s.score === 'number' ? s.score : this._scoreLink({ rttMs: s.rttMs, lossPct, jitterMs }),
            };
        }
        return null;
    }

    _maybeAutoSwitch() {
        if (!this._isConnected) return;
        if (this._routeMode !== 'auto') return;
        if (this._latSamples.length < 3) return;
        if (Date.now() - (this._connectedAt || 0) < (this._autoWarmupMs || 8000)) return;
        const { ws } = this._currentScores();
        if (ws.rttMs === null) return;
        if (this._mediaPath === 'ws') {
            const anyLive = this._rtc?.isOpen?.() || this._pendingRtc || this._standbyRtc?.isOpen?.();
            if (anyLive) {
                this._autoPickBestRoute();
                return;
            }
            const rtc = this._rtcCandidateScore();
            if (rtc) {
                this._autoPickBestRoute();
                return;
            }
            if (this._rtcGiveUp) return;
            if (!this._isBadScore(ws)) return;
            if (!this._autoCooldownOk()) return;
            const q = ws.lossPct !== null
                ? `rtt ${ws.rttMs}ms loss ${ws.lossPct.toFixed(1)}% jit ${ws.jitterMs ?? '-'}ms`
                : `rtt ${ws.rttMs}ms`;
            console.log(`[RDPClient] Probing RTC (ws bad: ${q})`);
            this._probeRtc(true);
        } else if (this._mediaPath === 'rtc' && this._rtcLink?.rttMs != null) {
            this._maybeDowngradeRtc();
        }
    }

    _noteRtcFailed(reason) {
        this._rtcFailCount += 1;
        console.warn(`[RDPClient] RTC probe failed (${reason}), attempt ${this._rtcFailCount}/${this._rtcMaxRetries}`);
        if (this._rtcFailCount >= this._rtcMaxRetries) {
            this._rtcGiveUp = true;
            console.warn('[RDPClient] RTC giving up for this session, staying on WS relay (NAT/firewall likely blocks P2P: check TURN configured + UDP open; click WebRTC to retry)');
            this._updateTransportBadge();
        }
    }

    async _ensureIceServers() {
        if (this._iceServersReady) {
            try { await this._iceServersReady; } catch {}
            return;
        }
        this._iceServersReady = (async () => {
            const remote = await fetchIceServers(this.options.iceServersUrl || '/ice-servers');
            if (remote && remote.length) {
                const stuns = [];
                const turns = [];
                for (const s of remote) {
                    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
                    for (const u of urls) {
                        if (String(u || '').startsWith('turn')) {
                            turns.push({ urls: u, username: s.username, credential: s.credential });
                        } else if (String(u || '').startsWith('stun')) {
                            stuns.push(u);
                        }
                    }
                }
                if (stuns.length) this._stunUrls = [...new Set(stuns)];
                this._iceServers = [...this._iceServers, ...turns.filter((t) =>
                    !this._iceServers.some((e) => e.urls === t.urls))];
                const stunCount = stuns.length || this._stunUrls.length;
                const turnCount = this._iceServers.filter((e) => String(e.urls || '').startsWith('turn')).length;
                console.log(`[RDPClient] ICE servers: STUN x${stunCount} + TURN x${turnCount}`);
            }
        })();
        try { await this._iceServersReady; } catch {}
    }

    async _probeRtc(background = false) {
        if (!this._isConnected || !this._transport?.isOpen()) {
            if (!background) console.warn(`[RDPClient] RTC switch failed: signaling WS closed (connected=${!!this._isConnected}, wsOpen=${!!this._transport?.isOpen()})`);
            return;
        }
        if (this._rtc?.isOpen?.() || this._pendingRtc || this._standbyRtc?.isOpen?.()) {
            if (!background) {
                if (this._rtc?.isOpen?.() && this._mediaPath !== 'rtc') {
                    console.log('[RDPClient] RTC link already open but media on ws, upgrading now');
                    this._upgradeToRtc(this._rtc);
                } else if (this._standbyRtc?.isOpen?.() && !this._rtc?.isOpen?.()) {
                    this._adoptStandby();
                } else {
                    console.warn(`[RDPClient] RTC switch skipped: already live=${!!this._rtc?.isOpen?.()} pending=${!!this._pendingRtc} standby=${!!this._standbyRtc?.isOpen?.()} path=${this._mediaPath}`);
                }
            }
            return;
        }
        if (this._routeMode !== 'auto' && this._routeMode !== 'rtc') {
            if (!background) console.warn(`[RDPClient] RTC switch blocked: routeMode=${this._routeMode}, need rtc/auto`);
            return;
        }
        if (this._rtcGiveUp && background) {
            console.warn(`[RDPClient] RTC background probe skipped: gave up ${this._rtcFailCount}/${this._rtcMaxRetries}, click WebRTC to retry`);
            return;
        }
        if (this._rtcDialing && this._rtcDialing !== 'stale') {
            console.log('[RDPClient] RTC dial already in progress, joining');
            return;
        }
        await this._ensureIceServers();
        if (this._rtc?.isOpen?.() || this._pendingRtc || this._standbyRtc?.isOpen?.()) {
            this._rtcDialing = null;
            if (!background) {
                if (!this._adoptStandby()) console.warn(`[RDPClient] RTC switch skipped: race, another dial live=${!!this._rtc?.isOpen?.()} pending=${!!this._pendingRtc} standby=${!!this._standbyRtc?.isOpen?.()}`);
            }
            return;
        }
        this._rtcDialing = true;
        const turnCount = this._iceServers.filter((e) => String(e.urls || '').startsWith('turn')).length;
        console.log(`[RDPClient] Probing RTC (STUN x${this._stunUrls.length}${turnCount ? ` + TURN x${turnCount}` : ''}${background ? ' bg' : ''})`);
        const rtc = new RtcMediaTransport(this._transport, {
            iceServers: this._iceServers,
            background,
            timeoutMs: this.options.rtcTimeoutMs || 12000,
        });
        this._pendingRtc = rtc;
        const isMine = () => this._pendingRtc === rtc;
        const dropMine = () => { if (this._pendingRtc === rtc) this._pendingRtc = null; };
        rtc.onmedia = (e) => {
            if (this._rtc === rtc && this._mediaPath === 'rtc') this._handleMessage(e);
        };
        rtc.oncontrol = null;
        rtc.onstate = (st) => {
            if (st === 'open') {
                this._rtcDialing = null;
                if (background) this._finishBackgroundProbe(rtc);
                else this._upgradeToRtc(rtc);
            } else if (st === 'failed' || st === 'disconnected' || st === 'closed') {
                if (isMine()) {
                    dropMine();
                    this._rtcDialing = null;
                    if (!background) this._noteRtcFailed(st);
                }
                try { rtc.close(); } catch {}
            }
        };
        rtc.onerror = () => {
            if (isMine()) {
                dropMine();
                this._rtcDialing = null;
                if (!background) this._noteRtcFailed('error');
            }
            try { rtc.close(); } catch {}
        };
        try {
            await rtc.start();
        } catch (e) {
            if (isMine()) {
                dropMine();
                this._rtcDialing = null;
                if (!background) this._noteRtcFailed(`start-error: ${e?.message || e}`);
            }
            try { rtc.close(); } catch {}
        }
    }

    _adoptStandby() {
        const sb = this._standbyRtc;
        if (!sb || !sb.isOpen?.()) return false;
        if (this._rtc?.isOpen?.()) return true;
        this._upgradeToRtc(sb);
        return true;
    }

    _handleStandbyControl(data) {
        if (!(data instanceof ArrayBuffer)) return;
        this._handleMessage({ data });
    }

    _parkStandby() {
        const cur = this._rtc;
        if (!cur || !cur.isOpen?.()) return;
        if (this._rtcLink?.rttMs != null) {
            this._routeStats.rtc = {
                rttMs: this._rtcLink.rttMs,
                lossPct: this._rtcLink.lossPct ?? this._routeStats.rtc?.lossPct ?? null,
                jitterMs: this._rtcLink.jitterMs ?? this._routeStats.rtc?.jitterMs ?? null,
                score: this._scoreLink({
                    rttMs: this._rtcLink.rttMs,
                    lossPct: this._rtcLink.lossPct ?? 0,
                    jitterMs: this._rtcLink.jitterMs ?? 0,
                }),
                updatedAt: Date.now(),
            };
        }
        this._standbyRtc = cur;
        this._rtc = null;
        cur.onmedia = (e) => this._handleStandbyControl(e?.data);
        cur.startKeepalive?.(this._keepaliveMs);
        console.log(`[RDPClient] RTC parked standby (keepalive ${this._keepaliveMs}ms)`);
    }

    _dropRtc(reason) {
        for (const k of ['_pendingRtc', '_standbyRtc']) {
            const cur = this[k];
            if (cur) {
                try { cur.stopKeepalive?.(); } catch {}
                try { cur.close(); } catch {}
                this[k] = null;
            }
        }
        if (reason) console.log(`[RDPClient] RTC dropped (${reason})`);
    }

    async _finishBackgroundProbe(rtc) {
        let kept = false;
        try {
            const info = await rtc.getSelectedCandidateInfo();
            if (info && typeof info.rttMs === 'number') {
                const score = this._scoreLink(info);
                this._routeStats.rtc = {
                    rttMs: info.rttMs,
                    lossPct: info.lossPct ?? 0,
                    jitterMs: info.jitterMs ?? 0,
                    score, updatedAt: Date.now(),
                };
                console.log(`[RDPClient] RTC probe ok: rtt ${info.rttMs}ms loss ${(info.lossPct ?? 0).toFixed(1)}%`);
                this._standbyRtc = rtc;
                rtc.onmedia = (e) => this._handleStandbyControl(e?.data);
                rtc.startKeepalive?.(this._keepaliveMs);
                kept = true;
            } else {
                this._noteRtcFailed('no-stats');
            }
        } catch {
            this._noteRtcFailed('stats-error');
        }
        if (!kept) {
            try { rtc.close(); } catch {}
        }
        if (this._pendingRtc === rtc) this._pendingRtc = null;
        if (this._routeMode === 'auto') this._autoPickBestRoute();
        if (this._el?.routePop?.classList.contains('open')) this._renderRoutePop();
    }

    _autoPickBestRoute() {
        if (!this._isConnected || this._routeMode !== 'auto') return;
        if (this._mediaPath === 'rtc') {
            this._maybeDowngradeRtc();
            return;
        }
        const { ws } = this._currentScores();
        if (ws.rttMs === null) return;
        const rtc = this._rtcCandidateScore();
        if (!rtc) {
            if (this._isBadScore(ws) && this._autoCooldownOk() && !this._rtcGiveUp) {
                console.log(`[RDPClient] Auto route: ws bad but no rtc stats, probing`);
                this._markAutoSwitch();
                this._probeRtc(true);
            }
            return;
        }
        if (!this._isBadScore(ws)) return;
        if (!this._isStableScore(rtc)) {
            console.log(`[RDPClient] Auto route: ws bad but rtc unstable (rtt ${rtc.rttMs}ms loss ${(rtc.lossPct ?? 0).toFixed(1)}%), staying`);
            return;
        }
        // Switch only when RTC is MEASURABLY BETTER (>=15% lower score), not
        // merely because the current WS path looks bad.
        if (!(rtc.score < ws.score * 0.85)) {
            console.log(`[RDPClient] Auto route: ws bad but rtc not better (ws score ${Math.round(ws.score)} vs rtc ${Math.round(rtc.score)}), staying`);
            return;
        }
        if (!this._autoCooldownOk()) return;
        console.log(`[RDPClient] Auto route: rtc clearly better (ws score ${Math.round(ws.score)} -> rtc score ${Math.round(rtc.score)}), switching`);
        this._markAutoSwitch();
        this._rtcFailCount = 0;
        this._rtcGiveUp = false;
        if (this._standbyRtc?.isOpen?.()) this._adoptStandby();
        else this._probeRtc(false);
    }

    _startRouteLoop() {
        this._stopRouteLoop();
        this._routeTimer = setInterval(() => this._runRouteLoop(), this._routeIntervalMs);
        setTimeout(() => this._runRouteLoop(), 5000);
    }

    _stopRouteLoop() {
        if (this._routeTimer) {
            clearInterval(this._routeTimer);
            this._routeTimer = null;
        }
    }

    _closeRtc() {
        this._rtcDialing = null;
        if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
        for (const k of ['_pendingRtc', '_standbyRtc', '_rtc']) {
            const cur = this[k];
            if (cur) {
                try { cur.stopKeepalive?.(); } catch {}
                try { cur.close(); } catch {}
                this[k] = null;
            }
        }
    }

    async _runRouteLoop() {
        if (!this._isConnected || !this._transport?.isOpen()) return;
        await this._ensureIceServers();
        if (this._mediaPath === 'rtc') {
            const sb = this._standbyRtc;
            if (sb?.isOpen?.()) {
                const r = await sb.pingKeepalive().catch(() => null);
                if (r && typeof r.rttMs === 'number') {
                    this._recordRtcRouteStat(r.rttMs, null, null);
                }
            }
            if (this._el?.routePop?.classList.contains('open')) this._renderRoutePop();
            return;
        }
        if (this._rtc?.isOpen?.() || this._pendingRtc || this._standbyRtc?.isOpen?.()) {
            const sb = this._standbyRtc?.isOpen?.() ? this._standbyRtc : (this._rtc?.isOpen?.() ? this._rtc : null);
            if (sb) {
                const r = await sb.pingKeepalive().catch(() => null);
                if (r && typeof r.rttMs === 'number') {
                    this._recordRtcRouteStat(r.rttMs, null, null);
                } else {
                    const info = await sb.getSelectedCandidateInfo?.().catch(() => null);
                    if (info && typeof info.rttMs === 'number') {
                        this._recordRtcRouteStat(info.rttMs, info.lossPct, info.jitterMs);
                    }
                }
            }
            if (this._el?.routePop?.classList.contains('open')) this._renderRoutePop();
            return;
        }
        const s = this._routeStats.rtc;
        if (s && Date.now() - s.updatedAt < this._routeIntervalMs) return;
        if (this._routeMode === 'ws') return;
        this._probeRtc(true);
    }

    switchRoute(route, auto = false) {
        if (route === 'p2p' || route === 'turn') route = 'rtc';
        if (!['ws', 'rtc'].includes(route)) {
            console.warn(`[RDPClient] Switch route ignored: bad route=${route}`);
            return false;
        }
        if (this._initialProbeTimer) {
            clearTimeout(this._initialProbeTimer);
            this._initialProbeTimer = null;
        }
        if (!this._isConnected) {
            console.warn(`[RDPClient] Switch route to ${route} failed: RDP not connected`);
            return false;
        }
        if (route === 'ws') {
            this._downgradeToWs(auto ? 'auto' : 'manual');
            return true;
        }
        if (this._mediaPath === 'rtc') {
            console.log('[RDPClient] Switch route: already on rtc');
            return true;
        }
        if (this._mediaPath === 'rtc-pending') {
            console.log('[RDPClient] Switch route: handshake already in progress, waiting for rtc-active');
            return true;
        }
        if (this._standbyRtc?.isOpen?.()) {
            console.log('[RDPClient] Switch route: ws -> rtc (standby, instant)');
            this._adoptStandby();
            return true;
        }
        if (this._rtc?.isOpen?.()) {
            console.log('[RDPClient] Switch route: ws -> rtc (live, instant)');
            this._upgradeToRtc(this._rtc);
            return true;
        }
        if (this._pendingRtc) {
            console.log('[RDPClient] Switch route: dial already in progress, waiting for DC open/timeout');
            return true;
        }
        const turnCount = this._iceServers.filter((e) => String(e.urls || '').startsWith('turn')).length;
        console.log(`[RDPClient] Switch route: ws -> rtc (dial, STUN x${this._stunUrls.length}${turnCount ? ` + TURN x${turnCount}` : ' no TURN'} fail=${this._rtcFailCount}/${this._rtcMaxRetries}${this._rtcGiveUp ? ' giveUp-reset' : ''})`);
        this._rtcFailCount = 0;
        this._rtcGiveUp = false;
        setTimeout(() => this._probeRtc(false), 100);
        return true;
    }

    _upgradeToRtc(rtc) {
        if (!this._isConnected) {
            console.warn('[RDPClient] RTC switch failed: disconnected before rtc-upgrade sent');
            try { rtc.close(); } catch {}
            if (this._pendingRtc === rtc) this._pendingRtc = null;
            return;
        }
        if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
        this._rtc = rtc;
        this._upgradeRetries = 0;
        if (this._standbyRtc === rtc) this._standbyRtc = null;
        if (this._pendingRtc === rtc) this._pendingRtc = null;
        this._mediaPath = 'rtc-pending';
        this._rtcLink = { candidateType: null, rttMs: null, jitterMs: null, lossPct: null };
        this._updateTransportBadge();
        rtc.onmedia = (e) => {
            if (this._activeLink() === rtc && this._mediaPath !== 'ws') this._handleMessage(e);
        };
        rtc.oncontrol = null;
        const onDead = (why) => {
            if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
            const wasActive = this._activeLink() === rtc || this._rtc === rtc;
            if (wasActive) {
                this._parkStandby();
                this._downgradeToWs(why);
                // If the user explicitly chose WebRTC, keep trying to restore it
                // instead of silently staying on WS.
                if (this._routeMode === 'rtc' && !this._manualDisconnect && this._isConnected) {
                    setTimeout(() => {
                        if (this._isConnected && this._routeMode === 'rtc' && this._mediaPath !== 'rtc') {
                            console.log('[RDPClient] Manual WebRTC route lost, re-dialing…');
                            this._rtcFailCount = 0;
                            this._rtcGiveUp = false;
                            this._probeRtc(false);
                        }
                    }, 1500);
                }
            } else {
                this._dropRtc(why);
            }
        };
        // Transient states (ICE restart / brief blip) can recover. Give the
        // link a grace period before tearing down, to avoid P2P<->WS flapping.
        const onTransient = (why) => {
            if (this._graceTimer) return;
            console.warn(`[RDPClient] RTC ${why}, waiting ${this._graceMs}ms for recovery…`);
            this._graceTimer = setTimeout(() => {
                this._graceTimer = null;
                const stillDown = !rtc.isOpen?.();
                if (stillDown) onDead(why);
                else console.log('[RDPClient] RTC recovered from transient state');
            }, this._graceMs);
        };
        rtc.onstate = (st) => {
            if (st === 'failed' || st === 'closed') {
                onDead(`dc-${st}`);
            } else if (st === 'disconnected' || st === 'media-closed' || st === 'control-closed') {
                onTransient(`dc-${st}`);
            }
        };
        rtc.onerror = () => onDead('rtc-error');
        this._sendMessage({ type: 'rtc-upgrade', route: 'rtc' });
        console.log('[RDPClient] RTC DC open, media upgrading');
    }

    async _refreshRtcLink() {
        const active = this._activeLink();
        if (!active) return;
        try {
            const info = await active.getSelectedCandidateInfo();
            const prev = this._rtcLink?.rttMs;

            // Datachannel-only connections often have no usable candidate-pair
            // currentRoundTripTime. Fall back to a control-channel keepalive
            // round-trip, which always measures the real media path.
            let rttMs = info && typeof info.rttMs === 'number' ? info.rttMs : null;
            if (rttMs == null && typeof active.pingKeepalive === 'function') {
                const kp = await active.pingKeepalive().catch(() => null);
                if (kp && typeof kp.rttMs === 'number') rttMs = kp.rttMs;
            }

            this._rtcLink = {
                candidateType: info?.candidateType ?? this._rtcLink?.candidateType ?? null,
                localType: info?.localType ?? this._rtcLink?.localType ?? null,
                remoteType: info?.remoteType ?? this._rtcLink?.remoteType ?? null,
                rttMs,
                jitterMs: info?.jitterMs ?? this._rtcLink?.jitterMs ?? null,
                lossPct: info?.lossPct ?? this._rtcLink?.lossPct ?? null,
            };
            this._updateTransportBadge();

            const l = this._rtcLink;
            const relay = String(l.candidateType || '').toLowerCase() === 'relay'
                || String(l.localType || '').toLowerCase() === 'relay'
                || String(l.remoteType || '').toLowerCase() === 'relay';
            const tag = relay ? 'TURN' : 'P2P';

            // Keep a separate rolling RTT window for RTC (do NOT mix with the
            // WS window, or the WS score would be corrupted by RTC samples).
            if (typeof rttMs === 'number') {
                const now = performance.now();
                this._rtcRttTimes.push(now);
                this._rtcRttValues.push(rttMs);
                if (this._rtcRttValues.length > 30) { this._rtcRttTimes.shift(); this._rtcRttValues.shift(); }
                // Derive jitter/loss from the RTC window when the candidate-pair
                // stats don't expose them, so RTC and WS are scored the same way.
                if (l.jitterMs == null || l.lossPct == null) {
                    const derived = this._deriveLinkQuality(this._rtcRttValues, this._rtcRttTimes);
                    if (l.jitterMs == null) l.jitterMs = derived.jitterMs;
                    if (l.lossPct == null) l.lossPct = derived.lossPct;
                }
                this._routeStats.rtc = {
                    ...(this._routeStats.rtc || {}),
                    rttMs, lossPct: l.lossPct, jitterMs: l.jitterMs,
                    score: this._scoreLink({ rttMs, lossPct: l.lossPct, jitterMs: l.jitterMs }),
                    updatedAt: Date.now(),
                };
                this._lastLatency = rttMs;
                const extra = [];
                if (l.lossPct != null && l.lossPct > 0.5) extra.push(`loss ${l.lossPct.toFixed(1)}%`);
                if (l.jitterMs != null && l.jitterMs > 30) extra.push(`jit ${l.jitterMs}ms`);
                const suffix = extra.length ? ` · ${extra.join(' · ')}` : '';
                this._setMetric('latency', `${rttMs}ms`, `Latency ${rttMs}ms (${tag}${suffix})`);
                this._emit('latency', {
                    latencyMs: rttMs, transport: 'rtc',
                    lossPct: l.lossPct ?? null, jitterMs: l.jitterMs ?? null,
                });
            }
            if (typeof prev === 'number' && typeof rttMs === 'number') {
                this._maybeDowngradeRtc();
            }
        } catch {}
    }

    _maybeDowngradeRtc() {
        if (this._routeMode !== 'auto' || this._mediaPath !== 'rtc') return;
        // Don't re-evaluate immediately after a switch: WS stats are still the
        // pre-switch samples and would cause an instant bounce back.
        if (Date.now() - (this._lastAutoSwitchAt || 0) < (this._autoWarmupMs || 8000)) return;
        const { ws, rtc } = this._currentScores();
        if (!rtc || rtc.rttMs === null) return;
        if (ws.rttMs === null) return;
        // Only fall back when WS is MEASURABLY BETTER than the current RTC path.
        // An absolutely-bad RTC link is not a reason to switch if WS is not
        // actually better (e.g. both paths are poor).
        const wsBetter = ws.score < rtc.score * 0.85;
        if (!wsBetter) return;
        if (!this._isStableScore(ws)) {
            console.log(`[RDPClient] Auto route: rtc degraded but ws not stable yet (rtc score ${Math.round(rtc.score)} vs ws ${Math.round(ws.score)}), staying`);
            return;
        }
        if (!this._autoCooldownOk()) return;
        this._markAutoSwitch();
        console.warn(`[RDPClient] Auto route: WS clearly better (ws rtt ${ws.rttMs}ms score ${Math.round(ws.score)} vs rtc rtt ${rtc.rttMs}ms score ${Math.round(rtc.score)}), falling back`);
        this._downgradeToWs('auto-better-ws');
    }

    _confirmMediaPath(path, link = null) {
        const changed = this._mediaPath !== path;
        this._mediaPath = path;
        if (path === 'rtc') {
            this._rtcFailCount = 0;
            this._rtcGiveUp = false;
            if (link) this._rtcLink = link;
        }
        if (changed) {
            console.log(`[RDPClient] Media path confirmed: ${path}`, {
                routeMode: this._routeMode,
                rtcOpen: !!this._rtc?.isOpen?.(),
            });
            // Decide whether to repaint based on loss seen BEFORE the switch, then
            // clear the worker's frame-ID baseline so the new path's frame
            // numbering is not misreported as a gap (丢帧).
            const needRefresh = this._shouldRefreshOnSwitch();
            this._resetWorkerFrameTracking();
            if (needRefresh) {
                this._forceRefresh(`path->${path}`);
            } else {
                console.log('[RDPClient] Clean path switch, no refresh needed');
            }
        }
        // Apply any resize that was deferred while the switch was in flight.
        if (this._pendingResizeCheck) {
            this._pendingResizeCheck = false;
            clearTimeout(this._resizeTimeout);
            this._resizeTimeout = setTimeout(() => {
                if (this._isConnected && this._mediaPath !== 'rtc-pending' && !this._rtcDialing) {
                    this._handleResize();
                }
            }, 800);
        }
        this._updateTransportBadge();
        if (path === 'rtc') {
            this._refreshRtcLink();
        } else {
            if (this._rtc?.isOpen?.()) this._parkStandby();
            this._rtcLink = { candidateType: null, rttMs: null, jitterMs: null, lossPct: null };
            this._updateTransportBadge();
        }
        this._emit('transport', { mediaPath: path, mode: this._transportMode, routeMode: this._routeMode });
        if (path === 'ws' && this._routeMode === 'rtc' && !this._activeLink()) {
            const anyLive = this._rtc?.isOpen?.() || this._standbyRtc?.isOpen?.() || this._pendingRtc;
            if (!anyLive) console.warn('[RDPClient] WebRTC requested but unavailable, staying on WS');
        }
    }

    _downgradeToWs(reason) {
        const active = this._activeLink();
        if (this._pendingRtc && this._pendingRtc !== active) {
            try { this._pendingRtc.close(); } catch {}
            this._pendingRtc = null;
        }
        if (this._mediaPath === 'ws') {
            return;
        }
        console.warn(`[RDPClient] Downgrading media to WS (${reason})`, {
            routeMode: this._routeMode,
            mediaPath: this._mediaPath,
            sinceAutoSwitch: Date.now() - (this._lastAutoSwitchAt || 0),
            rtcOpen: !!this._rtc?.isOpen?.(),
            standbyOpen: !!this._standbyRtc?.isOpen?.(),
            stack: new Error().stack.split('\n').slice(2, 5).join(' | '),
        });
        const needRefresh = this._shouldRefreshOnSwitch()
            || /failed|error|closed|disconnected/.test(String(reason));
        try { this._sendMessage({ type: 'rtc-downgrade' }); } catch {}
        if (this._mediaPath === 'rtc' || this._mediaPath === 'rtc-pending') this._parkStandby();
        if (this._rtc) { try { this._rtc.close(); } catch {} }
        this._rtc = null;
        this._mediaPath = 'ws';
        this._rtcLink = { candidateType: null, rttMs: null, jitterMs: null, lossPct: null };
        // WS and RTC number frames independently; clear the worker baseline so
        // the resumed WS stream is not flagged as a frame gap.
        this._resetWorkerFrameTracking();
        if (needRefresh) this._forceRefresh(`downgrade:${reason}`);
        this._updateTransportBadge();
        this._emit('transport', { mediaPath: 'ws', mode: this._transportMode, routeMode: this._routeMode, reason });
        if (this._el?.routePop?.classList.contains('open')) this._renderRoutePop();
    }

    _handleRtcSignal(msg) {
        const rtc = this._pendingRtc ?? this._rtc ?? this._standbyRtc;
        switch (msg.type) {
            case 'rtc-answer':
                rtc?.handleAnswer(msg.sdp, msg.offerId ?? null);
                break;
            case 'rtc-ice':
                if (msg.offerId !== undefined && msg.offerId !== null) {
                    const mine = this._pendingRtc ?? this._rtc ?? this._standbyRtc;
                    if (mine && msg.offerId !== mine._pendingOfferId && mine._pendingOfferId !== null) break;
                }
                rtc?.handleRemoteIce(msg.candidate);
                break;
            case 'rtc-active':
                if (msg.transport === 'rtc') {
                    const link = this._rtc ?? this._standbyRtc ?? this._pendingRtc;
                    if (link?.isOpen?.()) {
                        if (this._routeMode === 'ws') {
                            // User explicitly forced RELAY: ignore a late RTC
                            // upgrade and tell the server to fall back.
                            console.log('[RDPClient] Ignoring rtc-active: user forced WS route');
                            this._parkStandby();
                            try { this._sendMessage({ type: 'rtc-downgrade' }); } catch {}
                            this._confirmMediaPath('ws');
                            break;
                        }
                        if (this._standbyRtc === link) this._standbyRtc = null;
                        if (this._pendingRtc === link) this._pendingRtc = null;
                        this._rtc = link;
                        this._confirmMediaPath('rtc');
                    } else {
                        console.warn(`[RDPClient] RTC switch failed: server said rtc-active but no open DC (live=${!!this._rtc?.isOpen?.()} pending=${!!this._pendingRtc} standby=${!!this._standbyRtc?.isOpen?.()})`);
                        this._noteRtcFailed('no-open-dc-on-active');
                        this._confirmMediaPath('ws');
                    }
                } else {
                    // Server said "still ws": likely it hadn't registered the
                    // media sender yet (offer race). If our DC is open, retry
                    // the upgrade a few times before giving up, so we don't
                    // flap P2P -> WS on a transient handshake race.
                    const link = this._rtc ?? this._standbyRtc ?? this._pendingRtc;
                    const tries = (this._upgradeRetries || 0);
                    if (link?.isOpen?.() && tries < 3 && this._routeMode !== 'ws') {
                        this._upgradeRetries = tries + 1;
                        console.warn(`[RDPClient] Server kept media on WS, retrying rtc-upgrade (${this._upgradeRetries}/3)…`);
                        setTimeout(() => {
                            if (link?.isOpen?.() && this._isConnected) {
                                this._sendMessage({ type: 'rtc-upgrade', route: 'rtc' });
                            }
                        }, 500);
                        break;
                    }
                    this._upgradeRetries = 0;
                    if (this._mediaPath === 'rtc-pending' && this._routeMode === 'rtc') {
                        console.warn('[RDPClient] RTC switch failed: server kept media on WS (stale session/sender?) - closing stale DC, next click will re-dial; check backend logs');
                        this._closeRtc();
                    } else if (this._routeMode === 'rtc' || !this._pendingRtc) {
                        console.warn(`[RDPClient] RTC switch failed: server kept media on WS (mode=${this._routeMode}, no sender/session?)`);
                    }
                    this._noteRtcFailed('server-kept-ws');
                    this._confirmMediaPath('ws');
                }
                break;
            case 'rtc-unavailable':
                console.warn('[RDPClient] RTC switch failed: server rtc-unavailable (no session/sender)');
                this._noteRtcFailed('rtc-unavailable');
                this._dropRtc('rtc-unavailable');
                this._confirmMediaPath('ws');
                break;
        }
    }

    _handleMessage(event) {
        if (event.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(event.data);
            
            // Audio - always handle on main thread
            if (matchMagic(bytes, Magic.OPUS)) {
                this._handleOpusFrame(bytes);
                return;
            }
            if (matchMagic(bytes, Magic.AUDI)) {
                this._handleAudioFrame(bytes);
                return;
            }
            
            // Pointer/cursor updates - handle on main thread (no GFX worker needed)
            if (matchMagic(bytes, Magic.PPOS)) {
                const msg = parsePointerPosition(bytes);
                if (msg) {
                    // Server-side cursor positioning (shadow cursor mode)
                    // Most browsers don't allow setting cursor position
                }
                return;
            }
            if (matchMagic(bytes, Magic.PSYS)) {
                const msg = parsePointerSystem(bytes);
                if (msg) {
                    // System pointer: 0=NULL (hide), 1=DEFAULT (arrow)
                    this._canvas.style.cursor = msg.ptrType === 0 ? 'none' : 'default';
                }
                return;
            }
            if (matchMagic(bytes, Magic.PSET)) {
                const msg = parsePointerSet(bytes);
                if (msg) {
                    this._setCustomCursor(msg.width, msg.height, msg.hotspotX, msg.hotspotY, msg.bgraData);
                }
                return;
            }
            
            // When using GFX worker, route ALL non-audio frames to worker
            // (canvas is transferred, so main thread cannot draw)
            if (this._gfxWorkerReady && this._sendToGfxWorker(event.data)) {
                return;
            }
            
            // If worker exists but not ready yet, queue frames
            // (canvas is transferred, but worker hasn't confirmed ready)
            if (this._gfxWorker && this._useOffscreenCanvas && !this._gfxWorkerReady) {
                this._pendingGfxMessages.push({
                    msg: { type: 'binary', data: event.data },
                    transfer: [event.data]
                });
                return;
            }
            
            // Main thread fallback (when worker not available)
            this._handleFrameUpdate(event.data);
            return;
        }

        try {
            const msg = JSON.parse(event.data);
            switch (msg.type) {
                case 'connected':
                    this._handleConnected(msg);
                    break;
                case 'resize':
                    this._handleServerResize(msg.width, msg.height);
                    break;
                case 'pong':
                    this._handlePong(msg);
                    break;
                case 'clipboard':
                    this._handleRemoteClipboard(msg.text);
                    break;
                case 'rtc-answer':
                case 'rtc-ice':
                case 'rtc-active':
                case 'rtc-unavailable':
                    this._handleRtcSignal(msg);
                    break;
                case 'error':
                    this._handleError(msg.message);
                    break;
                case 'disconnected':
                    this._handleDisconnect();
                    break;
            }
        } catch (e) {
            console.error('[RDPClient] Parse error:', e);
        }
    }

    /**
     * Check if message is a new GFX event stream format
     */
    _isGfxEventMessage(bytes) {
        if (bytes.length < 4) return false;
        
        return matchMagic(bytes, Magic.SURF) ||
               matchMagic(bytes, Magic.DELS) ||
               matchMagic(bytes, Magic.STFR) ||
               matchMagic(bytes, Magic.ENFR) ||
               matchMagic(bytes, Magic.PROG) ||
               matchMagic(bytes, Magic.WEBP) ||
               matchMagic(bytes, Magic.TILE) ||
               matchMagic(bytes, Magic.SFIL) ||
               matchMagic(bytes, Magic.S2SF) ||
               matchMagic(bytes, Magic.C2SF);
    }

    _handleConnected(msg) {
        this._isConnected = true;
        this._connectedAt = Date.now();
        this._lastFrameGapAt = 0;
        this._frameGapCount = 0;
        this._lastRefreshAt = 0;
        this._reconnectAttempts = 0;
        this._clearReconnectTimer();
        this._mediaPath = 'ws';
        this._latSamples = [];
        this._rtcLink = { candidateType: null, rttMs: null, jitterMs: null, lossPct: null };
        this._wsQuality = { sent: 0, lost: 0, jitterMs: null, lossPct: null, lastRtt: null, window: [] };
        this._pingSeq = 0;
        this._pingPending = new Map();
        this._rttTimes = [];
        this._rttValues = [];
        this._rtcRttTimes = [];
        this._rtcRttValues = [];
        // Fresh session: no key can still be logically held on the remote.
        this._pressedKeys.clear();
        this._updateTransportBadge();
        this._updateStatus('connected', 'Connected');
        this._el.canvas.style.display = 'block';
        this._el.loading.style.display = 'none';
        this._setLoadingMode('idle');
        this._el.btnDisconnect.disabled = false;
        this._el.btnKeyboard.disabled = false;
        this._el.btnMute.disabled = false;
        this._el.btnScreenshot.disabled = false;
        this._el.btnClipboard.disabled = false;
        this._focusInput();
        // Live session: let the floating chrome fade away when idle.
        this._syncChromeAutohide();

        this._initAudio();

        if (msg.width && msg.height) {
            this._handleServerResize(msg.width, msg.height);
        }

        // Initialize GFX worker with canvas
        // Note: We only transfer canvas control on connect, not earlier,
        // because the canvas dimensions need to match the session size
        this._initGfxWorkerCanvas(msg.width || this._canvas.width,
                                  msg.height || this._canvas.height);

        if (this._pingTimer) clearInterval(this._pingTimer);
        this._pingTimer = setInterval(() => this._sendPing(), this._pingIntervalMs);
        this._sendPing();
        this._rtcFailCount = 0;
        this._rtcGiveUp = false;
        this._startRouteLoop();
        this._rtcDialing = null;
        if (this._initialProbeTimer) clearTimeout(this._initialProbeTimer);
        if (this._routeMode === 'rtc' || this._routeMode === 'auto') {
            this._initialProbeTimer = setTimeout(() => {
                this._initialProbeTimer = null;
                this._probeRtc(false);
            }, 1500);
        }
        
        this._emit('connected', { width: msg.width, height: msg.height });
        
        if (this._pendingConnect) {
            this._pendingConnect.resolve();
            this._pendingConnect = null;
        }
    }

    _handleDisconnect() {
        const failedConnect = !!this._pendingConnect || this._connectFailed;
        if (this._pendingConnect) {
            const reason = this._lastError || 'Connection closed before establishing session';
            try { this._pendingConnect.reject(new Error(reason)); } catch {}
            this._pendingConnect = null;
            this._lastError = reason;
            this._connectFailed = true;
        }
        const hadError = this._connectFailed;
        this._isConnected = false;
        this._transport = null;
        this._closeRtc();
        this._mediaPath = 'ws';
        this._latSamples = [];
        this._rtcLink = { candidateType: null, rttMs: null, jitterMs: null, lossPct: null };
        this._wsQuality = { sent: 0, lost: 0, jitterMs: null, lossPct: null, lastRtt: null, window: [] };
        this._pingPending = new Map();
        this._rttTimes = [];
        this._rttValues = [];
        this._rtcRttTimes = [];
        this._rtcRttValues = [];
        if (this._badgeTimer) { clearTimeout(this._badgeTimer); this._badgeTimer = null; }
        this._updateTransportBadge();
        this._stopRouteLoop();
        if (this._el?.routePop) this._el.routePop.classList.remove('open');
        this._el?.transport?.setAttribute('aria-expanded', 'false');
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
        this._lastRequestedWidth = 0;
        this._lastRequestedHeight = 0;
        if (hadError) {
            this._updateStatus('error', 'Error');
            this._el.canvas.style.display = 'none';
            this._el.loading.style.display = 'none';
            this._setLoadingMode('idle');
        } else {
            this._updateStatus('disconnected', 'Disconnected');
            this._el.canvas.style.display = 'none';
            this._el.loading.style.display = 'block';
            this._el.loading.querySelector('p').textContent = 'Click to connect';
            this._setLoadingMode('idle');
        }
        this._el.btnDisconnect.disabled = true;
        this._el.btnKeyboard.disabled = true;
        this._el.btnMute.disabled = true;
        this._el.btnScreenshot.disabled = true;
        this._el.btnClipboard.disabled = true;
        
        // Hide virtual keyboard on disconnect
        this.hideKeyboard();
        // No live session: pin the chrome back in place.
        this._syncChromeAutohide();

        // Drop any locally tracked key-down state: the session is gone, so the
        // remote will not receive further key-ups from this client.
        this._pressedKeys.clear();
        this._resetKeyboardModifiers();
        
        this._cleanupAudio();
        this._cleanupGfxWorker();
        
        this._emit('disconnected');

        if (!this._manualDisconnect && this._autoReconnect) {
            this._scheduleReconnect();
            if (this._reconnectTimer) { this._connectFailed = false; return; }
        }
        if (this.options.keepConnectionModalOpen || failedConnect) {
            this._showModal();
        }
        this._connectFailed = false;
        
        // Clear disconnect timeout
        if (this._disconnectTimeout) {
            clearTimeout(this._disconnectTimeout);
            this._disconnectTimeout = null;
        }
        
        // Resolve pending disconnect promise
        if (this._pendingDisconnect) {
            this._pendingDisconnect.resolve();
            this._pendingDisconnect = null;
        }
    }
    
    /**
     * Clean up GFX worker
     */
    _cleanupGfxWorker() {
        if (this._gfxWorker) {
            this._gfxWorker.terminate();
            this._gfxWorker = null;
        }
        this._gfxWorkerReady = false;
        this._pendingGfxMessages = [];
        
        // Re-acquire canvas context for next connection
        // (transferControlToOffscreen is one-way, so we need to recreate canvas)
        if (this._useOffscreenCanvas && this._el.canvas) {
            const parent = this._el.canvas.parentElement;
            const oldCanvas = this._el.canvas;
            const newCanvas = document.createElement('canvas');
            newCanvas.className = oldCanvas.className;
            newCanvas.width = oldCanvas.width;
            newCanvas.height = oldCanvas.height;
            newCanvas.style.display = oldCanvas.style.display;
            newCanvas.setAttribute('tabindex', '0');
            parent.replaceChild(newCanvas, oldCanvas);
            this._el.canvas = newCanvas;
            this._canvas = newCanvas;
            // Note: Do NOT acquire 2D context here - _initGfxWorker will handle it
            // or _initGfxWorkerCanvas will acquire context if transfer fails
            
            // Re-attach event listeners to new canvas
            this._canvas.addEventListener('click', () => this._focusInput());
            this._canvas.addEventListener('mousemove', (e) => this._handleMouseMove(e));
            this._canvas.addEventListener('mousedown', (e) => this._handleMouseDown(e));
            this._canvas.addEventListener('mouseup', (e) => this._handleMouseUp(e));
            this._canvas.addEventListener('wheel', (e) => this._handleMouseWheel(e));
            this._canvas.addEventListener('contextmenu', (e) => e.preventDefault());
            
            // Re-initialize worker for next connection
            this._initGfxWorker();
        }
    }

    _handleError(message) {
        const reason = (message && String(message).trim()) || 'Connection error';
        console.error('[RDPClient] Error:', reason);
        this._lastError = reason;
        this._updateStatus('error', 'Error');
        this._emit('error', { message: reason });

        // If we have a pending connect promise (connection attempt failed),
        // reject it and close the transport to allow retry
        if (this._pendingConnect) {
            this._pendingConnect.reject(new Error(reason));
            this._pendingConnect = null;
            this._connectFailed = true;

            // Close the transport to allow reconnection attempts
            if (this._transport) {
                this._transport.close();
                // Note: _handleDisconnect will be called by onclose handler
            }
            return;
        }
        if (!this._isConnected && this._autoReconnect && !this._manualDisconnect && this._lastCredentials) {
            this._scheduleReconnect();
        }
        // If already connected, just emit the error - don't force disconnect
    }

    _sendPing() {
        if (!this._isConnected) return;
        if (this._mediaPath === 'rtc' && this._activeLink()) {
            this._refreshRtcLink();
        }
        this._pingSeq += 1;
        const seq = this._pingSeq;
        this._pingPending.set(seq, performance.now());
        if (this._pingPending.size > 20) {
            const oldest = Math.min(...this._pingPending.keys());
            this._pingPending.delete(oldest);
        }
        this._wsQuality.sent += 1;
        this._sendMessage({ type: 'ping', seq });
        setTimeout(() => {
            if (this._pingPending.delete(seq)) {
                this._wsQuality.lost += 1;
                this._recordPingOutcome(true);
                if (seq === this._pingSeq) this._markLatencyStale();
                this._maybeAutoSwitch();
            }
        }, this._pingTimeoutMs);
    }

    _markLatencyStale() {
        const last = this._wsQuality.lastRtt;
        if (last == null) return;
        const extra = [];
        if (this._wsQuality.lossPct != null && this._wsQuality.lossPct > 0.5) {
            extra.push(`loss ${this._wsQuality.lossPct.toFixed(1)}%`);
        }
        const suffix = extra.length ? ` (${extra.join(' · ')})` : '';
        this._setMetric('latency', `${last}ms`, `Latency ${last}ms${suffix}`);
    }

    _updateWsLoss() {
        const win = this._wsQuality.window || (this._wsQuality.window = []);
        if (!win.length) {
            this._wsQuality.lossPct = null;
            return;
        }
        const lost = win.reduce((a, b) => a + b, 0);
        this._wsQuality.lossPct = (lost / win.length) * 100;
    }

    _recordPingOutcome(lost) {
        const win = this._wsQuality.window || (this._wsQuality.window = []);
        win.push(lost ? 1 : 0);
        if (win.length > 30) win.shift();
        this._updateWsLoss();
    }

    _handlePong(msg) {
        const now = performance.now();
        let latency;
        if (msg && typeof msg.seq === 'number' && this._pingPending.has(msg.seq)) {
            latency = Math.round(now - this._pingPending.get(msg.seq));
            this._pingPending.delete(msg.seq);
            this._recordPingOutcome(false);
        } else {
            return;
        }
        this._wsQuality.lastRtt = latency;
        this._wsQuality.lastRttAt = now;
        this._rttTimes.push(now);
        this._rttValues.push(latency);
        if (this._rttValues.length > 30) {
            this._rttTimes.shift();
            this._rttValues.shift();
        }
        this._wsQuality.jitterMs = this._computeRttJitter();
        if (this._mediaPath === 'rtc' || this._mediaPath === 'rtc-pending') {
            this._latSamples.push(latency);
            if (this._latSamples.length > 12) this._latSamples.shift();
            this._maybeDowngradeRtc();
            // Do NOT overwrite the latency panel here: RTC latency is written
            // by _refreshRtcLink. Writing the WS value too would make the
            // bottom-right latency flicker between WS and RTC every ping.
            if (this._el?.routePop?.classList.contains('open')) this._renderRoutePop();
            return;
        }
        this._recordLatency(latency);
    }

    _computeRttJitter() {
        const n = this._rttValues.length;
        if (n < 2) return null;
        let sum = 0;
        for (let i = 0; i < n; i++) sum += this._rttValues[i];
        const mean = sum / n;
        let dev = 0;
        for (let i = 0; i < n; i++) dev += Math.abs(this._rttValues[i] - mean);
        return Math.round(dev / n);
    }

    _recordRtcRouteStat(rttMs, lossPct, jitterMs) {
        const prev = this._routeStats.rtc || {};
        // Feed the RTC RTT window so we can derive jitter/loss consistently,
        // identical to how the WS score is computed.
        if (typeof rttMs === 'number') {
            const now = performance.now();
            this._rtcRttTimes.push(now);
            this._rtcRttValues.push(rttMs);
            if (this._rtcRttValues.length > 30) { this._rtcRttTimes.shift(); this._rtcRttValues.shift(); }
        }
        const derived = this._deriveLinkQuality(this._rtcRttValues, this._rtcRttTimes);
        const loss = typeof lossPct === 'number' ? lossPct : (prev.lossPct ?? derived.lossPct);
        const jit = typeof jitterMs === 'number' ? jitterMs : (prev.jitterMs ?? derived.jitterMs);
        this._routeStats.rtc = {
            ...prev,
            rttMs,
            lossPct: loss,
            jitterMs: jit,
            score: this._scoreLink({ rttMs, lossPct: loss, jitterMs: jit }),
            updatedAt: Date.now(),
        };
    }

    /**
     * Derive jitter/loss for a link whose native stats don't expose them.
     * jitter = mean absolute deviation of RTT; loss estimated from suspect
     * samples (a keepalive timeout shows up as a very large RTT). Capped so a
     * single spike doesn't dominate the score.
     */
    _deriveLinkQuality(values, times, maxAgeMs = 15000) {
        const now = performance.now();
        const fresh = [];
        for (let i = values.length - 1; i >= 0; i--) {
            if (now - times[i] > maxAgeMs) break;
            fresh.push(values[i]);
        }
        if (!fresh.length) return { jitterMs: null, lossPct: null };
        let sum = 0;
        for (const v of fresh) sum += v;
        const mean = sum / fresh.length;
        let dev = 0;
        let suspect = 0;
        const spike = Math.max(300, mean * 3);
        for (const v of fresh) {
            dev += Math.abs(v - mean);
            if (v > spike) suspect += 1;
        }
        return {
            jitterMs: fresh.length >= 2 ? Math.round(dev / fresh.length) : null,
            lossPct: (suspect / fresh.length) * 100,
        };
    }

    _updateWsPanel() {
        if (this._wsQuality.lastRtt == null) return;
        const rt = this._wsQuality.lastRtt;
        this._lastLatency = rt;
        const q = this._wsQuality;
        const extra = [];
        if (q.lossPct != null && q.lossPct > 0.5) extra.push(`loss ${q.lossPct.toFixed(1)}%`);
        if (q.jitterMs != null && q.jitterMs > 30) extra.push(`jit ${q.jitterMs}ms`);
        const suffix = extra.length ? ` (${extra.join(' · ')})` : '';
        this._setMetric('latency', `${rt}ms`, `Latency ${rt}ms${suffix}`);
    }

    // --------------------------------------------------
    // PRIVATE: VIDEO FRAMES
    // --------------------------------------------------

    /**
     * Handle frame update on main thread (fallback - should not be called)
     * All rendering is handled by the GFX worker via OffscreenCanvas
     */
    _handleFrameUpdate(data) {
        // This should not be reached - all frames go to GFX worker
        console.error('[RDPClient] Unexpected frame on main thread - GFX worker should handle all frames');
    }

    // --------------------------------------------------
    // PRIVATE: AUDIO
    // --------------------------------------------------

    async _initAudio() {
        if (this._audioContext) return;
        
        try {
            this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this._audioGainNode = this._audioContext.createGain();
            this._audioGainNode.connect(this._audioContext.destination);
            this._audioGainNode.gain.value = this._isMuted ? 0 : 1;
            
            // Initialize AudioWorklet for low-latency playback
            await this._initAudioWorklet();
        } catch (e) {
            console.error('[RDPClient] Audio init failed:', e);
        }
    }
    
    /**
     * Initialize AudioWorklet with SharedArrayBuffer ring buffer
     */
    async _initAudioWorklet() {
        if (this._audioWorklet) return;
        
        try {
            // Check for SharedArrayBuffer support (requires CORS headers)
            if (typeof SharedArrayBuffer === 'undefined') {
                console.warn('[RDPClient] SharedArrayBuffer not available, audio may have higher latency');
                return;
            }
            
            // Load the AudioWorklet module
            await this._audioContext.audioWorklet.addModule(RDP_CLIENT_BASE_URL + 'audio-worklet.js');
            
            // Create SharedArrayBuffer for ring buffer
            // Layout: [writeIndex(4), readIndex(4), bufferSize(4), channels(4), audioData...]
            const controlBytes = 16; // 4 Uint32s
            const audioBytes = this._audioBufferSize * this._audioChannels * 4; // Float32
            this._audioSharedBuffer = new SharedArrayBuffer(controlBytes + audioBytes);
            
            // Create views into the shared buffer
            this._audioControlView = new Uint32Array(this._audioSharedBuffer, 0, 4);
            this._audioDataView = new Float32Array(this._audioSharedBuffer, controlBytes, 
                                                   this._audioBufferSize * this._audioChannels);
            
            // Initialize control data
            this._audioControlView[0] = 0; // writeIndex
            this._audioControlView[1] = 0; // readIndex
            this._audioControlView[2] = this._audioBufferSize;
            this._audioControlView[3] = this._audioChannels;
            this._audioWriteIndex = 0;
            
            // Create AudioWorkletNode
            this._audioWorklet = new AudioWorkletNode(this._audioContext, 'rdp-audio-processor');
            this._audioWorklet.connect(this._audioGainNode);
            
            // Handle messages from worklet
            this._audioWorklet.port.onmessage = (event) => {
                const { type } = event.data;
                if (type === 'ready') {
                    this._audioWorkletReady = true;
                    console.log('[RDPClient] AudioWorklet ready');
                } else if (type === 'stats') {
                    // Optional: log stats for debugging
                    // console.log('[RDPClient] Audio stats:', event.data);
                }
            };
            
            // Send init message with shared buffer
            this._audioWorklet.port.postMessage({
                type: 'init',
                data: {
                    sharedBuffer: this._audioSharedBuffer,
                    bufferSize: this._audioBufferSize,
                    channels: this._audioChannels
                }
            });
            
            console.log('[RDPClient] AudioWorklet initialized with', 
                        this._audioBufferSize, 'sample ring buffer');
        } catch (e) {
            console.error('[RDPClient] AudioWorklet init failed:', e);
            this._audioWorklet = null;
        }
    }

    async _handleOpusFrame(bytes) {
        if (!this._audioContext) this._initAudio();
        if (this._isMuted) return;
        
        try {
            if (this._audioContext?.state === 'suspended') {
                this._audioContext.resume();
            }
            
            const view = new DataView(bytes.buffer, bytes.byteOffset);
            const sampleRate = view.getUint32(4, true);
            const channels = view.getUint16(8, true);
            const frameSize = view.getUint16(10, true);
            
            if (frameSize === 0 || frameSize > 4000) return;
            
            if (!this._opusDecoder || this._opusSampleRate !== sampleRate || 
                this._opusChannels !== channels) {
                await this._initOpusDecoder(sampleRate, channels);
            }
            
            if (!this._opusDecoder || this._opusDecoder.state === 'closed') return;
            
            const opusData = bytes.slice(12, 12 + frameSize);
            if (opusData.length === 0) return;
            
            this._opusDecoder.decode(new EncodedAudioChunk({
                type: 'key',
                timestamp: performance.now() * 1000,
                data: opusData
            }));
        } catch (e) {
            console.error('[RDPClient] Opus error:', e);
        }
    }

    async _initOpusDecoder(sampleRate, channels) {
        if (typeof AudioDecoder === 'undefined') return false;
        
        if (this._opusDecoder) {
            try { this._opusDecoder.close(); } catch (e) {}
        }
        
        try {
            this._opusSampleRate = sampleRate;
            this._opusChannels = channels;
            
            this._opusDecoder = new AudioDecoder({
                output: (audioData) => this._handleDecodedAudio(audioData),
                error: (e) => console.error('[RDPClient] Opus decode error:', e)
            });
            
            await this._opusDecoder.configure({
                codec: 'opus',
                sampleRate,
                numberOfChannels: channels,
            });
            
            this._opusInitialized = true;
            return true;
        } catch (e) {
            this._opusDecoder = null;
            return false;
        }
    }

    _handleDecodedAudio(audioData) {
        if (!this._audioContext || this._isMuted) {
            audioData.close();
            return;
        }
        
        try {
            if (this._audioContext.state === 'suspended') {
                this._audioContext.resume();
            }
            
            const numFrames = audioData.numberOfFrames;
            const numChannels = audioData.numberOfChannels;
            const format = audioData.format; // e.g., 'f32-planar', 'f32', 's16', etc.
            
            // If AudioWorklet is ready, write directly to ring buffer
            if (this._audioWorkletReady && this._audioDataView) {
                this._writeToRingBuffer(audioData, numFrames, numChannels, format);
            } else {
                // AudioWorklet not available - audio will not play
                if (!this._audioWorkletWarned) {
                    console.warn('[RDPClient] AudioWorklet not ready - audio frames dropped');
                    this._audioWorkletWarned = true;
                }
            }
        } catch (e) {
            console.error('[RDPClient] Audio error:', e);
        } finally {
            audioData.close();
        }
    }
    
    /**
     * Write decoded audio samples to the ring buffer for AudioWorklet
     */
    _writeToRingBuffer(audioData, numFrames, numChannels, format) {
        const bufferSize = this._audioBufferSize;
        const channels = this._audioChannels;
        
        // Prepare temp buffer for reading from AudioData
        const tempChannels = [];
        for (let ch = 0; ch < numChannels; ch++) {
            tempChannels.push(new Float32Array(numFrames));
        }
        
        // Copy audio data to temp buffers
        if (format && format.includes('planar')) {
            for (let ch = 0; ch < numChannels; ch++) {
                audioData.copyTo(tempChannels[ch], { planeIndex: ch });
            }
        } else {
            // Interleaved - extract to planar
            let tempBuffer;
            if (format === 's16') {
                tempBuffer = new Int16Array(numFrames * numChannels);
            } else if (format === 's32') {
                tempBuffer = new Int32Array(numFrames * numChannels);
            } else {
                tempBuffer = new Float32Array(numFrames * numChannels);
            }
            audioData.copyTo(tempBuffer, { planeIndex: 0 });
            
            for (let ch = 0; ch < numChannels; ch++) {
                for (let i = 0; i < numFrames; i++) {
                    let sample = tempBuffer[i * numChannels + ch];
                    if (format === 's16') sample = sample / 32768.0;
                    else if (format === 's32') sample = sample / 2147483648.0;
                    tempChannels[ch][i] = sample;
                }
            }
        }
        
        // Write interleaved samples to ring buffer
        let writeIdx = this._audioWriteIndex;
        for (let i = 0; i < numFrames; i++) {
            const bufferIdx = writeIdx % bufferSize;
            for (let ch = 0; ch < channels; ch++) {
                const srcCh = ch < numChannels ? ch : numChannels - 1;
                this._audioDataView[bufferIdx * channels + ch] = tempChannels[srcCh][i];
            }
            writeIdx++;
        }
        
        this._audioWriteIndex = writeIdx % bufferSize;
        Atomics.store(this._audioControlView, 0, this._audioWriteIndex);
    }


    _handleAudioFrame(bytes) {
        if (!this._audioContext || this._isMuted) return;
        
        try {
            if (this._audioContext.state === 'suspended') {
                this._audioContext.resume();
            }
            
            const view = new DataView(bytes.buffer, bytes.byteOffset);
            const sampleRate = view.getUint32(4, true);
            const channels = view.getUint16(8, true);
            const bits = view.getUint16(10, true);
            
            const pcmData = bytes.slice(12);
            if (pcmData.length === 0) return;
            
            const bytesPerSample = bits / 8;
            const numSamples = Math.floor(pcmData.length / (channels * bytesPerSample));
            if (numSamples === 0) return;
            
            // If AudioWorklet is ready, write directly to ring buffer
            if (this._audioWorkletReady && this._audioDataView) {
                this._writePcmToRingBuffer(pcmData, numSamples, channels, bits);
            } else {
                // AudioWorklet not available - audio will not play
                if (!this._audioWorkletWarned) {
                    console.warn('[RDPClient] AudioWorklet not ready - audio frames dropped');
                    this._audioWorkletWarned = true;
                }
            }
        } catch (e) {
            console.error('[RDPClient] PCM audio error:', e);
        }
    }
    
    /**
     * Write PCM audio samples to ring buffer for AudioWorklet
     */
    _writePcmToRingBuffer(pcmData, numSamples, srcChannels, bits) {
        const bufferSize = this._audioBufferSize;
        const dstChannels = this._audioChannels;
        const bytesPerSample = bits / 8;
        
        let writeIdx = this._audioWriteIndex;
        
        for (let i = 0; i < numSamples; i++) {
            const bufferIdx = writeIdx % bufferSize;
            
            for (let ch = 0; ch < dstChannels; ch++) {
                const srcCh = ch < srcChannels ? ch : srcChannels - 1;
                const sampleIndex = i * srcChannels + srcCh;
                const byteOffset = sampleIndex * bytesPerSample;
                
                let sample;
                if (bits === 16) {
                    const int16 = pcmData[byteOffset] | (pcmData[byteOffset + 1] << 8);
                    sample = int16 > 32767 ? (int16 - 65536) / 32768 : int16 / 32768;
                } else if (bits === 8) {
                    sample = (pcmData[byteOffset] - 128) / 128;
                } else {
                    sample = 0;
                }
                
                this._audioDataView[bufferIdx * dstChannels + ch] = sample;
            }
            writeIdx++;
        }
        
        this._audioWriteIndex = writeIdx % bufferSize;
        Atomics.store(this._audioControlView, 0, this._audioWriteIndex);
    }


    _cleanupAudio() {
        // Clean up Opus decoder
        if (this._opusDecoder) {
            try { this._opusDecoder.close(); } catch (e) {}
            this._opusDecoder = null;
            this._opusInitialized = false;
        }
        
        // Clean up AudioWorklet
        if (this._audioWorklet) {
            this._audioWorklet.port.postMessage({ type: 'reset' });
            this._audioWorklet.disconnect();
            this._audioWorklet = null;
        }
        this._audioWorkletReady = false;
        this._audioWorkletWarned = false;
        this._audioSharedBuffer = null;
        this._audioControlView = null;
        this._audioDataView = null;
        this._audioWriteIndex = 0;
        
        // Clean up AudioContext
        if (this._audioContext) {
            this._audioContext.close();
            this._audioContext = null;
            this._audioGainNode = null;
        }
    }

    // --------------------------------------------------
    // PRIVATE: INPUT HANDLING
    // --------------------------------------------------

    /**
     * Simple delay helper for async operations
     * @param {number} ms - Milliseconds to delay
     * @returns {Promise<void>}
     * @private
     */
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Show the API cursor overlay at the specified remote desktop coordinates
     * @param {number} x - X coordinate in remote desktop pixels
     * @param {number} y - Y coordinate in remote desktop pixels
     * @private
     */
    _showApiCursor(x, y) {
        this._apiCursorPos = { x, y };
        this._apiCursorVisible = true;
        
        // Convert remote desktop coordinates to screen coordinates
        const rect = this._canvas.getBoundingClientRect();
        const scaleX = rect.width / this._canvas.width;
        const scaleY = rect.height / this._canvas.height;
        
        // Calculate position relative to the screen container
        const screenX = x * scaleX;
        const screenY = y * scaleY;
        
        this._el.apiCursor.style.left = `${screenX}px`;
        this._el.apiCursor.style.top = `${screenY}px`;
        this._el.apiCursor.classList.add('visible');
    }

    /**
     * Hide the API cursor overlay
     * @private
     */
    _hideApiCursor() {
        if (this._apiCursorVisible) {
            this._apiCursorVisible = false;
            this._el.apiCursor.classList.remove('visible');
        }
    }

    _getMousePos(e) {
        const rect = this._canvas.getBoundingClientRect();
        const scaleX = this._canvas.width / rect.width;
        const scaleY = this._canvas.height / rect.height;
        return {
            x: Math.round((e.clientX - rect.left) * scaleX),
            y: Math.round((e.clientY - rect.top) * scaleY)
        };
    }

    _handleMouseMove(e) {
        if (!this._isConnected) return;
        
        // Hide API cursor when real mouse moves
        this._hideApiCursor();
        
        const now = Date.now();
        if (now - this._lastMouseSend < this.options.mouseThrottleMs) return;
        this._lastMouseSend = now;
        
        const pos = this._getMousePos(e);
        this._sendMessage({ type: 'mouse', action: 'move', x: pos.x, y: pos.y });
    }

    _handleMouseDown(e) {
        if (!this._isConnected) return;
        e.preventDefault();
        this._focusInput();
        
        const pos = this._getMousePos(e);
        this._sendMessage({ type: 'mouse', action: 'down', button: e.button, x: pos.x, y: pos.y });
    }

    _handleMouseUp(e) {
        if (!this._isConnected) return;
        e.preventDefault();
        
        const pos = this._getMousePos(e);
        this._sendMessage({ type: 'mouse', action: 'up', button: e.button, x: pos.x, y: pos.y });
    }

    _handleMouseWheel(e) {
        if (!this._isConnected) return;
        e.preventDefault();
        
        const pos = this._getMousePos(e);
        this._sendMessage({ 
            type: 'mouse', action: 'wheel', 
            deltaX: e.deltaX, deltaY: e.deltaY, 
            x: pos.x, y: pos.y 
        });
    }

    _handleKeyDown(e) {
        if (!this._isConnected) return;

        // Win/Meta is reserved by Windows. Whenever a session is active and the
        // event reaches us, block the local OS shortcut even if focus is on a
        // toolbar button or the input check below would otherwise bail out.
        const isMeta = e.code === 'MetaLeft' || e.code === 'MetaRight' || e.key === 'OS' || e.key === 'Meta';
        if (isMeta) e.preventDefault();

        if (!this._isInputFocused()) return;

        // While an IME is composing (CJK, dead keys, etc.) let the browser handle
        // the event so the composition window works; committed text is delivered
        // separately via _handleCompositionEnd. keyCode 229 == process key.
        if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return;

        e.preventDefault();
        this._trackKeyDown(e);
        // Self-heal: if the browser says no modifier is held but we still think
        // one is down remotely, release it first. A single missed key-up must
        // not turn every later character into a shortcut (e.g. Win+L lock).
        this._reconcileTrackedModifiers(e);
        this._sendMessage({
            type: 'key', action: 'down',
            key: e.key, code: e.code, keyCode: e.keyCode,
            ctrlKey: e.ctrlKey, shiftKey: e.shiftKey,
            altKey: e.altKey, metaKey: e.metaKey
        });
    }

    /**
     * Release tracked modifier keys that the current event proves are no longer
     * physically held. Prevents a lost key-up from leaving Win/Ctrl/Alt/Shift
     * stuck on the remote.
     */
    _reconcileTrackedModifiers(e) {
        const checks = [
            [['ControlLeft', 'ControlRight'], e.ctrlKey],
            [['ShiftLeft', 'ShiftRight'], e.shiftKey],
            [['AltLeft', 'AltRight'], e.altKey],
            [['MetaLeft', 'MetaRight'], e.metaKey],
        ];
        for (const [codes, held] of checks) {
            if (held) continue;
            for (const code of codes) {
                // Never reconcile the modifier key currently being pressed.
                if (code === e.code) continue;
                const tracked = this._pressedKeys.get(code);
                if (!tracked) continue;
                this._pressedKeys.delete(code);
                try {
                    this._sendMessage({
                        type: 'key', action: 'up',
                        key: tracked.key || '',
                        code, keyCode: tracked.keyCode || 0,
                        ctrlKey: false, shiftKey: false, altKey: false, metaKey: false
                    });
                } catch {}
            }
        }
    }

    _handleKeyUp(e) {
        if (!this._isConnected) return;
        // Do NOT gate key-up on focus or composition state. If the key-down was
        // forwarded, the matching key-up must always be sent too, otherwise the
        // remote keeps the key logically held (stuck modifier -> phantom
        // shortcuts such as Win+L).
        if (e.isComposing || e.keyCode === 229 || e.key === 'Process') {
            this._releaseKey(e.code, e.key);
            return;
        }

        // Outside the capture surface only release keys we actually forwarded;
        // ignore stray key-ups from other parts of the page.
        if (!this._isInputFocused() && !this._pressedKeys.has(e.code)) return;

        e.preventDefault();
        this._trackKeyUp(e.code);
        this._sendMessage({
            type: 'key', action: 'up',
            key: e.key, code: e.code, keyCode: e.keyCode,
            ctrlKey: e.ctrlKey, shiftKey: e.shiftKey,
            altKey: e.altKey, metaKey: e.metaKey
        });
    }

    /** Remember a forwarded key-down so a matching key-up is never forgotten. */
    _trackKeyDown(e) {
        if (!e.code) return;
        this._pressedKeys.set(e.code, { key: e.key, keyCode: e.keyCode });
    }

    _trackKeyUp(code) {
        if (!code) return;
        this._pressedKeys.delete(code);
    }

    /**
     * Release a single tracked key without a browser event (used when an IME
     * intercepts key-up). Uses the same payload shape as _handleKeyUp.
     */
    _releaseKey(code, key) {
        if (!this._isConnected) return;
        const tracked = this._pressedKeys.get(code);
        if (!tracked) return;
        this._pressedKeys.delete(code);
        this._sendMessage({
            type: 'key', action: 'up',
            key: tracked.key || key || '',
            code, keyCode: tracked.keyCode || 0,
            ctrlKey: false, shiftKey: false, altKey: false, metaKey: false
        });
    }

    /**
     * Send key-up for every key still considered held remotely.
     *
     * Called when the browser window loses focus, the tab is hidden, or the
     * session ends. Modifier keys are released last so a synthetic combo can
     * never be produced by the release order.
     */
    _releaseAllKeys() {
        // Also drop any key the on-screen keyboard is holding.
        if (this._keyboardActiveKey) this._releaseVirtualKeyboardState();
        if (!this._pressedKeys.size) return;
        if (!this._isConnected) {
            this._pressedKeys.clear();
            return;
        }
        const MODIFIERS = new Set([
            'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
            'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'AltGraph'
        ]);
        const held = [...this._pressedKeys.entries()];
        this._pressedKeys.clear();
        // Release normal keys first, then modifiers.
        held.sort((a, b) => (MODIFIERS.has(a[0]) ? 1 : 0) - (MODIFIERS.has(b[0]) ? 1 : 0));
        for (const [code, tracked] of held) {
            try {
                this._sendMessage({
                    type: 'key', action: 'up',
                    key: tracked.key || '',
                    code, keyCode: tracked.keyCode || 0,
                    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false
                });
            } catch {}
        }
    }

    /** True when keyboard focus is on the IME field or the canvas. */
    _isInputFocused() {
        const ae = this._shadow.activeElement;
        return ae === this._canvas || (this._el?.ime ? ae === this._el.ime : false);
    }

    /** Move keyboard focus to the IME capture field (creates a valid IME target). */
    _focusInput() {
        try {
            if (this._el?.ime) this._el.ime.focus({ preventScroll: true });
            else this._canvas?.focus({ preventScroll: true });
        } catch { try { this._el.ime.focus(); } catch {} }
    }

    /**
     * Send a committed IME string to the remote as Unicode keyboard input.
     * The backend injects single BMP characters via rdp_send_unicode, which works
     * regardless of the remote keyboard layout.
     * @param {string} text
     */
    _sendUnicodeText(text) {
        if (!this._isConnected || !text) return;
        for (const ch of Array.from(text)) {
            const cp = ch.codePointAt(0);
            // Beyond BMP (astral / most emoji) can't be encoded in a UTF-16 Unicode
            // keyboard event; skip to avoid sending garbage.
            if (cp > 0xFFFF) continue;
            this._sendMessage({ type: 'key', action: 'down', key: ch, code: '', keyCode: 0,
                ctrlKey: false, shiftKey: false, altKey: false, metaKey: false });
            this._sendMessage({ type: 'key', action: 'up', key: ch, code: '', keyCode: 0,
                ctrlKey: false, shiftKey: false, altKey: false, metaKey: false });
        }
    }

    _handleCompositionEnd(e) {
        this._composing = false;
        const data = (e && typeof e.data === 'string') ? e.data : (this._el?.ime?.value || '');
        if (this._el?.ime) this._el.ime.value = '';
        if (data) this._sendUnicodeText(data);
    }

    // --------------------------------------------------
    // PRIVATE: VIRTUAL KEYBOARD
    // --------------------------------------------------
    
    /**
     * Setup virtual keyboard event listeners
     */
    _setupVirtualKeyboard() {
        const overlay = this._el.keyboardOverlay;
        const titlebar = this._el.keyboardTitlebar;
        const resizeHandle = this._el.keyboardResize;
        
        // Close button
        this._el.keyboardClose.addEventListener('click', () => this.hideKeyboard());
        
        // Key press handlers
        overlay.querySelectorAll('.rdp-key').forEach(key => {
            key.addEventListener('mousedown', (e) => this._handleVirtualKeyDown(e, key));
            key.addEventListener('mouseup', (e) => this._handleVirtualKeyUp(e, key));
            key.addEventListener('mouseleave', (e) => this._handleVirtualKeyUp(e, key));
            // Touch support
            key.addEventListener('touchstart', (e) => {
                e.preventDefault();
                this._handleVirtualKeyDown(e, key);
            });
            key.addEventListener('touchend', (e) => {
                e.preventDefault();
                this._handleVirtualKeyUp(e, key);
            });
        });
        
        // Dragging
        titlebar.addEventListener('mousedown', (e) => this._startKeyboardDrag(e));
        titlebar.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this._startKeyboardDrag(e.touches[0]);
        });
        
        // Resizing
        resizeHandle.addEventListener('mousedown', (e) => this._startKeyboardResize(e));
        resizeHandle.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this._startKeyboardResize(e.touches[0]);
        });
        
        // Global mouse/touch move and up handlers
        this._shadow.addEventListener('mousemove', (e) => {
            if (this._keyboardDragging) this._handleKeyboardDrag(e);
            if (this._keyboardResizing) this._handleKeyboardResize(e);
        });
        this._shadow.addEventListener('mouseup', () => {
            this._keyboardDragging = false;
            this._keyboardResizing = false;
        });
        this._shadow.addEventListener('touchmove', (e) => {
            if (this._keyboardDragging || this._keyboardResizing) {
                e.preventDefault();
                const touch = e.touches[0];
                if (this._keyboardDragging) this._handleKeyboardDrag(touch);
                if (this._keyboardResizing) this._handleKeyboardResize(touch);
            }
        });
        this._shadow.addEventListener('touchend', () => {
            this._keyboardDragging = false;
            this._keyboardResizing = false;
        });
    }
    
    /**
     * Toggle virtual keyboard visibility
     */
    _toggleKeyboard() {
        if (this._keyboardVisible) {
            this.hideKeyboard();
        } else {
            this.showKeyboard();
        }
    }
    
    /**
     * Show the virtual keyboard
     * @public
     */
    showKeyboard() {
        if (!this._isConnected) return;
        
        const overlay = this._el.keyboardOverlay;
        const content = this._el.keyboardContent;
        const screenRect = this._el.screen.getBoundingClientRect();
        
        // Reset scale to measure natural size
        content.style.transform = 'scale(1)';
        overlay.classList.add('visible');
        
        // Measure natural keyboard size (only once)
        if (this._keyboardBaseWidth === 0) {
            const contentRect = content.getBoundingClientRect();
            const titlebarRect = this._el.keyboardTitlebar.getBoundingClientRect();
            this._keyboardBaseWidth = contentRect.width;
            this._keyboardBaseHeight = contentRect.height;  // Content only (rows)
            this._keyboardTitlebarHeight = titlebarRect.height + 8; // +8 for margin
        }
        
        // Scale limits - adjusted for better usability
        const minScale = 0.5;
        const maxScale = 1.2;
        
        // Calculate initial scale (try to fit 80% of screen width, but clamp to limits)
        let scale = Math.min((screenRect.width * 0.8 - 16) / this._keyboardBaseWidth, maxScale);
        scale = Math.max(scale, minScale);
        
        // Calculate dimensions: width and content are scaled, titlebar is not
        const calcWidth = (s) => (this._keyboardBaseWidth * s) + 16;
        const calcHeight = (s) => (this._keyboardBaseHeight * s) + this._keyboardTitlebarHeight + 16;
        
        // Check if max scale still fits in canvas
        const maxWidth = screenRect.width - 20;  // Leave some margin
        const maxHeight = screenRect.height - 40;  // Leave some margin
        
        if (calcWidth(scale) > maxWidth) {
            scale = Math.max(minScale, (maxWidth - 16) / this._keyboardBaseWidth);
        }
        if (calcHeight(scale) > maxHeight) {
            const heightScale = (maxHeight - this._keyboardTitlebarHeight - 16) / this._keyboardBaseHeight;
            scale = Math.max(minScale, Math.min(scale, heightScale));
        }
        
        const width = calcWidth(scale);
        const height = calcHeight(scale);
        
        // Apply scale
        content.style.transform = `scale(${scale})`;
        
        // Center horizontally, position at bottom
        const left = (screenRect.width - width) / 2;
        const top = Math.max(0, screenRect.height - height - 20);
        
        overlay.style.width = `${width}px`;
        overlay.style.height = `${height}px`;
        overlay.style.left = `${Math.max(0, left)}px`;
        overlay.style.top = `${top}px`;
        
        this._keyboardVisible = true;
        this._el.btnKeyboard?.setAttribute('aria-pressed', 'true');
        this._showChrome(false);   // keep the toolbar visible while typing on it
        this._emit('keyboardShow');
    }
    
    /**
     * Hide the virtual keyboard
     * @public
     */
    hideKeyboard() {
        // Release anything the on-screen keyboard left pressed before hiding,
        // otherwise a toggled modifier (Win/Ctrl/Alt) stays held on the remote
        // and the next physical keystroke becomes a shortcut (Win+L, …).
        this._releaseVirtualKeyboardState();
        this._el.keyboardOverlay.classList.remove('visible');
        this._keyboardVisible = false;
        this._resetKeyboardModifiers();
        this._el.btnKeyboard?.setAttribute('aria-pressed', 'false');
        this._scheduleChromeHide();
        this._emit('keyboardHide');
    }

    /**
     * Release the on-screen keyboard's active key and modifier keys remotely.
     * Safe to call when nothing is pressed.
     */
    _releaseVirtualKeyboardState() {
        if (!this._isConnected) {
            this._keyboardActiveKey = null;
            return;
        }
        const activeKey = this._keyboardActiveKey;
        if (activeKey) {
            this._keyboardActiveKey = null;
            activeKey.classList.remove('pressed');
            const code = activeKey.dataset.code;
            if (code) {
                const keyName = activeKey.dataset.key || activeKey.textContent;
                this._sendMessage({
                    type: 'key', action: 'up',
                    key: keyName, code, keyCode: 0,
                    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false
                });
            }
            // Modifier downs are only sent alongside an active key, so only
            // release them when we actually had one pressed.
            this._sendActiveModifierUpEvents();
        }
    }
    
    /**
     * Check if virtual keyboard is visible
     * @public
     * @returns {boolean}
     */
    isKeyboardVisible() {
        return this._keyboardVisible;
    }
    
    /**
     * Reset all keyboard modifiers
     */
    _resetKeyboardModifiers() {
        this._keyboardModifiers = { ctrl: false, alt: false, shift: false, meta: false, altgr: false };
        this._el.keyboardOverlay.querySelectorAll('.rdp-key-modifier').forEach(key => {
            key.classList.remove('pressed');
        });
        this._updateKeyboardKeyLabels();
    }
    
    /**
     * Update keyboard key labels based on active modifiers (shift, altgr, shift+altgr)
     * Priority: shift+altgr > altgr > shift > normal
     */
    _updateKeyboardKeyLabels() {
        const shiftActive = this._keyboardModifiers.shift;
        const altgrActive = this._keyboardModifiers.altgr;
        
        this._el.keyboardOverlay.querySelectorAll('.rdp-key[data-key]').forEach(key => {
            let label;
            
            if (shiftActive && altgrActive) {
                // Shift+AltGr: use data-shift-altgr, fallback to data-altgr, then data-shift, then data-key
                label = key.dataset.shiftAltgr || key.dataset.altgr || key.dataset.shift || key.dataset.key;
            } else if (altgrActive) {
                // AltGr only: use data-altgr, fallback to data-key
                label = key.dataset.altgr || key.dataset.key;
            } else if (shiftActive) {
                // Shift only: use data-shift, fallback to data-key
                label = key.dataset.shift || key.dataset.key;
            } else {
                // No modifiers: use data-key
                label = key.dataset.key;
            }
            
            key.textContent = label;
        });
    }
    
    /**
     * Handle virtual key press
     */
    _handleVirtualKeyDown(e, key) {
        if (!this._isConnected) return;
        e.preventDefault();
        e.stopPropagation();
        
        const code = key.dataset.code;
        const combo = key.dataset.combo;
        const modifier = key.dataset.modifier;
        
        // Handle special combos (no tracking needed, instant action)
        if (combo) {
            key.classList.add('pressed');
            this._sendVirtualKeyCombo(combo);
            // Remove pressed state after a short delay for visual feedback
            setTimeout(() => key.classList.remove('pressed'), 150);
            return;
        }
        
        // Handle modifier keys (toggle mode, no tracking)
        if (modifier) {
            this._keyboardModifiers[modifier] = !this._keyboardModifiers[modifier];
            if (this._keyboardModifiers[modifier]) {
                key.classList.add('pressed');
            } else {
                key.classList.remove('pressed');
            }
            // Update key labels when shift or altgr state changes
            if (modifier === 'shift' || modifier === 'altgr') {
                this._updateKeyboardKeyLabels();
            }
            return;
        }
        
        // Track this as the active key
        this._keyboardActiveKey = key;
        key.classList.add('pressed');
        
        // Get key name based on modifier state (priority: shift+altgr > altgr > shift > normal)
        const shiftActive = this._keyboardModifiers.shift;
        const altgrActive = this._keyboardModifiers.altgr;
        let keyName;
        let hasAltGrChar = false; // True if we have a dedicated AltGr character for this key
        
        if (shiftActive && altgrActive) {
            // Check if key has a dedicated shift+altgr character
            hasAltGrChar = !!key.dataset.shiftAltgr || !!key.dataset.altgr;
            keyName = key.dataset.shiftAltgr || key.dataset.altgr || key.dataset.shift || key.textContent;
        } else if (altgrActive) {
            // Check if key has a dedicated altgr character
            hasAltGrChar = !!key.dataset.altgr;
            keyName = key.dataset.altgr || key.dataset.key || key.textContent;
        } else if (shiftActive) {
            keyName = key.dataset.shift || key.textContent;
        } else {
            keyName = key.dataset.key || key.textContent;
        }
        
        // If we have a dedicated AltGr character, send it directly without modifier events.
        // The character itself (e.g., €, ñ, ß) is sent as Unicode, no Ctrl+Alt needed.
        // Only send modifier events if we DON'T have a dedicated AltGr char.
        if (!hasAltGrChar) {
            this._sendActiveModifierDownEvents();
        } else if (shiftActive && !altgrActive) {
            // Only shift is active (no altgr), send shift
            this._sendActiveModifierDownEvents();
        }
        
        // Send main key - when hasAltGrChar is true, send without modifier flags
        // so backend uses Unicode input for the special character
        this._sendMessage({
            type: 'key', action: 'down',
            key: keyName, code: code, keyCode: 0,
            ctrlKey: hasAltGrChar ? false : this._keyboardModifiers.ctrl,
            shiftKey: hasAltGrChar ? false : this._keyboardModifiers.shift,
            altKey: hasAltGrChar ? false : this._keyboardModifiers.alt,
            metaKey: hasAltGrChar ? false : this._keyboardModifiers.meta
        });
    }
    
    /**
     * Send key down events for all active modifiers
     */
    _sendActiveModifierDownEvents() {
        // AltGr is equivalent to Ctrl+Alt on Windows
        if (this._keyboardModifiers.altgr) {
            this._sendMessage({
                type: 'key', action: 'down',
                key: 'Control', code: 'ControlLeft', keyCode: 0,
                ctrlKey: true, shiftKey: false, altKey: false, metaKey: false
            });
            this._sendMessage({
                type: 'key', action: 'down',
                key: 'Alt', code: 'AltRight', keyCode: 0,
                ctrlKey: true, shiftKey: false, altKey: true, metaKey: false
            });
        } else {
            if (this._keyboardModifiers.ctrl) {
                this._sendMessage({
                    type: 'key', action: 'down',
                    key: 'Control', code: 'ControlLeft', keyCode: 0,
                    ctrlKey: true, shiftKey: false, altKey: false, metaKey: false
                });
            }
            if (this._keyboardModifiers.alt) {
                this._sendMessage({
                    type: 'key', action: 'down',
                    key: 'Alt', code: 'AltLeft', keyCode: 0,
                    ctrlKey: this._keyboardModifiers.ctrl, shiftKey: false, altKey: true, metaKey: false
                });
            }
        }
        if (this._keyboardModifiers.shift) {
            this._sendMessage({
                type: 'key', action: 'down',
                key: 'Shift', code: 'ShiftLeft', keyCode: 0,
                ctrlKey: this._keyboardModifiers.ctrl, shiftKey: true, altKey: this._keyboardModifiers.alt, metaKey: false
            });
        }
        if (this._keyboardModifiers.meta) {
            this._sendMessage({
                type: 'key', action: 'down',
                key: 'Meta', code: 'MetaLeft', keyCode: 0,
                ctrlKey: this._keyboardModifiers.ctrl, shiftKey: this._keyboardModifiers.shift, altKey: this._keyboardModifiers.alt, metaKey: true
            });
        }
    }
    
    /**
     * Send key up events for all active modifiers
     */
    _sendActiveModifierUpEvents() {
        if (this._keyboardModifiers.meta) {
            this._sendMessage({
                type: 'key', action: 'up',
                key: 'Meta', code: 'MetaLeft', keyCode: 0,
                ctrlKey: this._keyboardModifiers.ctrl, shiftKey: this._keyboardModifiers.shift, altKey: this._keyboardModifiers.alt, metaKey: false
            });
        }
        if (this._keyboardModifiers.shift) {
            this._sendMessage({
                type: 'key', action: 'up',
                key: 'Shift', code: 'ShiftLeft', keyCode: 0,
                ctrlKey: this._keyboardModifiers.ctrl, shiftKey: false, altKey: this._keyboardModifiers.alt, metaKey: false
            });
        }
        // AltGr releases Ctrl+Alt in reverse order
        if (this._keyboardModifiers.altgr) {
            this._sendMessage({
                type: 'key', action: 'up',
                key: 'Alt', code: 'AltRight', keyCode: 0,
                ctrlKey: true, shiftKey: false, altKey: false, metaKey: false
            });
            this._sendMessage({
                type: 'key', action: 'up',
                key: 'Control', code: 'ControlLeft', keyCode: 0,
                ctrlKey: false, shiftKey: false, altKey: false, metaKey: false
            });
        } else {
            if (this._keyboardModifiers.alt) {
                this._sendMessage({
                    type: 'key', action: 'up',
                    key: 'Alt', code: 'AltLeft', keyCode: 0,
                    ctrlKey: this._keyboardModifiers.ctrl, shiftKey: false, altKey: false, metaKey: false
                });
            }
            if (this._keyboardModifiers.ctrl) {
                this._sendMessage({
                    type: 'key', action: 'up',
                    key: 'Control', code: 'ControlLeft', keyCode: 0,
                    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false
                });
            }
        }
    }
    
    /**
     * Handle virtual key release
     */
    _handleVirtualKeyUp(e, key) {
        if (!this._isConnected) return;
        
        const modifier = key.dataset.modifier;
        const combo = key.dataset.combo;
        
        // Don't process modifier keys or combos on mouseup (they toggle/instant)
        if (modifier || combo) return;
        
        // Only send key up if this is the actively pressed key
        if (this._keyboardActiveKey !== key) return;
        
        this._keyboardActiveKey = null;
        key.classList.remove('pressed');
        
        const code = key.dataset.code;
        
        // Get key name based on modifier state (priority: shift+altgr > altgr > shift > normal)
        const shiftActive = this._keyboardModifiers.shift;
        const altGrActive = this._keyboardModifiers.altgr;
        let keyName;
        let hasAltGrChar = false; // True if we have a dedicated AltGr character
        
        if (shiftActive && altGrActive) {
            hasAltGrChar = !!key.dataset.shiftAltgr || !!key.dataset.altgr;
            keyName = key.dataset.shiftAltgr || key.dataset.altgr || key.dataset.shift || key.textContent;
        } else if (altGrActive) {
            hasAltGrChar = !!key.dataset.altgr;
            keyName = key.dataset.altgr || key.dataset.key || key.textContent;
        } else if (shiftActive) {
            keyName = key.dataset.shift || key.textContent;
        } else {
            keyName = key.dataset.key || key.textContent;
        }
        
        // Send main key up - when hasAltGrChar, send without modifier flags
        this._sendMessage({
            type: 'key', action: 'up',
            key: keyName, code: code, keyCode: 0,
            ctrlKey: hasAltGrChar ? false : this._keyboardModifiers.ctrl,
            shiftKey: hasAltGrChar ? false : this._keyboardModifiers.shift,
            altKey: hasAltGrChar ? false : this._keyboardModifiers.alt,
            metaKey: hasAltGrChar ? false : this._keyboardModifiers.meta
        });
        
        // Send modifier key up events only if we sent them on key down
        if (!hasAltGrChar) {
            this._sendActiveModifierUpEvents();
        } else if (shiftActive && !altGrActive) {
            this._sendActiveModifierUpEvents();
        }
        
        // Reset modifiers after non-modifier key press
        this._resetKeyboardModifiers();
    }
    
    /**
     * Send a key combination (properly simulates modifier key presses)
     */
    _sendVirtualKeyCombo(combo) {
        const keys = combo.toLowerCase().split('+');
        const modifierKeys = [];
        let mainKey = null;
        let mainCode = null;
        
        keys.forEach(k => {
            switch (k) {
                case 'ctrl': 
                    modifierKeys.push({ key: 'Control', code: 'ControlLeft' });
                    break;
                case 'alt': 
                    modifierKeys.push({ key: 'Alt', code: 'AltLeft' });
                    break;
                case 'shift': 
                    modifierKeys.push({ key: 'Shift', code: 'ShiftLeft' });
                    break;
                case 'meta': case 'win': 
                    modifierKeys.push({ key: 'Meta', code: 'MetaLeft' });
                    break;
                case 'tab': 
                    mainKey = 'Tab'; 
                    mainCode = 'Tab'; 
                    break;
                case 'delete': 
                    mainKey = 'Delete'; 
                    mainCode = 'Delete'; 
                    break;
                default: 
                    mainKey = k; 
                    mainCode = k;
            }
        });
        
        if (!mainKey) return;
        
        // Build modifier state
        const modifiers = {
            ctrl: modifierKeys.some(m => m.key === 'Control'),
            alt: modifierKeys.some(m => m.key === 'Alt'),
            shift: modifierKeys.some(m => m.key === 'Shift'),
            meta: modifierKeys.some(m => m.key === 'Meta')
        };
        
        // Press modifier keys down first
        modifierKeys.forEach(mod => {
            this._sendMessage({
                type: 'key', action: 'down',
                key: mod.key, code: mod.code, keyCode: 0,
                ctrlKey: false, shiftKey: false, altKey: false, metaKey: false
            });
        });
        
        // Small delay then press main key
        setTimeout(() => {
            // Press main key down
            this._sendMessage({
                type: 'key', action: 'down',
                key: mainKey, code: mainCode, keyCode: 0,
                ctrlKey: modifiers.ctrl, shiftKey: modifiers.shift,
                altKey: modifiers.alt, metaKey: modifiers.meta
            });
            
            // Release main key
            setTimeout(() => {
                this._sendMessage({
                    type: 'key', action: 'up',
                    key: mainKey, code: mainCode, keyCode: 0,
                    ctrlKey: modifiers.ctrl, shiftKey: modifiers.shift,
                    altKey: modifiers.alt, metaKey: modifiers.meta
                });
                
                // Release modifier keys in reverse order
                setTimeout(() => {
                    [...modifierKeys].reverse().forEach(mod => {
                        this._sendMessage({
                            type: 'key', action: 'up',
                            key: mod.key, code: mod.code, keyCode: 0,
                            ctrlKey: false, shiftKey: false, altKey: false, metaKey: false
                        });
                    });
                }, 20);
            }, 30);
        }, 20);
    }
    
    /**
     * Start dragging the keyboard
     */
    _startKeyboardDrag(e) {
        this._keyboardDragging = true;
        const overlay = this._el.keyboardOverlay;
        const rect = overlay.getBoundingClientRect();
        const screenRect = this._el.screen.getBoundingClientRect();
        
        this._keyboardDragOffset = {
            x: e.clientX - (rect.left - screenRect.left),
            y: e.clientY - (rect.top - screenRect.top)
        };
    }
    
    /**
     * Handle keyboard dragging
     */
    _handleKeyboardDrag(e) {
        if (!this._keyboardDragging) return;
        
        const overlay = this._el.keyboardOverlay;
        const screenRect = this._el.screen.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();
        
        let newLeft = e.clientX - this._keyboardDragOffset.x;
        let newTop = e.clientY - this._keyboardDragOffset.y;
        
        // Constrain to screen bounds
        newLeft = Math.max(0, Math.min(newLeft, screenRect.width - overlayRect.width));
        newTop = Math.max(0, Math.min(newTop, screenRect.height - overlayRect.height));
        
        overlay.style.left = `${newLeft}px`;
        overlay.style.top = `${newTop}px`;
    }
    
    /**
     * Start resizing the keyboard
     */
    _startKeyboardResize(e) {
        this._keyboardResizing = true;
        e.stopPropagation();
    }
    
    /**
     * Handle keyboard resizing with content scaling
     */
    _handleKeyboardResize(e) {
        if (!this._keyboardResizing) return;
        if (this._keyboardBaseWidth === 0) return;  // Not initialized
        
        const overlay = this._el.keyboardOverlay;
        const content = this._el.keyboardContent;
        const screenRect = this._el.screen.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();
        
        // Scale limits
        const minScale = 0.6;
        const maxScale = 1.2;
        
        // Helper functions for calculating dimensions
        const calcWidth = (s) => (this._keyboardBaseWidth * s) + 16;
        const calcHeight = (s) => (this._keyboardBaseHeight * s) + this._keyboardTitlebarHeight + 16;
        
        // Calculate new width based on mouse position
        let newWidth = e.clientX - overlayRect.left + 10;
        
        // Calculate desired scale
        let scale = (newWidth - 16) / this._keyboardBaseWidth;
        
        // Clamp scale between min and max
        scale = Math.max(minScale, Math.min(maxScale, scale));
        
        // Check canvas boundaries and adjust if needed
        const maxWidth = screenRect.width - (overlayRect.left - screenRect.left);
        const maxHeight = screenRect.height - (overlayRect.top - screenRect.top);
        
        if (calcWidth(scale) > maxWidth) {
            scale = Math.max(minScale, (maxWidth - 16) / this._keyboardBaseWidth);
        }
        
        if (calcHeight(scale) > maxHeight) {
            const heightScale = (maxHeight - this._keyboardTitlebarHeight - 16) / this._keyboardBaseHeight;
            scale = Math.max(minScale, Math.min(scale, heightScale));
        }
        
        // Ensure we're still within scale limits after boundary checks
        scale = Math.max(minScale, Math.min(maxScale, scale));
        
        newWidth = calcWidth(scale);
        const newHeight = calcHeight(scale);
        
        content.style.transform = `scale(${scale})`;
        overlay.style.width = `${newWidth}px`;
        overlay.style.height = `${newHeight}px`;
    }

    // --------------------------------------------------
    // PRIVATE: RESIZE
    // --------------------------------------------------

    _getAvailableDimensions() {
        const rect = this._el.screen.getBoundingClientRect();
        // Target the physical pixels the canvas is painted on: any mismatch makes
        // the browser resample the frame (bilinear filtering = blurry text).
        // The screen surface is now edge-to-edge with no border, so nothing has
        // to be subtracted from its measured size.
        const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, this.options.maxPixelRatio || 1));
        let width = Math.floor(rect.width * dpr);
        let height = Math.floor(rect.height * dpr);

        // do never send resize below RDP server minimums or above maximums
        const minRdpServerDimensions = { width: 640, height: 480 };
        const maxRdpServerDimensions = { width: 4096, height: 2304 };
        
        // Respect user-defined minWidth/minHeight (never send resize below these values)
        // But still honor minimums of rdp server
        const minW = Math.max(minRdpServerDimensions.width, this.options.minWidth || 0);
        const minH = Math.max(minRdpServerDimensions.height, this.options.minHeight || 0);
        // But still honor maximumof rdp server
        width = Math.max(minW, Math.min(width, maxRdpServerDimensions.width));
        height = Math.max(minH, Math.min(height, maxRdpServerDimensions.height));
        width = Math.floor(width / 2) * 2;
        height = Math.floor(height / 2) * 2;
        
        return { width, height };
    }

    _handleResize() {
        if (!this._isConnected) return;

        if (this._resizeTimeout) {
            clearTimeout(this._resizeTimeout);
        }

        // Fullscreen transitions fire a burst of resizes during the animation.
        // Use a very short delay for fullscreen so the desktop starts adjusting
        // right away; window drags use the normal (short) debounce.
        const sinceFullscreen = Date.now() - (this._lastFullscreenChange || 0);
        const delay = sinceFullscreen < 800 ? 80 : this.options.resizeDebounceMs;

        this._resizeTimeout = setTimeout(() => {
            if (!this._isConnected) return;

            // Don't resize during the post-connect stabilization window or while
            // an RTC media switch is in flight: a resize racing the sender switch
            // makes the remote host reset the RDP transport (first-connect drop).
            const sinceConnect = Date.now() - (this._connectedAt || 0);
            if (sinceConnect < 4000
                || this._mediaPath === 'rtc-pending'
                || this._rtcDialing) {
                this._pendingResizeCheck = true;
                clearTimeout(this._pendingResizeTimer);
                this._pendingResizeTimer = setTimeout(() => {
                    this._pendingResizeTimer = null;
                    this._handleResize();
                }, 1000);
                return;
            }

            const { width, height } = this._getAvailableDimensions();
            
            if ((width !== this._canvas.width || height !== this._canvas.height) &&
                (width !== this._lastRequestedWidth || height !== this._lastRequestedHeight)) {
                this._lastRequestedWidth = width;
                this._lastRequestedHeight = height;
                this._sendMessage({ type: 'resize', width, height });
            }
        }, delay);
    }

    _handleServerResize(width, height) {
        // The resolution readout was removed from the HUD; keep the value on the
        // instance so getResolution() and integrations still see it.
        // When using OffscreenCanvas (transferred to worker), we cannot resize
        // the HTMLCanvasElement directly. The worker owns the canvas now.
        // We need to notify the worker to resize the OffscreenCanvas instead.
        if (this._gfxWorker && this._gfxWorkerReady) {
            this._gfxWorker.postMessage({
                type: 'resize',
                data: { width, height }
            });
        } else {
            // Fallback: only resize HTMLCanvasElement if NOT transferred to worker
            try {
                this._canvas.width = width;
                this._canvas.height = height;
            } catch (e) {
                // Canvas was transferred to offscreen, ignore
            }
        }
        
        this._emit('resize', { width, height });
    }
}

// Re-export theme utilities for convenience
export { themes, resolveTheme, sanitizeTheme } from './rdp-themes.js';

// Default export for convenience
export default RDPClient;
