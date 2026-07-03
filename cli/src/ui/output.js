/**
 * ui/output.js — consistent terminal output.
 * Zero-dependency colors + progress bar (respects NO_COLOR and non-TTY).
 */

const useColor =
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb" &&
  (process.stdout.isTTY || process.env.FORCE_COLOR);

const c = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const bold = c(1, 22);
export const dim = c(2, 22);
export const red = c(31, 39);
export const green = c(32, 39);
export const yellow = c(33, 39);
export const cyan = c(36, 39);

export const ok = (msg) => console.log(`  ${green("✔")} ${msg}`);
export const fail = (msg) => console.log(`  ${red("✖")} ${msg}`);
export const warn = (msg) => console.log(`  ${yellow("⚠")} ${msg}`);
export const info = (msg) => console.log(`  ${dim("·")} ${msg}`);
export const header = (title) => {
  console.log("");
  console.log(`  ${bold(title)}`);
  console.log(`  ${dim("─".repeat(Math.min(title.length + 2, 60)))}`);
};

/** Simple single-line progress bar. Safe on non-TTY (prints nothing until done). */
export function progressBar(label) {
  let lastPct = -1;
  return {
    update(received, total) {
      if (!process.stdout.isTTY) return;
      const pct = Math.min(100, Math.floor((received / total) * 100));
      if (pct === lastPct) return;
      lastPct = pct;
      const width = 28;
      const filled = Math.round((pct / 100) * width);
      const bar = "█".repeat(filled) + "░".repeat(width - filled);
      const mb = (n) => (n / 1024 / 1024).toFixed(1);
      process.stdout.write(
        `\r  ${dim("⬇")} ${label} ${bar} ${pct}% ${dim(`${mb(received)}/${mb(total)} MB`)}  `
      );
    },
    finish(msg) {
      if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
      ok(msg);
    },
  };
}
