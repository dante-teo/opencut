# Targeted beauty workflow

1. Run `opencut beauty capabilities --json` and `opencut beauty preflight --json`.
   Use the [CPU setup instructions](../../../docs/BEAUTY.md#set-up-the-cpu-backend)
   when the runtime or model checks fail.
2. Run `opencut beauty analyze SOURCE --json` and
   `opencut beauty inspect ANALYSIS_ID --output NEW_DIRECTORY --json`. Review
   representative frames and valid intervals to bind the intended asset,
   shot and person. Confirm each person on crossings or partial visibility.
   Use the original recording and trim on the timeline when available.
   Additional frames from the same shot can reveal background behind the subject.
   If the deliverable's source is already an excerpt, use
   `--context-source ORIGINAL --context-start SECONDS` during analysis to add
   verified same-shot background observations. SECONDS is the excerpt's
   start in the original recording.
   For a head edit against a textured wall, include frames that reveal the
   wall beside the hair. Check flyaways against the original. For leg lifts,
   also check the old position of a moving hand or raised thigh for outlines.
3. Author bounded parameters in the first asset recipe and run
   `opencut beauty validate DEFINITION --json`. Use the
   [executable definition](../../../examples/video/beauty.video.ts) for a
   single subtle look, combined geometry and color, independent people,
   animated strengths, or protected regions. Reuse the analysis when tuning.
4. Preview easy and difficult intervals with
   `opencut preview clip DEFINITION --from N --to M --quality quality --output preview.mp4 --json`.
   Read `beauty[].recipeKey` and generate matched source evidence with
   `opencut beauty evaluate SOURCE --result KEY --from N --to M --output NEW_DIRECTORY --json`.
   Preview uses project frames. Evaluation uses source frames and verifies
   that the comparison preserves each selected frame's duration, including
   the last frame. Keep any `--recipe-memory-bytes` override consistent
   across planning, preview, and export so all three use the same budget.
5. Inspect crops and play the matched comparison at normal speed. Look at
   expressions, blinks, moving edges, foreground occlusions, background lines,
   and color consistency. Read requested and effective strength separately
   for each control. A skin control that leaves the picture unchanged is a
   bypass even when another control changes the same region.
   For head and limb edits, compare measured contour or limb changes with the
   framing and coverage in the video. Check shoulders, elbows, wrists, ankles,
   feet, and bright outlines around quickly moving hands.
   Use `--notes` and `--require-visual` when the delivery requires independent
   visual acceptance. Tracking confidence establishes observation coverage.
6. Make up to three preview attempts per look. Fix a measured cause by
   revising the track, interval, protection, or strength. Start from the
   authored definition and original media on each attempt. Keep the best
   valid attempt if the budget is exhausted. Use `complete-coverage` for
   exact requested strength. Use `visible-result` when the caller accepts
   bounded attenuation and requires a measurable, sustained reshape. Read
   `visibleResult` in the render report to locate weak intervals. Use
   `allow-limitations` for diagnostic footage or when the caller accepts
   the reported limitations.
7. Render the original media and project at the approved quality with
   `opencut render DEFINITION --quality quality --output final.mp4 --json`.
   Evaluate the final recipe key and check the final export with matched
   project frames or `opencut verify export`. Report the output, applied
   strengths, failed checks, bypassed intervals, and unreviewed dimensions.
   Use the same `--recipe-cache` and parameters throughout.

See [parameters, model versions, protections and report semantics](../../../docs/BEAUTY.md).
