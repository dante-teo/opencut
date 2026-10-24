---
name: video-editor
description: Use the OpenCut CLI to check its available commands and application version. Apply to requests about controlling OpenCut through its CLI; editing workflows are not available in T01.
---

# OpenCut CLI

This is the official product skill for external coding agents using OpenCut.
It will grow with the CLI to cover project inspection, modification, validation
and rendering. **None of those editing commands exists in T01.**

From an installed and built OpenCut checkout, run `pnpm cli --help` to discover
supported capabilities and `pnpm cli --version` to check the application version.
If the CLI has not been built, run `pnpm build` from the checkout root first.
For direct executable forms and output/exit-code details, read
[the current CLI reference](references/cli.md) when needed.

Only help/version are implemented. Do not invent project, import, edit, validate,
render, JSON-output or MCP commands. Explain this limitation when a requested
workflow needs them. These commands do not read or modify user media.
