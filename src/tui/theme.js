/**
 * The backpass house theme for the live progress view.
 *
 * One theme, two ink sets (captain-approved design): the palette from the apply
 * surface for dark backgrounds, and a darkened twin tuned for paper-white. On
 * truecolor terminals the exact hex inks are emitted; otherwise each ink maps to
 * its nearest ANSI-16 color, which inherits the user's own palette.
 *
 * The mint->blue "descent gradient" is the brand mark and is reserved for
 * exactly two things: the nabla wordmark and active progress fills.
 */

export const INKS = {
  dark: {
    text: "#d9dfea",
    dim: "#8a93a5",
    faint: "#5a6375",
    mint: "#4fe3c1",
    blue: "#6ea8ff",
    yellow: "#ffc857",
    red: "#ff5d73",
    purple: "#b18aff",
    peach: "#ff9e64",
    green: "#9ece6a",
    magenta: "#e05fbc",
  },
  light: {
    text: "#2a3140",
    dim: "#5b6478",
    faint: "#939cae",
    mint: "#0a8a72",
    blue: "#2b62d9",
    yellow: "#8f6606",
    red: "#c22b47",
    purple: "#6f42c8",
    peach: "#b25a10",
    green: "#4e7a17",
    magenta: "#ab3184",
  },
};

/** Nearest ANSI-16 foreground SGR code per ink. `null` means the default fg. */
export const ANSI16 = {
  text: null,
  dim: "90",
  faint: "90",
  mint: "96",
  blue: "94",
  yellow: "93",
  red: "91",
  purple: "95",
  peach: "33",
  green: "92",
  magenta: "95",
};

export function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

const RESET = "\x1b[0m";

/**
 * Build a theme for one terminal. `depth` 24 emits hex inks, 4 emits ANSI-16,
 * and 0 emits no escapes at all - which is what the render tests use, so the
 * rendered layout is asserted as plain text.
 */
export function makeTheme({ depth = 24, background = "dark" } = {}) {
  const inks = INKS[background] || INKS.dark;

  const open = (ink, bold) => {
    if (depth === 0) return "";
    const parts = [];
    if (bold) parts.push("1");
    if (depth === 24) {
      const [r, g, b] = hexToRgb(inks[ink] || inks.text);
      parts.push(`38;2;${r};${g};${b}`);
    } else if (ANSI16[ink]) {
      parts.push(ANSI16[ink]);
    }
    return parts.length ? `\x1b[${parts.join(";")}m` : "";
  };

  const paint = (text, ink = "text", { bold = false } = {}) => {
    const prefix = open(ink, bold);
    return prefix ? `${prefix}${text}${RESET}` : String(text);
  };

  /** Per-character mint->blue interpolation; solid mint below truecolor. */
  const gradient = (text, { bold = false } = {}) => {
    const value = String(text);
    if (depth === 0) return value;
    if (depth !== 24) return paint(value, "mint", { bold });
    const from = hexToRgb(inks.mint);
    const to = hexToRgb(inks.blue);
    const chars = [...value];
    const steps = Math.max(chars.length - 1, 1);
    return (
      chars
        .map((ch, i) => {
          const t = i / steps;
          const rgb = from.map((f, c) => Math.round(f + (to[c] - f) * t));
          return `\x1b[${bold ? "1;" : ""}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${ch}`;
        })
        .join("") + RESET
    );
  };

  return { depth, background, inks, paint, gradient };
}
