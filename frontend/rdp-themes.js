/**
 * RDP Client Theme System
 * 
 * Provides theme presets and utilities for customizing the RDP client appearance.
 * 
 * @example
 * import { RDPClient } from './rdp-client.js';
 * import { themes } from './rdp-themes.js';
 * 
 * // Use a preset
 * const client = new RDPClient(container, {
 *     theme: { preset: 'light' }
 * });
 * 
 * // Customize colors
 * const client = new RDPClient(container, {
 *     theme: {
 *         preset: 'dark',
 *         colors: { accent: '#00b4d8' }
 *     }
 * });
 */

// ============================================================
// THEME TYPE DEFINITION (JSDoc for TypeScript-like intellisense)
// ============================================================

/**
 * @typedef {Object} RDPThemeColors
 * @property {string} [background] - Main background color
 * @property {string} [surface] - Surface color for panels, modals, toolbars
 * @property {string} [border] - Border and separator color
 * @property {string} [text] - Primary text color
 * @property {string} [textMuted] - Secondary/muted text color
 * @property {string} [accent] - Primary accent color for focus, active states
 * @property {string} [accentText] - Text color on accent backgrounds
 * @property {string} [error] - Error/disconnect state color
 * @property {string} [success] - Success/connected state color
 * @property {string} [buttonBg] - Button background color
 * @property {string} [buttonHover] - Button hover background color
 * @property {string} [buttonText] - Button text color
 * @property {string} [buttonActiveBg] - Button active/pressed background
 * @property {string} [buttonActiveText] - Button active/pressed text color
 * @property {string} [inputBg] - Input field background
 * @property {string} [inputBorder] - Input field border color
 * @property {string} [inputFocusBorder] - Input field focus border color
 */

/**
 * @typedef {Object} RDPThemeTypography
 * @property {string} [fontFamily] - Font family stack
 * @property {string} [fontSize] - Base font size
 * @property {string} [fontSizeSmall] - Small text size (status, labels)
 */

/**
 * @typedef {Object} RDPThemeShape
 * @property {string} [borderRadius] - Border radius for buttons, inputs, panels
 * @property {string} [borderRadiusLarge] - Larger radius for modals, overlays
 */

/**
 * @typedef {Object} RDPThemeFontFace
 * @property {string} family - Font family name (e.g., 'Inter')
 * @property {string} src - Font source URL (woff2, woff, ttf, otf)
 * @property {string} [weight] - Font weight (e.g., '400', '700', '400 700')
 * @property {string} [style] - Font style ('normal', 'italic')
 * @property {string} [display] - Font display strategy ('swap', 'block', 'fallback')
 */

/**
 * @typedef {Object} RDPThemeFonts
 * @property {string[]} [googleFonts] - Google Fonts URLs (e.g., 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap')
 * @property {RDPThemeFontFace[]} [fontFaces] - Custom @font-face definitions
 */

/**
 * @typedef {Object} RDPTheme
 * @property {'dark'|'light'|'midnight'|'highContrast'} [preset] - Base preset to extend
 * @property {RDPThemeColors} [colors] - Color overrides
 * @property {RDPThemeTypography} [typography] - Typography overrides
 * @property {RDPThemeShape} [shape] - Shape/spacing overrides
 * @property {RDPThemeFonts} [fonts] - Custom font imports
 */

// ============================================================
// THEME PRESETS
// ============================================================

/**
 * Dark theme - Default theme: deep slate panels with a cyan accent
 */
export const darkTheme = {
    mode: 'dark',
    colors: {
        background: '#0b0f17',
        surface: '#131a27',
        border: '#243147',
        text: '#e7eefb',
        textMuted: '#8d9cb5',
        accent: '#22d3ee',
        accentText: '#03212a',
        error: '#f87171',
        success: '#10b981',
        buttonBg: '#1b2434',
        buttonHover: '#263247',
        buttonText: '#dbe6f7',
        buttonActiveBg: '#22d3ee',
        buttonActiveText: '#03212a',
        inputBg: '#0e1520',
        inputBorder: '#2a3a53',
        inputFocusBorder: '#22d3ee',
    },
    typography: {
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        fontSize: '14px',
        fontSizeSmall: '0.85rem',
    },
    shape: {
        borderRadius: '7px',
        borderRadiusLarge: '12px',
    }
};

/**
 * Light theme - Clean light mode
 */
