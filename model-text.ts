/** Render model-authored text as inert provider content. */
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const ACTIVE_MARKDOWN = /([\\`*_{}[\]()#+.!|>~-])/g;
const BARE_SCHEME = /(?<![A-Za-z0-9+./-])([A-Za-z][A-Za-z0-9+.-]{0,31})(:)(?=\S)/g;

export function renderInertModelText(value: string): string {
  const normalized = value.normalize("NFC").replace(/\r\n?/g, "\n");
  if (CONTROLS.test(normalized)) throw new Error("model text contains controls");
  return normalized
    .replace(/(^|\n)([^\S\n]*)(?=\/[A-Za-z])/g, "$1$2\u200b")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "@\u200b")
    .replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?=#\d+)/giu, "$1 ")
    .replace(BARE_SCHEME, "$1\u200b$2")
    .replace(/\bwww\.(?=\S)/giu, (value) => `${value.slice(0, -1)}\u200b.`)
    .replace(ACTIVE_MARKDOWN, "\\$1");
}
