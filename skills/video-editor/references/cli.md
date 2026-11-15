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

On macOS, `opencut system inspect --json` reports the VideoToolbox processor
and tested formats and dimensions. Recipe inspection checks declarations
and input streams. Use normal `validate` with the same recipe limits as
`render` to check whether the referenced AI recipe can actually build.
For enhancement, check `low-latency-super-resolution`,
`video-super-resolution`, or `temporal-noise-filter` in the system report.

Render a variant with `opencut render DEFINITION --params params.json -o final.mp4`.
Use the same parameter file with one-shot validation, inspection, preview
commands including `preview contact-sheet`, and subtitle export. Pass an array of `{ id, params, output? }` entries to
`opencut batch DEFINITION --variants variants.json --output-dir outputs --json`.
Read `variants` on stdout for the final status of each selected ID. Filter
stderr for objects with `event: "batch-progress"`.
The default filename is `<id>.mp4`. Use `--only id,id` for selective retries,
`--concurrency` for active job slots, and `--fail-fast` to cancel outstanding
work after a failure. See the [batch file contract and budgets](../../../docs/CLI.md#batch-rendering).