export const lightTheme = {
    mode: 'light',
    colors: {
        background: '#f6f8fc',
        surface: '#ffffff',
        border: '#dfe6f0',
        text: '#101828',
        textMuted: '#5a6678',
        accent: '#0e7490',
        accentText: '#ffffff',
        error: '#b42318',
        success: '#067647',
        buttonBg: '#eef2f8',
        buttonHover: '#e2e8f2',
        buttonText: '#1d2939',
        buttonActiveBg: '#0e7490',
        buttonActiveText: '#ffffff',
        inputBg: '#ffffff',
        inputBorder: '#cfd8e5',
        inputFocusBorder: '#0e7490',
    },
    typography: {
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        fontSize: '14px',
        fontSizeSmall: '0.85rem',
    },
    shape: {
        borderRadius: '7px',
        borderRadiusLarge: '12px',
    }
};

/**
 * Midnight theme - Pure dark with purple accents
 */
export const midnightTheme = {
    mode: 'dark',
    colors: {
        background: '#07070c',
        surface: '#121219',
        border: '#2b2b3b',
        text: '#e6e6f0',
        textMuted: '#8a8aa3',
        accent: '#a78bfa',
        accentText: '#140a2e',
        error: '#fb7185',
        success: '#2dd4bf',
        buttonBg: '#1b1b26',
        buttonHover: '#272735',
        buttonText: '#e6e6f0',
        buttonActiveBg: '#a78bfa',
        buttonActiveText: '#140a2e',
        inputBg: '#0e0e15',
        inputBorder: '#2b2b3b',
        inputFocusBorder: '#a78bfa',
    },
    typography: {
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        fontSize: '14px',
        fontSizeSmall: '0.85rem',
    },
    shape: {
        borderRadius: '7px',
        borderRadiusLarge: '12px',
    }
};

/**
 * High Contrast theme - Accessibility focused
 */
export const highContrastTheme = {
    mode: 'dark',
    colors: {
        background: '#000000',
        surface: '#000000',
        border: '#ffffff',
        text: '#ffffff',
        textMuted: '#ffff00',
        accent: '#00ff00',
        accentText: '#000000',
        error: '#ff5555',
        success: '#00ff00',
        buttonBg: '#000000',
        buttonHover: '#333333',
        buttonText: '#ffffff',
        buttonActiveBg: '#ffff00',
        buttonActiveText: '#000000',
        inputBg: '#000000',
        inputBorder: '#ffffff',
        inputFocusBorder: '#00ff00',
    },
    typography: {
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        fontSize: '16px',
        fontSizeSmall: '14px',
    },
    shape: {
        borderRadius: '2px',
        borderRadiusLarge: '2px',
    }
};

// ============================================================
// PRESET MAP
// ============================================================

/**
 * Available theme presets
 */
export const themes = {
    dark: darkTheme,
    light: lightTheme,
    midnight: midnightTheme,
    highContrast: highContrastTheme,
};

// ============================================================
// THEME UTILITIES
// ============================================================

/**
 * Resolve a theme configuration to a complete theme object
 * @param {RDPTheme} themeConfig - Theme configuration from user
 * @returns {Object} Complete theme with all values resolved
 */
export function resolveTheme(themeConfig = {}) {
    // Start with dark theme as base
    const baseTheme = themeConfig.preset ? themes[themeConfig.preset] : darkTheme;
    
    if (!baseTheme) {
        console.warn(`[RDPTheme] Unknown preset "${themeConfig.preset}", falling back to dark`);
        return resolveTheme({ ...themeConfig, preset: 'dark' });
    }
    
    // Deep merge user overrides
    return {
        // `mode` lets the stylesheet pick light/dark-only values (shadows,
        // scrim strength) without duplicating every colour token.
        mode: themeConfig.mode || baseTheme.mode || 'dark',
        preset: themeConfig.preset || 'dark',
        colors: {
            ...baseTheme.colors,
            ...themeConfig.colors,
            // Track whether the user supplied a custom background so derived
            // surfaces can be computed from the right base.
            _mode: themeConfig.mode || baseTheme.mode || 'dark',
        },
        typography: { ...baseTheme.typography, ...themeConfig.typography },
        shape: { ...baseTheme.shape, ...themeConfig.shape },
    };
}

/**
 * Convert resolved theme to CSS custom properties string
 * @param {Object} theme - Resolved theme object
 * @returns {string} CSS custom properties to inject
 */
