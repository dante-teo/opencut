# Repository instructions

- Use pnpm (never npm/npx); keep `pnpm-lock.yaml` synchronized with manifests.
- Use TypeScript, strict checking and ESM.
- Follow existing conventions, work on one task at a time and avoid unrelated changes.
- For UI/UX, avoid unnecessary secondary labels and descriptions. Let layout,
  grouping and visual hierarchy explain the interface; add supporting text only
  when it resolves real ambiguity.
- Check reliable maintained libraries before implementing a common capability;
  prefer an appropriate library unless its cost outweighs its benefit.
- Keep the core headless and independent of React and the CLI.
- Add meaningful tests for new behavior. Run `pnpm typecheck`, `pnpm lint`,
  `pnpm format:check`, `pnpm test` and `pnpm build` as appropriate.
- Media tools are optional development prerequisites; never silently install them.
- Never silently modify or overwrite user media. Generated fixtures belong only
  in `tests/fixtures/generated/`, are ignored by Git and must never contain user files.
- Keep project documentation in `docs/`; use `docs/adr/` for lasting architectural
  decisions when needed. `AGENTS.md` stays at the root as coding-agent instructions.
- Do not create development guides, validation reports or disposable task reports.
  Report validation results in chat.
- Keep documentation and the product Agent Skill synchronized with actual behavior.
  Do not invent CLI commands or prematurely implement later tasks.
- Summarize changes, validation results and anything not verified.

`skills/video-editor/SKILL.md` is the user-facing product skill, not a replacement
for these repository development instructions.
