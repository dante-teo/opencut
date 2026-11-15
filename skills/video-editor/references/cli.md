# OpenCut CLI

Use `opencut --help` to list the primary workflow. Use `opencut render --help`
for export controls or `opencut preview --help` for review commands. See the
repository's [CLI overview](../../../docs/CLI.md) for command examples.

Use `opencut recipes validate DEFINITION` and `opencut recipes inspect
DEFINITION --json` for recipe checks without transcoding. `opencut render`
automatically processes referenced recipes and reuses completed steps. The
`render --json` result reports `completed` and `cache-hit` recipe steps. Use
`--recipe-cache` to choose a cache and `--recipe-workers` and the other
[recipe flags](../../../docs/CLI.md#media-recipes) to set processing limits.