export function themeToCssVars(theme) {
    const vars = [];
    
    // Colors
    if (theme.colors) {
        const colorMap = {
            background: '--rdp-bg',
            surface: '--rdp-surface',
            border: '--rdp-border',
            text: '--rdp-text',
            textMuted: '--rdp-text-muted',
            accent: '--rdp-accent',
            accentText: '--rdp-accent-text',
            error: '--rdp-error',
            success: '--rdp-success',
            buttonBg: '--rdp-btn-bg',
            buttonHover: '--rdp-btn-hover',
            buttonText: '--rdp-btn-text',
            buttonActiveBg: '--rdp-btn-active-bg',
            buttonActiveText: '--rdp-btn-active-text',
            inputBg: '--rdp-input-bg',
            inputBorder: '--rdp-input-border',
            inputFocusBorder: '--rdp-input-focus-border',
        };
        
        for (const [key, cssVar] of Object.entries(colorMap)) {
            if (theme.colors[key]) {
                vars.push(`${cssVar}: ${theme.colors[key]}`);
            }
        }
    }

    // Light/dark-only values: shadows are much softer on light surfaces, and
    // the scrim needs to stay strong enough to isolate a dialog on white.
    const mode = theme.mode || (theme.colors && theme.colors._mode) || 'dark';
    if (mode === 'light') {
        vars.push('--rdp-shadow-1: 0 1px 2px rgba(16, 24, 40, 0.06)');
        vars.push('--rdp-shadow-2: 0 6px 18px rgba(16, 24, 40, 0.10)');
        vars.push('--rdp-shadow-3: 0 24px 56px rgba(16, 24, 40, 0.18)');
        vars.push('--rdp-scrim: rgba(16, 24, 40, 0.42)');
        // Flip derived surfaces so "elevated" reads as slightly darker/lighter
        // relative to a white card instead of washing it out.
        vars.push('--rdp-elevated: #ffffff');
        vars.push('--rdp-sunken: color-mix(in srgb, var(--rdp-bg) 92%, #101828 8%)');
        vars.push('--rdp-hairline: color-mix(in srgb, var(--rdp-border) 85%, transparent)');
        // The picture area follows the theme too: a dark navy letterbox reads as
        // a bug in light mode. Only a whisper of ink keeps it distinct from the
        // page while leaving body text comfortably readable.
        vars.push('--rdp-screen-bg: color-mix(in srgb, var(--rdp-bg) 96%, #101828 4%)');
        vars.push('--rdp-grip: rgba(16, 24, 40, 0.28)');
    } else {
        vars.push('--rdp-shadow-1: 0 1px 2px rgba(0, 0, 0, 0.3)');
        vars.push('--rdp-shadow-2: 0 6px 20px rgba(0, 0, 0, 0.4)');
        vars.push('--rdp-shadow-3: 0 24px 64px rgba(0, 0, 0, 0.6)');
        vars.push('--rdp-scrim: rgba(0, 0, 0, 0.68)');
        vars.push('--rdp-elevated: color-mix(in srgb, var(--rdp-surface) 82%, #ffffff 18%)');
        vars.push('--rdp-sunken: color-mix(in srgb, var(--rdp-bg) 88%, #000000 12%)');
        vars.push('--rdp-hairline: color-mix(in srgb, var(--rdp-border) 70%, transparent)');
        vars.push('--rdp-screen-bg: #05070b');
        vars.push('--rdp-grip: rgba(255, 255, 255, 0.34)');
    }
    vars.push(`--rdp-color-scheme: ${mode}`);
    
    // Typography
    if (theme.typography) {
        if (theme.typography.fontFamily) {
            vars.push(`--rdp-font-family: ${theme.typography.fontFamily}`);
        }
        if (theme.typography.fontSize) {
            vars.push(`--rdp-font-size: ${theme.typography.fontSize}`);
        }
        if (theme.typography.fontSizeSmall) {
            vars.push(`--rdp-font-size-small: ${theme.typography.fontSizeSmall}`);
        }
    }
    
    // Shape
    if (theme.shape) {
        if (theme.shape.borderRadius) {
            vars.push(`--rdp-border-radius: ${theme.shape.borderRadius}`);
        }
        if (theme.shape.borderRadiusLarge) {
            vars.push(`--rdp-border-radius-lg: ${theme.shape.borderRadiusLarge}`);
        }
    }
    
    return vars.join('; ');
}

/**
 * Validate theme color value (basic hex/rgb/hsl check)
 * @param {string} value - Color value to validate
 * @returns {boolean} True if valid
 */
