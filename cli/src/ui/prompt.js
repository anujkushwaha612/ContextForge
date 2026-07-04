/**
 * ui/prompt.js — tiny zero-dependency interactive prompts.
 */

import readline from "node:readline";
import { bold, dim, cyan, green, gray } from "./output.js";

export function isInteractive() {
  return process.stdin.isTTY && process.stdout.isTTY && !process.env.CI;
}

/** Arrow-key select menu. */
export function select(question, choices, defaultIndex = 0) {
  if (!isInteractive()) return Promise.resolve(choices[defaultIndex].value);

  return new Promise((resolve) => {
    let idx = defaultIndex;
    const render = (first = false) => {
      if (!first) process.stdout.write(`\x1b[${choices.length}A`);
      for (let i = 0; i < choices.length; i++) {
        const c = choices[i];
        const line =
          i === idx
            ? `  ${cyan("❯")} ${bold(c.label)}${c.hint ? gray(`  ${c.hint}`) : ""}`
            : `    ${c.label}${c.hint ? gray(`  ${c.hint}`) : ""}`;
        process.stdout.write(`\x1b[2K${line}\n`);
      }
    };

    console.log(`  ${bold(question)} ${gray("(↑/↓, enter)")}`);
    render(true);

    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === "up")   { idx = (idx - 1 + choices.length) % choices.length; render(); }
      if (key.name === "down") { idx = (idx + 1) % choices.length; render(); }
      if (key.name === "return") {
        cleanup();
        process.stdout.write(`\x1b[${choices.length}A`);
        for (let i = 0; i < choices.length; i++) process.stdout.write(`\x1b[2K\n`);
        process.stdout.write(`\x1b[${choices.length}A`);
        console.log(`  ${green("✔")} ${bold(choices[idx].label)}\n`);
        resolve(choices[idx].value);
      }
      if ((key.ctrl && key.name === "c") || key.name === "escape") {
        cleanup();
        process.stdout.write("\n");
        process.exit(130);
      }
    };

    const cleanup = () => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
    };
    process.stdin.on("keypress", onKey);
  });
}

/** Free-text input. */
export function input(question, { def = null, validate = null } = {}) {
  if (!isInteractive()) return Promise.resolve(def);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = def ? gray(` (${def})`) : "";

  return new Promise((resolve) => {
    const ask = () => {
      rl.question(`  ${bold(question)}${suffix} `, (raw) => {
        const answer = raw.trim() || def || "";
        if (validate) {
          const v = validate(answer);
          if (v !== true) {
            console.log(`  ${dim(`↳ ${v}`)}`);
            return ask();
          }
        }
        rl.close();
        resolve(answer || null);
      });
    };
    ask();
  });
}

/** Password input with masking and corrected pasting logic. */
export function password(question, { validate = null } = {}) {
  if (!isInteractive()) return Promise.resolve(null);

  return new Promise((resolve) => {
    const ask = () => {
      let input = "";
      process.stdout.write(`  ${bold(question)} `);

      readline.emitKeypressEvents(process.stdin);
      const wasRaw = process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();

      const onKeypress = (str, key) => {
        if (!key) return;
        if (key.ctrl && key.name === "c") {
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (key.name === "return") {
          cleanup();
          process.stdout.write("\n");
          const answer = input.trim();
          if (validate && validate(answer) !== true) {
            console.log(`  ${dim(`↳ ${validate(answer)}`)}`);
            return ask();
          }
          resolve(answer || null);
          return;
        }
        if (key.name === "backspace" || key.sequence === "\b" || key.sequence === "\x7f") {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write("\b \b");
          }
          return;
        }
        // Pasting fix: accept all printable characters and strip control codes
        if (str && !key.ctrl && !key.meta) {
          const printable = str.replace(/[\x00-\x1F\x7F]/g, "");
          if (printable.length > 0) {
            input += printable;
            process.stdout.write("*".repeat(printable.length));
          }
        }
      };

      const cleanup = () => {
        process.stdin.off("keypress", onKeypress);
        process.stdin.setRawMode(wasRaw ?? false);
        process.stdin.pause();
      };
      process.stdin.on("keypress", onKeypress);
    };
    ask();
  });
}

/** Yes/no confirmation. */
export function confirm(question, { default: def = true } = {}) {
  const hint = def ? gray(' (Y/n)') : gray(' (y/N)');
  return input(`${question}${hint}`, {
    def: def ? 'y' : 'n',
    validate: (s) => {
      const lower = s.toLowerCase();
      if (['y', 'yes', 'n', 'no', ''].includes(lower)) return true;
      return 'Please enter y or n';
    },
  }).then((s) => {
    const lower = s.toLowerCase();
    return ['y', 'yes', ''].includes(lower);
  });
}