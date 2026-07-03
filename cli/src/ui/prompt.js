/**
 * ui/prompt.js — tiny zero-dependency interactive prompts.
 * select(): arrow-key menu · input(): free-text line
 * Both degrade gracefully on non-TTY (return the default and note it).
 */

import readline from "node:readline";
import { bold, dim, cyan, green } from "./output.js";

export function isInteractive() {
  return process.stdin.isTTY && process.stdout.isTTY && !process.env.CI;
}

/**
 * Arrow-key select menu.
 * @param {string} question
 * @param {{value:string,label:string,hint?:string}[]} choices
 * @param {number} defaultIndex
 */
export function select(question, choices, defaultIndex = 0) {
  if (!isInteractive()) return Promise.resolve(choices[defaultIndex].value);

  return new Promise((resolve) => {
    let idx = defaultIndex;
    const render = (first = false) => {
      if (!first) process.stdout.write(`\x1b[${choices.length}A`); // move up
      for (let i = 0; i < choices.length; i++) {
        const c = choices[i];
        const line =
          i === idx
            ? `  ${cyan("❯")} ${bold(c.label)}${c.hint ? dim(`  ${c.hint}`) : ""}`
            : `    ${c.label}${c.hint ? dim(`  ${c.hint}`) : ""}`;
        process.stdout.write(`\x1b[2K${line}\n`);
      }
    };

    console.log(`  ${bold(question)} ${dim("(↑/↓, enter)")}`);
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
        // replace menu with the picked answer
        process.stdout.write(`\x1b[${choices.length}A`);
        for (let i = 0; i < choices.length; i++) process.stdout.write(`\x1b[2K\n`);
        process.stdout.write(`\x1b[${choices.length}A`);
        console.log(`  ${green("✔")} ${choices[idx].label}\n`);
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

/**
 * Free-text input with optional default and validator.
 * @param {string} question
 * @param {{def?:string|null, validate?:(s:string)=>true|string}} opts
 */
export function input(question, { def = null, validate = null } = {}) {
  if (!isInteractive()) return Promise.resolve(def);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = def ? dim(` (${def})`) : "";

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