export function isValidColor(value) {
    if (!value || typeof value !== 'string') return false;
    
    // Hex colors
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return true;
    
    // RGB/RGBA
    if (/^rgba?\s*\([\d\s,%.]+\)$/i.test(value)) return true;
    
    // HSL/HSLA
    if (/^hsla?\s*\([\d\s,%deg.]+\)$/i.test(value)) return true;
    
    // Named colors (basic set)
    const namedColors = ['transparent', 'currentColor', 'inherit', 'white', 'black', 
                         'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'gray', 'grey'];
    if (namedColors.includes(value.toLowerCase())) return true;
    
    return false;
}

/**
 * Sanitize theme config, removing invalid values
 * @param {RDPTheme} themeConfig - Raw theme config
 * @returns {RDPTheme} Sanitized theme config
 */
export function sanitizeTheme(themeConfig) {
    const sanitized = { ...themeConfig };
    
    if (sanitized.colors) {
        sanitized.colors = { ...sanitized.colors };
        for (const [key, value] of Object.entries(sanitized.colors)) {
            if (!isValidColor(value)) {
                console.warn(`[RDPTheme] Invalid color value for "${key}": ${value}`);
                delete sanitized.colors[key];
            }
        }
    }
    
    // Sanitize fonts
    if (sanitized.fonts) {
        sanitized.fonts = { ...sanitized.fonts };
        
        // Validate Google Font URLs
        if (sanitized.fonts.googleFonts) {
            sanitized.fonts.googleFonts = sanitized.fonts.googleFonts.filter(url => {
                if (!isValidFontUrl(url)) {
                    console.warn(`[RDPTheme] Invalid Google Font URL: ${url}`);
                    return false;
                }
                return true;
            });
        }
        
        // Validate font faces
        if (sanitized.fonts.fontFaces) {
            sanitized.fonts.fontFaces = sanitized.fonts.fontFaces.filter(face => {
                if (!face.family || typeof face.family !== 'string') {
                    console.warn(`[RDPTheme] Font face missing 'family' property`);
                    return false;
                }
                if (!face.src || !isValidFontUrl(face.src)) {
                    console.warn(`[RDPTheme] Invalid font source URL for "${face.family}": ${face.src}`);
                    return false;
                }
                return true;
            });
        }
    }
    
    return sanitized;
}

// ============================================================
// FONT UTILITIES
// ============================================================

/**
 * Allowed font URL patterns (security: prevent arbitrary resource loading)
 */
const ALLOWED_FONT_PATTERNS = [
    // Google Fonts
    /^https:\/\/fonts\.googleapis\.com\/css2?/,
    /^https:\/\/fonts\.gstatic\.com\//,
    // Adobe Fonts (Typekit)
    /^https:\/\/use\.typekit\.net\//,
    // Font files (woff2, woff, ttf, otf) - any HTTPS source
    /^https:\/\/.+\.(woff2?|ttf|otf)(\?.*)?$/i,
    // Data URLs for embedded fonts
    /^data:font\/(woff2?|ttf|opentype);base64,/,
];

/**
 * Validate font URL against allowed patterns
 * @param {string} url - Font URL to validate
 * @returns {boolean} True if URL is allowed
 */
export function isValidFontUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return ALLOWED_FONT_PATTERNS.some(pattern => pattern.test(url));
}

/**
 * Generate CSS for font imports
 * @param {RDPThemeFonts} fonts - Font configuration
 * @returns {string} CSS string with @import and @font-face rules
 */
export function fontsToCss(fonts) {
    if (!fonts) return '';
    
    const rules = [];
    
    // Google Fonts @import rules
    if (fonts.googleFonts && fonts.googleFonts.length > 0) {
        for (const url of fonts.googleFonts) {
            rules.push(`@import url('${url}');`);
        }
    }
    
    // Custom @font-face rules
    if (fonts.fontFaces && fonts.fontFaces.length > 0) {
        for (const face of fonts.fontFaces) {
            const srcFormat = getFontFormat(face.src);
            const fontFace = `@font-face {
    font-family: '${escapeCssString(face.family)}';
    src: url('${face.src}')${srcFormat ? ` format('${srcFormat}')` : ''};
    font-weight: ${face.weight || 'normal'};
    font-style: ${face.style || 'normal'};
    font-display: ${face.display || 'swap'};
}`;
            rules.push(fontFace);
        }
    }
    
    return rules.join('\n');
}

/**
 * Detect font format from URL
 * @param {string} url - Font URL
 * @returns {string|null} Format identifier or null
 */
function getFontFormat(url) {
    if (!url) return null;
    if (url.includes('.woff2')) return 'woff2';
    if (url.includes('.woff')) return 'woff';
    if (url.includes('.ttf')) return 'truetype';
    if (url.includes('.otf')) return 'opentype';
    if (url.startsWith('data:font/woff2')) return 'woff2';
    if (url.startsWith('data:font/woff')) return 'woff';
    if (url.startsWith('data:font/ttf')) return 'truetype';
    if (url.startsWith('data:font/opentype')) return 'opentype';
    return null;
}

/**
 * Escape string for use in CSS
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeCssString(str) {
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
