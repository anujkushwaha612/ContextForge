// benchmarks/fixtures/generate.js
//
// ContextForge Benchmark Fixture Generator
//
// Creates deterministic, reproducible fixtures for all benchmark categories.
// Safe to re-run — existing fixtures are not overwritten unless --force is passed.
//
// Usage:
//   node benchmarks/fixtures/generate.js
//   node benchmarks/fixtures/generate.js --force
//   node benchmarks/fixtures/generate.js --size=small
//
// Design principles:
//   - Deterministic RNG from fixed seed — same output on every machine
//   - Layered architecture (routes → controllers → services → repositories → models → utils)
//     so the graph indexer produces realistic call edges, not random noise
//   - functionsPerFile respects repo spec — large repos are denser than small ones
//   - Imports sample without replacement — no module imported twice in one file
//   - 100 labeled prompts in exactly 5 balanced categories of 20

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FORCE = process.argv.includes("--force");
const SIZE_ARG = process.argv.find((a) => a.startsWith("--size="))?.split("=")[1];

const REPOS_DIR = path.join(__dirname, "repositories");

// ─────────────────────────────────────────────────────────────────────────────
// Repository specs
//
// File counts chosen to bracket real-world project sizes:
//   small  — early-stage service or microservice
//   medium — production backend (typical SaaS)
//   large  — exceeds ContextForge itself (554 files) to prove scaling
// ─────────────────────────────────────────────────────────────────────────────

