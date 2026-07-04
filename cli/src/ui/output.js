/**
 * ui/output.js — Professional, consistent terminal output.
 * Zero-dependency colors, progress bars, spinners, and boxes.
 */

const useColor =
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb" &&
  (process.stdout.isTTY || process.env.FORCE_COLOR);

const c = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const bold = c(1, 22);
export const dim = c(2, 22);
export const italic = c(3, 23);
export const red = c(31, 39);
export const green = c(32, 39);
export const yellow = c(33, 39);
export const cyan = c(36, 39);
export const magenta = c(35, 39);
export const gray = c(90, 39);

export const ok = (msg) => console.log(`  ${green("✔")} ${msg}`);
export const fail = (msg) => console.log(`  ${red("✖")} ${msg}`);
export const warn = (msg) => console.log(`  ${yellow("⚠")} ${msg}`);
export const info = (msg) => console.log(`  ${gray("•")} ${dim(msg)}`);

/** Draws an industrial header for major sections. */
export const header = (title) => {
  console.log("");
  console.log(`  ${bold(cyan(title.toUpperCase()))}`);
  console.log(`  ${gray("━".repeat(Math.min(title.length, 40)))}`);
};

/** High-fidelity spinner for async tasks like API testing or indexing. */
export function spinner(label) {
  if (!process.stdout.isTTY) {
    console.log(`  ${cyan("•")} ${label}...`);
    return { stop: () => {} };
  }

  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r  ${cyan(frames[i])} ${dim(label)}...`);
    i = (i + 1) % frames.length;
  }, 80);

  return {
    stop: (msg, success = true) => {
      clearInterval(timer);
      process.stdout.write("\r\x1b[2K");
      if (success) ok(msg || label);
      else fail(msg || label);
    },
  };
}

/** Draws a clean boxed summary for configuration or final reports. */
export function box(lines, title = null) {
  const cleanLength = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  const width = Math.max(...lines.map(cleanLength), title ? cleanLength(title) : 0) + 4;
  
  const top = gray(`┌${"─".repeat(width)}┐`);
  const bottom = gray(`└${"─".repeat(width)}┘`);
  const pipe = gray("│");

  console.log("");
  if (title) console.log(`  ${bold(title)}`);
  console.log(`  ${top}`);
  for (const line of lines) {
    const padding = " ".repeat(width - cleanLength(line) - 2);
    console.log(`  ${pipe}  ${line}${padding}${pipe}`);
  }
  console.log(`  ${bottom}`);
}

/** The progress bar used for ONNX model and tokenizer downloads. */
export function progressBar(label) {
  let lastPct = -1;
  return {
    update(received, total) {
      if (!process.stdout.isTTY) return;
      const pct = Math.min(100, Math.floor((received / total) * 100));
      if (pct === lastPct) return;
      lastPct = pct;
      const width = 25;
      const filled = Math.round((pct / 100) * width);
      const bar = cyan("█".repeat(filled)) + gray("░".repeat(width - filled));
      const mb = (n) => (n / 1024 / 1024).toFixed(1);
      process.stdout.write(
        `\r  ${magenta("⬇")} ${dim(label)} ${bar} ${bold(pct)}% ${gray(`(${mb(received)}MB)`)} `
      );
    },
    finish(msg) {
      if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
      ok(msg);
    },
  };
}