# Motion compositions

`field-notes`, `prism`, `waterline` and `signal` have editable JSON and
TypeScript entries. The TypeScript examples share the adjacent scene data,
and define variant schemas where applicable. `relay` and `parallax` use
the optional Lottie and Three.js adapters. `readiness.video.ts` contains
a custom React canvas graphic with explicit sample readiness.

For the comparison group, prepare the shared footage, audio and adapter
fixtures with `python3 tests/reference-motion/fixtures.py` from a checkout.
The two footage inputs are credited to the White House and the National
Park Service. This command verifies their pinned hashes. Generated media
goes into `tests/fixtures/generated/reference-motion/assets/`.

```sh
opencut validate examples/motion/waterline.video.json --json
opencut preview frame examples/motion/prism.video.json --frame 27 -o prism.png
opencut render examples/motion/waterline.video.json --params examples/motion/waterline-alt.params.json -o waterline.mp4
opencut package examples/motion/relay.video.json --root . -o relay-bundle
```

Use the [graphics reference](../../docs/GRAPHICS.md) for the authoring
contract and the [comparison specifications](../../tests/reference-motion/SPEC.md)
for the fixed evaluation landmarks.
