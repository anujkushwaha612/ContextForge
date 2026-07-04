# Contributing to ContextForge

Thank you for your interest in contributing to ContextForge! 

The codebase is deliberately modular, making it easy to jump in:
- Pipeline stages are single files.
- The CLI's agent registry uses one entry per agent.

## Development Setup

```bash
git clone https://github.com/anujkushwaha612/ContextForge.git
cd ContextForge
npm install
bash scripts/vendor-grammars.sh    # pinned grammars
npm run build:native               # Node 20+, Python 3, C++ toolchain
npm link
cf doctor                          # should be all green
```

## Running Tests
*(Tests are currently in development, but you can run the following to verify your build)*
```bash
npm run test:cli
```

## Good First Areas
- Adding a new tree-sitter grammar (see `native/binding.gyp` and `scripts/vendor-grammars.sh`).
- Adding a new agent wrap definition in `cli/src/core/agents.js`.
- Adding a new MCP registrar in `src/mcp/registrars/`.

## Submitting Pull Requests
1. Fork the repository and create your branch from `main`.
2. Ensure `cf doctor` passes locally with your changes.
3. Open a Pull Request detailing the changes and linking to any relevant issues.