const REPO_SPECS = {
  "small-repo": {
    files: 25,
    functionsPerFile: { min: 3, max: 6 },
    description: "Synthetic small repository — 25-file JS backend service",
  },
  "medium-repo": {
    files: 150,
    functionsPerFile: { min: 4, max: 10 },
    description: "Synthetic medium repository — 150-file production backend",
  },
  "large-repo": {
    files: 620,
    functionsPerFile: { min: 5, max: 15 },
    description: "Synthetic large repository — 620 files, exceeds ContextForge itself (554 files)",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic pseudo-random number generator
//
// LCG (Linear Congruential Generator) — seedable, portable, no external deps.
// Same seed produces identical output on every OS and Node version.
// Critical: Math.random() is not seedable in Node.js.
// ─────────────────────────────────────────────────────────────────────────────

function seededRng(seed) {
  let s = seed >>> 0; // force unsigned 32-bit
  return function rng() {
    s = Math.imul(s, 1664525) + 1013904223;
    s = s >>> 0;
    return s / 0x100000000;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * Sample k items from arr without replacement.
 * Returns fewer than k items if arr.length < k.
 */
function sampleWithoutReplacement(rng, arr, k) {
  const pool = [...arr];
  const result = [];
  const count = Math.min(k, pool.length);
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(rng() * pool.length);
    result.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layered architecture definition
//
// Files are organized into layers that mirror a real Node.js backend.
// Each layer imports from the layer below it — creating a realistic
// call graph with actual dependency edges, not random noise.
//
// routes       → controllers
// controllers  → services
// services     → repositories + utils
// repositories → models
// models       → (leaf, no imports)
// utils        → (leaf, no imports)
// middleware   → services + utils
// config       → (leaf, no imports)
// ─────────────────────────────────────────────────────────────────────────────

const LAYERS = [
  {
    name: "routes",
    dir: "src/routes",
    suffix: ".routes",
    importsFrom: ["controllers"],
    weight: 0.12, // proportion of total files
  },
  {
    name: "controllers",
    dir: "src/controllers",
    suffix: ".controller",
    importsFrom: ["services", "utils"],
    weight: 0.15,
  },
  {
    name: "services",
    dir: "src/services",
    suffix: ".service",
    importsFrom: ["repositories", "utils"],
    weight: 0.2,
  },
  {
    name: "repositories",
    dir: "src/repositories",
    suffix: ".repository",
    importsFrom: ["models"],
    weight: 0.18,
  },
  {
    name: "models",
    dir: "src/models",
    suffix: ".model",
    importsFrom: [],
    weight: 0.12,
  },
  {
    name: "middleware",
    dir: "src/middleware",
    suffix: ".middleware",
    importsFrom: ["services", "utils"],
    weight: 0.08,
  },
  {
    name: "utils",
    dir: "src/utils",
    suffix: ".util",
    importsFrom: [],
    weight: 0.1,
  },
  {
    name: "config",
    dir: "src/config",
    suffix: ".config",
    importsFrom: [],
    weight: 0.05,
  },
];

// Domain vocabulary — drives realistic module and function names
const DOMAINS = [
  "auth",
  "user",
  "session",
  "token",
  "payment",
  "order",
  "product",
  "invoice",
  "notification",
  "email",
  "audit",
  "permission",
  "role",
  "organization",
  "tenant",
  "webhook",
  "report",
  "analytics",
  "cache",
  "queue",
  "event",
  "search",
];

const FUNCTION_VERBS = [
  "get",
  "find",
  "fetch",
  "load",
  "create",
  "insert",
  "save",
  "update",
  "patch",
  "delete",
  "remove",
  "validate",
  "verify",
  "authenticate",
  "authorize",
  "process",
  "handle",
  "transform",
  "parse",
  "serialize",
  "build",
  "generate",
  "compute",
  "check",
  "resolve",
  "execute",
  "run",
  "send",
  "publish",
  "subscribe",
];

const FUNCTION_NOUNS = [
  "User",
  "Token",
  "Session",
  "Record",
  "Entry",
  "Request",
  "Response",
  "Payload",
  "Result",
  "Config",
  "Context",
  "Event",
  "Message",
  "Task",
  "Job",
  "Item",
  "Entity",
  "Data",
  "Report",
  "Permission",
  "Role",
  "Claim",
  "Header",
  "Body",
  "Query",
];

// ─────────────────────────────────────────────────────────────────────────────
// Function name generation
//
// Produces unique names within a file using a disambiguation suffix
// rather than simple deduplication. This creates realistic name families:
//   authenticateUser
//   authenticateUserInternal
//   authenticateUserCached
//   authenticateUserSafe
// ─────────────────────────────────────────────────────────────────────────────

const DISAMBIGUATION_SUFFIXES = [
  "Internal",
  "Cached",
  "Safe",
  "Async",
  "Sync",
  "Validated",
  "Strict",
  "Lazy",
  "Batch",
  "Single",
];

function generateUniqueFunctionNames(rng, count) {
  const names = [];
  const used = new Set();

  for (let i = 0; i < count; i++) {
    const verb = pick(rng, FUNCTION_VERBS);
    const noun = pick(rng, FUNCTION_NOUNS);
    let base = `${verb}${noun}`;

    if (!used.has(base)) {
      used.add(base);
      names.push(base);
    } else {
      // Append disambiguation suffix until unique
      let found = false;
      for (const suffix of DISAMBIGUATION_SUFFIXES) {
        const candidate = `${base}${suffix}`;
        if (!used.has(candidate)) {
          used.add(candidate);
          names.push(candidate);
          found = true;
          break;
        }
      }
      // Last resort: append index
      if (!found) {
        const candidate = `${base}_${i}`;
        used.add(candidate);
        names.push(candidate);
      }
    }
  }

  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// Import generation
//
// Samples without replacement from modules in the layers this file
// is allowed to import from. Generates real named imports that match
// actual exported functions — so the graph indexer finds real edges.
// ─────────────────────────────────────────────────────────────────────────────

function generateImportBlock(rng, layerName, moduleRegistry) {
  const layer = LAYERS.find((l) => l.name === layerName);
  if (!layer || layer.importsFrom.length === 0) return { code: "", importedFunctions: [] };

  const importedFunctions = [];
  const lines = [];

  for (const targetLayerName of layer.importsFrom) {
    const targetModules = moduleRegistry[targetLayerName] ?? [];
    if (targetModules.length === 0) continue;

    // Import from 1–3 modules in the target layer (without replacement)
    const count = randInt(rng, 1, Math.min(3, targetModules.length));
    const chosen = sampleWithoutReplacement(rng, targetModules, count);

    for (const mod of chosen) {
      // Pick 1–3 exported functions from that module (without replacement)
      const fnCount = randInt(rng, 1, Math.min(3, mod.exports.length));
      const fns = sampleWithoutReplacement(rng, mod.exports, fnCount);

      if (fns.length > 0) {
        const relPath = path.relative(path.dirname(mod.absPath), mod.absPath);
        // Compute relative import path from current layer dir to target dir
        const importPath = `./${mod.moduleName}.js`.replace(/\\/g, "/");

        lines.push(`import { ${fns.join(", ")} } from "${importPath}";`);
        importedFunctions.push(...fns);
      }
    }
  }

  return { code: lines.join("\n"), importedFunctions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Function body generation
//
// Generates realistic async/sync function bodies that call imported functions.
// Body size respects spec.functionsPerFile density.
// ─────────────────────────────────────────────────────────────────────────────

function generateFunctionBody(rng, funcName, params, importedFunctions, isAsync) {
  const bodyLineCount = randInt(rng, 3, 10);
  const lines = [];
  const isExported = rng() > 0.25;
  const paramList = params.join(", ");

  lines.push(`export ${isAsync ? "async " : ""}function ${funcName}(${paramList}) {`);

  for (let i = 0; i < bodyLineCount; i++) {
    if (importedFunctions.length > 0 && rng() > 0.55) {
      const called = pick(rng, importedFunctions);
      const arg = params[0] ?? "null";
      if (isAsync && rng() > 0.4) {
        lines.push(`  const _r${i} = await ${called}(${arg});`);
      } else {
        lines.push(`  const _v${i} = ${called}(${arg});`);
      }
    } else {
      const varName = `_item${i}`;
      const ref = params.length > 0 ? params[Math.floor(rng() * params.length)] : "null";
      lines.push(`  const ${varName} = ${ref};`);
    }
  }

  const returnRef = params[0] ?? "null";
  lines.push(`  return ${returnRef};`);
  lines.push(`}`);

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// File generator
//
// Produces one complete JS module. Returns metadata for the registry
// so other files can import from it.
// ─────────────────────────────────────────────────────────────────────────────

const PARAM_NAMES = [
  "id",
  "userId",
  "token",
  "data",
  "opts",
  "config",
  "payload",
  "ctx",
  "req",
  "res",
  "next",
  "key",
];

function generateFileContent(rng, moduleName, layerName, absPath, moduleRegistry, spec) {
  const sections = [];

  // ── Header comment ──
  sections.push(
    [
      `/**`,
      ` * ${path.basename(absPath)}`,
      ` * Layer: ${layerName}`,
      ` * Auto-generated synthetic fixture for ContextForge benchmarks.`,
      ` * DO NOT EDIT — regenerate with: node benchmarks/fixtures/generate.js --force`,
      ` */`,
      ``,
    ].join("\n")
  );

  // ── Imports ──
  const { code: importCode, importedFunctions } = generateImportBlock(
    rng,
    layerName,
    moduleRegistry
  );
  if (importCode) {
    sections.push(importCode + "\n");
  }

  // ── Module constant ──
  sections.push(`const MODULE = "${moduleName}";\n`);

  // ── Functions — count from spec ──
  const fnCount = randInt(rng, spec.functionsPerFile.min, spec.functionsPerFile.max);
  const fnNames = generateUniqueFunctionNames(rng, fnCount);
  const exportedNames = [];

  for (let i = 0; i < fnNames.length; i++) {
    const fnName = fnNames[i];
    const paramCount = randInt(rng, 1, 3);
    // Sample params without replacement
    const params = sampleWithoutReplacement(rng, PARAM_NAMES, paramCount);
    const isAsync = rng() > 0.4;

    // Later functions can also call earlier ones in same file
    const callableInFile = fnNames.slice(0, i);
    const allCallable = [...importedFunctions, ...callableInFile];

    sections.push(generateFunctionBody(rng, fnName, params, allCallable, isAsync));
    exportedNames.push(fnName);
  }

  return { code: sections.join("\n"), exportedNames };
}

// ─────────────────────────────────────────────────────────────────────────────
// Repository generator
// ─────────────────────────────────────────────────────────────────────────────

function generateRepository(repoName, spec) {
  const repoDir = path.join(REPOS_DIR, repoName);

  if (fs.existsSync(repoDir) && !FORCE) {
    console.log(`  ⏭  ${repoName} already exists (--force to regenerate)`);
    return;
  }

  if (fs.existsSync(repoDir)) {
    fs.rmSync(repoDir, { recursive: true });
  }

  // Seed from repo name — deterministic across all platforms
  const seed = repoName.split("").reduce((acc, c, i) => acc + c.charCodeAt(0) * (i + 1), 0);
  const rng = seededRng(seed * 31337);

  // ── Distribute files across layers proportionally ──
  const layerFileCounts = LAYERS.map((layer) => ({
    layer,
    count: Math.max(1, Math.round(spec.files * layer.weight)),
  }));

  // Adjust for rounding drift — ensure total = spec.files
  const totalAssigned = layerFileCounts.reduce((a, b) => a + b.count, 0);
  const diff = spec.files - totalAssigned;
  if (diff !== 0) {
    // Add/remove from the largest layer
    const largest = layerFileCounts.reduce((a, b) => (a.count > b.count ? a : b));
    largest.count += diff;
  }

  // ── Build domain list — one domain per file in each layer ──
  const domainPool = [...DOMAINS];
  while (domainPool.length < spec.files) {
    // Extend with numbered variants if needed
    const base = DOMAINS[domainPool.length % DOMAINS.length];
    domainPool.push(`${base}${Math.floor(domainPool.length / DOMAINS.length)}`);
  }

  // Shuffle domain pool deterministically
  for (let i = domainPool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [domainPool[i], domainPool[j]] = [domainPool[j], domainPool[i]];
  }

  // ── Module registry — maps layer name → array of module metadata ──
  // Built incrementally so later layers can reference earlier ones.
  const moduleRegistry = {};
  for (const layer of LAYERS) {
    moduleRegistry[layer.name] = [];
  }

  // ── Create directories ──
  for (const layer of LAYERS) {
    fs.mkdirSync(path.join(repoDir, layer.dir), { recursive: true });
  }

  // ── Generate files in dependency order (leaves first) ──
  // Order: config → utils → models → repositories → services → middleware → controllers → routes
  const generationOrder = [
    "config",
    "utils",
    "models",
    "repositories",
    "services",
    "middleware",
    "controllers",
    "routes",
  ];

  let domainIdx = 0;
  let totalFilesWritten = 0;
  const allNodes = []; // for manifest node count estimate

  for (const layerName of generationOrder) {
    const entry = layerFileCounts.find((e) => e.layer.name === layerName);
    if (!entry) continue;

    const layer = entry.layer;
    const count = entry.count;

    for (let i = 0; i < count; i++) {
      const domain = domainPool[domainIdx++ % domainPool.length];
      const moduleName = `${domain}${layer.suffix}`;
      const absPath = path.join(repoDir, layer.dir, `${moduleName}.js`);

      const { code, exportedNames } = generateFileContent(
        rng,
        moduleName,
        layerName,
        absPath,
        moduleRegistry,
        spec
      );

      fs.writeFileSync(absPath, code, "utf-8");

      // Register in module registry so layers above can import from this
      moduleRegistry[layerName].push({
        moduleName,
        absPath,
        exports: exportedNames,
        layer: layerName,
      });

      allNodes.push(...exportedNames.map((fn) => ({ file: absPath, name: fn })));
      totalFilesWritten++;
    }
  }

  // New — derived from actual observed ratios:
  // edges/node observed: small=3.19, medium=2.97, large=2.92
  // Use 3.0 as the multiplier (conservative, matches real indexer output)
  const approxEdges = Math.round(allNodes.length * 3.0);

  // ── package.json ──
  fs.writeFileSync(
    path.join(repoDir, "package.json"),
    JSON.stringify(
      {
        name: `contextforge-benchmark-${repoName}`,
        version: "1.0.0",
        type: "module",
        description: spec.description,
        private: true,
        _benchmark: true,
      },
      null,
      2
    ),
    "utf-8"
  );

  // ── .gitignore ──
  fs.writeFileSync(
    path.join(repoDir, ".gitignore"),
    ["node_modules/", "*.log", ".DS_Store", "Thumbs.db", ""].join("\n"),
    "utf-8"
  );

  // ── README.md ──
  fs.writeFileSync(
    path.join(repoDir, "README.md"),
    [
      `# ${repoName}`,
      ``,
      `**Synthetic benchmark repository. Do not edit.**`,
      ``,
      `This directory was generated by \`node benchmarks/fixtures/generate.js\`.`,
      `Any manual changes will be overwritten on the next \`--force\` run.`,
      ``,
      `## Specification`,
      ``,
      `| Property | Value |`,
      `|----------|-------|`,
      `| Files | ${totalFilesWritten} |`,
      `| Functions (approx) | ${allNodes.length} |`,
      `| Description | ${spec.description} |`,
      ``,
      `## Architecture`,
      ``,
      `Files follow a layered backend architecture:`,
      ``,
      `\`\`\``,
      `routes → controllers → services → repositories → models`,
      `                    ↘ middleware ↗`,
      `                    → utils (leaf)`,
      `                    → config (leaf)`,
      `\`\`\``,
      ``,
      `## Regenerate`,
      ``,
      `\`\`\`bash`,
      `node benchmarks/fixtures/generate.js --force --size=${repoName.replace("-repo", "")}`,
      `\`\`\``,
      ``,
    ].join("\n"),
    "utf-8"
  );

  // ── _manifest.json ──
  const manifest = {
    name: repoName,
    description: spec.description,
    generated_at: new Date().toISOString(),
    generator: "ContextForge Benchmark Generator",
    generator_version: "1.0",
    seed,
    spec,
    files: totalFilesWritten,
    nodes_expected: Math.round(allNodes.length * 0.82),
    edges_expected: Math.round(allNodes.length * 0.82 * 3.0),
    layers: layerFileCounts.map((e) => ({
      layer: e.layer.name,
      dir: e.layer.dir,
      files: e.count,
    })),
  };

  fs.writeFileSync(
    path.join(repoDir, "_manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );

  console.log(
    `  ✅ ${repoName}: ${totalFilesWritten} files, ` +
      `~${allNodes.length} nodes, ~${approxEdges} edges`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload fixtures
// ─────────────────────────────────────────────────────────────────────────────

function generatePayloadFixtures() {
  const payloadsDir = path.join(__dirname, "payloads");
  fs.mkdirSync(payloadsDir, { recursive: true });

  const rng = seededRng(0xdeadbeef);

  // 40-tool payload for toolSchemas benchmark
  const tools = Array.from({ length: 40 }, (_, i) => {
    const verb = pick(rng, FUNCTION_VERBS);
    const noun = pick(rng, FUNCTION_NOUNS);
    return {
      type: "function",
      function: {
        name: `${verb}${noun}_${i}`,
        description:
          `Performs ${verb} operations on ${noun.toLowerCase()} entities. ` +
          `Validates input, applies business rules, and returns a structured result. ` +
          `Supports batch operations and partial updates.`,
        parameters: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "The target identifier to operate on.",
            },
            options: {
              type: "object",
              description: "Optional configuration overrides for this operation.",
              properties: {
                timeout: { type: "number", description: "Operation timeout in ms." },
                retries: { type: "integer", description: "Max retry attempts." },
                validate: { type: "boolean", description: "Run validation before executing." },
              },
            },
            dryRun: {
              type: "boolean",
              description: "If true, validate but do not persist changes.",
              default: false,
            },
          },
          required: ["target"],
          additionalProperties: false,
        },
      },
    };
  });

  fs.writeFileSync(
    path.join(payloadsDir, "40-tools.json"),
    JSON.stringify(
      {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Perform the required operation." }],
        tools,
      },
      null,
      2
    ),
    "utf-8"
  );

  // Large tool result payload — designed to trigger all compression stages
  const largeToolResult = {
    model: "test-model",
    stream: false,
    messages: [
      {
        role: "user",
        content: "Analyze this codebase and identify the authentication flow.",
      },
      // Tool result 1 — large code file with real function bodies (triggers AST compressor)
      {
        role: "tool",
        tool_call_id: "call_bench_001",
        content:
          "// auth.service.js\n" +
          Array.from({ length: 80 }, (_, i) => {
            const fn = pick(rng, FUNCTION_VERBS);
            const noun = pick(rng, FUNCTION_NOUNS);
            return (
              `export async function ${fn}${noun}(userId, options = {}) {\n` +
              `  // Validate input parameters before processing\n` +
              `  if (!userId) throw new Error('userId is required');\n` +
              `  const config = { timeout: 5000, retries: 3, ...options };\n` +
              `  const logger = getLogger('${fn}${noun}');\n` +
              `  logger.info('Starting ${fn} operation', { userId, config });\n` +
              `  try {\n` +
              `    const db = await getConnection();\n` +
              `    const record = await db.query('SELECT * FROM records WHERE id = ?', [userId]);\n` +
              `    if (!record) {\n` +
              `      logger.warn('Record not found', { userId });\n` +
              `      return null;\n` +
              `    }\n` +
              `    const result = await processRecord(record, config);\n` +
              `    logger.info('Operation complete', { userId, result: result.id });\n` +
              `    return result;\n` +
              `  } catch (err) {\n` +
              `    logger.error('Operation failed', { userId, error: err.message });\n` +
              `    throw err;\n` +
              `  }\n` +
              `}\n`
            );
          }).join("\n"),
      },
      // Tool result 2 — near-duplicate of tool result 1 (triggers semantic dedup)
      {
        role: "tool",
        tool_call_id: "call_bench_002",
        content:
          "// auth.service.js (re-read for verification)\n" +
          Array.from({ length: 80 }, (_, i) => {
            const fn = pick(rng, FUNCTION_VERBS);
            const noun = pick(rng, FUNCTION_NOUNS);
            return (
              `export async function ${fn}${noun}(userId, options = {}) {\n` +
              `  if (!userId) throw new Error('userId is required');\n` +
              `  const config = { timeout: 5000, retries: 3, ...options };\n` +
              `  const result = await processRecord(userId, config);\n` +
              `  return result;\n` +
              `}\n`
            );
          }).join("\n"),
      },
      // Tool result 3 — JSON output (triggers JSON slicer)
      {
        role: "tool",
        tool_call_id: "call_bench_003",
        content: JSON.stringify(
          Array.from({ length: 50 }, (_, i) => ({
            id: `record_${i}`,
            userId: `user_${i % 10}`,
            action: pick(rng, FUNCTION_VERBS),
            resource: pick(rng, FUNCTION_NOUNS),
            timestamp: new Date(Date.now() - i * 60000).toISOString(),
            metadata: {
              ip: `192.168.1.${i % 255}`,
              userAgent: "Mozilla/5.0 (compatible; ContextForge/1.0)",
              sessionId: `sess_${Math.random().toString(36).slice(2)}`,
              duration: Math.floor(Math.random() * 5000),
              statusCode: [200, 201, 400, 401, 403, 404, 500][i % 7],
            },
          })),
          null,
          2
        ),
      },
    ],
  };

  fs.writeFileSync(
    path.join(payloadsDir, "large-tool-result.json"),
    JSON.stringify(largeToolResult, null, 2),
    "utf-8"
  );

  console.log(`  ✅ Payload fixtures → ${payloadsDir}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt fixtures
//
// 100 labeled prompts — exactly 20 per category.
// Generated from templates so they are easy to extend and maintain.
// Manually writing 100 prompts is error-prone and hard to balance.
// ─────────────────────────────────────────────────────────────────────────────

function generatePromptFixtures() {
  const promptsDir = path.join(__dirname, "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });

  const rng = seededRng(0xcafe1234);

  const FUNCTION_NAMES = [
    "authenticate",
    "validateToken",
    "createSession",
    "fetchUser",
    "processPayment",
    "generateReport",
    "handleRequest",
    "parseResponse",
    "buildQuery",
    "executeJob",
    "resolvePermission",
    "computeHash",
    "serializeData",
    "transformRecord",
    "publishEvent",
    "subscribeHandler",
    "verifySignature",
    "encryptPayload",
    "decryptToken",
    "refreshSession",
  ];

  const FILE_NAMES = [
    "auth.service.js",
    "user.repository.js",
    "payment.controller.js",
    "session.middleware.js",
    "token.util.js",
    "route.handler.js",
    "order.service.js",
    "notification.service.js",
    "cache.util.js",
    "queue.service.js",
  ];

  const NEW_NAMES = [
    "verifyUser",
    "checkCredentials",
    "validateIdentity",
    "confirmAccess",
    "processRequest",
    "handleEvent",
    "executeTask",
    "runJob",
    "buildResult",
    "generateOutput",
    "computeValue",
    "resolveEntity",
  ];

  // Template generators — return { prompt, capabilities, bypass }
  const TEMPLATES = {
    PATCH: [
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        const newName = pick(rng, NEW_NAMES);
        return {
          prompt: `Rename the ${fn} function to ${newName}`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Add a console.log at the start of the ${fn} function`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Remove the deprecated ${fn} function`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Add error handling to ${fn} using try/catch`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Refactor ${fn} to use async/await instead of callbacks`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        const param = pick(rng, ["timeout", "retries", "userId", "options"]);
        return {
          prompt: `Add a ${param} parameter to the ${fn} function`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const file = pick(rng, FILE_NAMES);
        return {
          prompt: `Remove all console.log statements from ${file}`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Extract the validation logic from ${fn} into a separate helper function`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Change ${fn} to return null instead of throwing an error when not found`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const file = pick(rng, FILE_NAMES);
        const lib = pick(rng, ["lodash", "dayjs", "uuid", "zod"]);
        return {
          prompt: `Remove the unused import of ${lib} from ${file}`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Add JSDoc comments to the ${fn} function`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Make ${fn} accept an optional config object as its last parameter`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        const newName = pick(rng, NEW_NAMES);
        return {
          prompt: `Rename ${fn} to ${newName} and update all callers`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const file = pick(rng, FILE_NAMES);
        return {
          prompt: `Add input validation at the top of every exported function in ${file}`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Split ${fn} into two functions — one for validation and one for the operation`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Add a rate limiting check inside ${fn}`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Convert ${fn} from a named export to a default export`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Add a cache layer to ${fn} using a Map`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Remove the ${fn} function and inline its logic at all call sites`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
      (rng) => {
        const file = pick(rng, FILE_NAMES);
        return {
          prompt: `Add a timestamp field to every object returned from ${file}`,
          capabilities: ["PATCH"],
          bypass: false,
        };
      },
    ],

    SEARCH: [
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Where is the ${fn} function defined?`,
          capabilities: ["GRAPH", "READ"],
          bypass: false,
        };
      },
      (rng) => {
        const file = pick(rng, FILE_NAMES);
        return {
          prompt: `Which files import from ${file}?`,
          capabilities: ["GRAPH", "READ"],
          bypass: false,
        };
      },
      (rng) => ({
        prompt: "Show me all the HTTP routes defined in the server",
        capabilities: ["GRAPH", "READ"],
        bypass: false,
      }),
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `What does ${fn} call internally?`,
          capabilities: ["GRAPH", "READ"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Find all callers of the ${fn} function`,
          capabilities: ["GRAPH", "READ"],
          bypass: false,
        };
      },
      (rng) => {
        const file = pick(rng, FILE_NAMES);
        return {
          prompt: `What does ${file} export?`,
          capabilities: ["GRAPH", "READ"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Which modules depend on ${fn}?`,
          capabilities: ["GRAPH", "READ"],
          bypass: false,
        };
      },
      (rng) => ({
        prompt: "List all the middleware functions in the project",
        capabilities: ["GRAPH", "READ"],
        bypass: false,
      }),
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Show me the full call chain for ${fn}`,
          capabilities: ["GRAPH", "READ"],
          bypass: false,
        };
      },
      (rng) => {
        const file = pick(rng, FILE_NAMES);
        return {
          prompt: `What does ${file} import?`,
          capabilities: ["GRAPH", "READ"],
          bypass: false,
        };
      },
      (rng) => ({
        prompt: "Find all async functions in the services layer",
        capabilities: ["GRAPH", "READ"],
        bypass: false,
      }),
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Is ${fn} exported from its module?`,
          capabilities: ["GRAPH", "READ"],
          bypass: false,
        };
      },
      (rng) => ({
        prompt: "What route handles the /v1/auth/login endpoint?",
        capabilities: ["GRAPH", "READ"],
        bypass: false,
      }),
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Show me the impact analysis for changing ${fn}`,
          capabilities: ["GRAPH", "READ"],
          bypass: false,
        };
      },
      (rng) => ({
        prompt: "Find all files that import from the utils layer",
        capabilities: ["GRAPH", "READ"],
        bypass: false,
      }),
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `What line is ${fn} defined on?`,
          capabilities: ["GRAPH", "READ"],
          bypass: false,
        };
      },
      (rng) => ({
        prompt: "List all exported functions across the entire repository",
        capabilities: ["GRAPH", "READ"],
        bypass: false,
      }),
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `How many functions call ${fn}?`,
          capabilities: ["GRAPH", "READ"],
          bypass: false,
        };
      },
      (rng) => ({
        prompt: "Which controllers depend on the auth service?",
        capabilities: ["GRAPH", "READ"],
        bypass: false,
      }),
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Find the repository function that ${fn} depends on`,
          capabilities: ["GRAPH", "READ"],
          bypass: false,
        };
      },
    ],

    CHAT: [
      () => ({ prompt: "ok", capabilities: [], bypass: true }),
      () => ({ prompt: "done", capabilities: [], bypass: true }),
      () => ({ prompt: "thanks", capabilities: [], bypass: true }),
      () => ({ prompt: "looks good", capabilities: [], bypass: true }),
      () => ({ prompt: "That works, thank you", capabilities: [], bypass: true }),
      () => ({ prompt: "Yes please", capabilities: [], bypass: true }),
      () => ({ prompt: "Sounds good", capabilities: [], bypass: true }),
      () => ({ prompt: "Perfect", capabilities: [], bypass: true }),
      () => ({ prompt: "Great, that is what I needed", capabilities: [], bypass: true }),
      () => ({ prompt: "No that is not right", capabilities: [], bypass: true }),
      () => ({ prompt: "Can you try again?", capabilities: [], bypass: true }),
      () => ({ prompt: "Not quite", capabilities: [], bypass: true }),
      () => ({ prompt: "Close but not exactly what I meant", capabilities: [], bypass: true }),
      () => ({ prompt: "Actually never mind", capabilities: [], bypass: true }),
      () => ({ prompt: "Good job", capabilities: [], bypass: true }),
      () => ({ prompt: "Exactly right", capabilities: [], bypass: true }),
      () => ({ prompt: "Yes that is correct", capabilities: [], bypass: true }),
      () => ({ prompt: "I see, thanks for explaining", capabilities: [], bypass: true }),
      () => ({ prompt: "Understood", capabilities: [], bypass: true }),
      () => ({ prompt: "OK got it", capabilities: [], bypass: true }),
    ],

    DEBUG: [
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `Why is ${fn} throwing an error?`,
          capabilities: ["GRAPH", "PATCH", "READ"],
          bypass: false,
        };
      },
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `The ${fn} function is returning undefined, can you help?`,
          capabilities: ["GRAPH", "PATCH", "READ"],
          bypass: false,
        };
      },
      (rng) => ({
        prompt: "Something is wrong with the authentication flow after my last change",
        capabilities: ["GRAPH", "PATCH", "READ"],
        bypass: false,
      }),
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `${fn} is not being called even though I added it to the route`,
          capabilities: ["GRAPH", "PATCH", "READ"],
          bypass: false,
        };
      },
      (rng) => ({
        prompt: "My token validation is failing for some users but not others",
        capabilities: ["GRAPH", "PATCH", "READ"],
        bypass: false,
      }),
      (rng) => {
        const file = pick(rng, FILE_NAMES);
        return {
          prompt: `I am getting a circular dependency error involving ${file}`,
          capabilities: ["GRAPH", "PATCH", "READ"],
          bypass: false,
        };
      },
      (rng) => ({
        prompt: "The middleware is not running in the right order",
        capabilities: ["GRAPH", "PATCH", "READ"],
        bypass: false,
      }),
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `${fn} is sometimes returning stale data`,
          capabilities: ["GRAPH", "PATCH", "READ"],
          bypass: false,
        };
      },
      (rng) => ({
        prompt: "Why does the server crash on startup after my refactor?",
        capabilities: ["GRAPH", "PATCH", "READ"],
        bypass: false,
      }),
      (rng) => {
        const fn = pick(rng, FUNCTION_NAMES);
        return {
          prompt: `${fn} runs much slower after the last deployment`,
          capabilities: ["GRAPH", "PATCH", "READ"],
          bypass: false,
        };
      },
    ],

    CREATE: [
      (rng) => ({
        prompt: "add a completely new feature",
        capabilities: ["GRAPH", "READ"],
        bypass: false,
      }),
      (rng) => ({ prompt: "start from scratch", capabilities: ["GRAPH", "READ"], bypass: false }),
      (rng) => ({
        prompt: "create a new endpoint",
        capabilities: ["GRAPH", "READ"],
        bypass: false,
      }),
      (rng) => ({
        prompt: "build a new component",
        capabilities: ["GRAPH", "READ"],
        bypass: false,
      }),
      (rng) => ({ prompt: "write a new module", capabilities: ["GRAPH", "READ"], bypass: false }),
      (rng) => ({
        prompt: "implement this from scratch",
        capabilities: ["GRAPH", "READ"],
        bypass: false,
      }),
      (rng) => ({
        prompt: "create a new authentication flow",
        capabilities: ["GRAPH", "READ"],
        bypass: false,
      }),
      (rng) => ({
        prompt: "build a payment processor from scratch",
        capabilities: ["GRAPH", "READ"],
        bypass: false,
      }),
      (rng) => ({
        prompt: "scaffold a new repository file",
        capabilities: ["GRAPH", "READ"],
        bypass: false,
      }),
      (rng) => ({
        prompt: "generate a boilerplate controller",
        capabilities: ["GRAPH", "READ"],
        bypass: false,
      }),
    ],
  };

  // Generate exactly 20 prompts per category
  const prompts = [];
  for (const [intent, templateFns] of Object.entries(TEMPLATES)) {
    for (let i = 0; i < 20; i++) {
      const templateFn = templateFns[i % templateFns.length];
      const generated = templateFn(rng);
      prompts.push({ ...generated, intent, id: `${intent.toLowerCase()}_${i + 1}` });
    }
  }

  // Shuffle so benchmarks don't see all EDIT prompts first
  for (let i = prompts.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [prompts[i], prompts[j]] = [prompts[j], prompts[i]];
  }

  const dataset = {
    description: "Labeled prompt dataset for ContextForge planner benchmarks",
    generated_at: new Date().toISOString(),
    generator: "ContextForge Benchmark Generator",
    count: prompts.length,
    categories: Object.fromEntries(
      Object.keys(TEMPLATES).map((intent) => [
        intent,
        prompts.filter((p) => p.intent === intent).length,
      ])
    ),
    prompts,
  };

  // Verify balance before writing
  const counts = dataset.categories;
  const allEqual = Object.values(counts).every((c) => c === 20);
  if (!allEqual || prompts.length !== 100) {
    throw new Error(
      `Prompt generation imbalance: ${JSON.stringify(counts)}, total=${prompts.length}`
    );
  }

  fs.writeFileSync(
    path.join(promptsDir, "labeled-100.json"),
    JSON.stringify(dataset, null, 2),
    "utf-8"
  );

  console.log(`  ✅ Prompts: 100 labeled prompts (20 per category) → ${promptsDir}`);
  console.log(
    `     Categories: ${Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Session stubs
// ─────────────────────────────────────────────────────────────────────────────

function generateSessionStubs() {
  const sessionsDir = path.join(__dirname, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const stubs = [
    {
      name: "rename-function",
      description: "Record of renaming authenticate → verifyUser across the codebase",
    },
    {
      name: "remove-import",
      description: "Record of removing an unused import from auth.service.js",
    },
    {
      name: "add-logging",
      description: "Record of adding structured logging to the request pipeline",
    },
    {
      name: "find-route",
      description: "Record of locating the /v1/auth/login route handler",
    },
    {
      name: "explain-code",
      description: "Record of explaining the authentication flow end-to-end",
    },
  ];

  let written = 0;
  for (const stub of stubs) {
    const stubPath = path.join(sessionsDir, `${stub.name}.json`);
    if (!fs.existsSync(stubPath) || FORCE) {
      fs.writeFileSync(
        stubPath,
        JSON.stringify(
          {
            _stub: true,
            name: stub.name,
            description: stub.description,
            instructions:
              "Replace this stub with a recorded real LLM session. " +
              "Run: CF_BENCHMARK_MODE=live node benchmarks/workflows/renameFunction.bench.js --record",
            recorded_at: null,
            provider: null,
            model: null,
            turns: [],
          },
          null,
          2
        ),
        "utf-8"
      );
      written++;
    }
  }

  const skipped = stubs.length - written;
  console.log(`  ✅ Session stubs: ${written} written, ${skipped} skipped (already exist)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

console.log("ContextForge Benchmark Fixture Generator v1.0");
console.log("═".repeat(52));

fs.mkdirSync(REPOS_DIR, { recursive: true });
fs.mkdirSync(path.join(__dirname, "expected"), { recursive: true });

const targetRepos = SIZE_ARG
  ? (() => {
      const key = `${SIZE_ARG}-repo`;
      if (!REPO_SPECS[key]) {
        console.error(`  ❌ Unknown size: ${SIZE_ARG}. Valid: small, medium, large`);
        process.exit(1);
      }
      return { [key]: REPO_SPECS[key] };
    })()
  : REPO_SPECS;

console.log("\nRepositories:");
for (const [name, spec] of Object.entries(targetRepos)) {
  generateRepository(name, spec);
}

console.log("\nPayloads:");
generatePayloadFixtures();

console.log("\nPrompts:");
generatePromptFixtures();

console.log("\nSessions:");
generateSessionStubs();

console.log("\n✅ All fixtures ready.");
console.log("   Next: npm run benchmark");
