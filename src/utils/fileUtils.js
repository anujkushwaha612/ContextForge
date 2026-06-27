import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export function detectMutation(payloadStr) {
  const fileOpMatch = payloadStr.match(
    /"operation"\s*:\s*"(create|append)"[^}]{0,300}"filename"\s*:\s*"([^"]+)"/,
  );
  if (fileOpMatch) return { isMutation: true, mutatedFile: fileOpMatch[2] };

  const redirectMatch = payloadStr.match(
    /"command"\s*:\s*"[^"]*>\s*([^\s"\\]+)"/,
  );
  if (redirectMatch) return { isMutation: true, mutatedFile: redirectMatch[1] };

  const destructiveMatch = payloadStr.match(
    /"command"\s*:\s*"(?:rm|mv|cp|touch|truncate|sed|awk)[^"]*\s([^\s"\\]+)"/i,
  );
  if (destructiveMatch)
    return { isMutation: true, mutatedFile: destructiveMatch[1] };

  return { isMutation: false, mutatedFile: null };
}

export function hashFile(filePath) {
  try {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      return createHash("sha256").update(content).digest("hex").slice(0, 16);
    }
  } catch {
    /* Ignore read errors */
  }
  return null;
}
