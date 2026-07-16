# nodeAFIS

A pure-TypeScript port of [SourceAFIS](https://sourceafis.machinezoo.com/) 3.18.1 — a fingerprint recognition engine — for Node.js. Both the **feature extractor** (image → template) and the **matcher** (1:1 and 1:N similarity scoring) are ported in full, with **zero runtime dependencies**.

The port is pinned to SourceAFIS 3.18.1 and is verified **bit-exact** against the Java reference implementation:

- **Matcher** — similarity scores are identical to the last bit of the IEEE 754 double across all verified probe/candidate pairs, on both synthetic images and real optical-sensor scans.
- **Extractor** — templates extracted from the same image are equivalent byte for byte: identical minutia positions, directions (binary32), types, and ordering.
- **Templates** — the CBOR template format is fully interoperable with SourceAFIS for Java: templates serialized by either implementation deserialize and match correctly in the other.

## Why

SourceAFIS ships official implementations for Java and .NET. Using it from Node.js traditionally requires a JVM sidecar process. nodeAFIS removes that dependency: fingerprint enrollment and identification run in-process, and existing template galleries produced by the Java version remain usable as-is.

## Installation

```bash
npm install github:martines205/nodeafis
```

Requires Node.js ≥ 18. No native modules, no external services.

## Quick start

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { FingerprintImage, FingerprintTemplate, FingerprintMatcher } from 'nodeafis';

// Enrollment: image → template
const image = FingerprintImage.decode(readFileSync('scan.png')); // PNG, PGM, or raw grayscale
const template = FingerprintTemplate.fromImage(image);
writeFileSync('scan.tpl', template.toByteArray()); // CBOR — interoperable with SourceAFIS Java

// Identification: probe vs. gallery (1:N)
const probe = new FingerprintTemplate(readFileSync('probe.tpl'));
const matcher = new FingerprintMatcher(probe);
const scores = gallery.map((candidate) => matcher.match(candidate));
```

Scores have the same meaning as in SourceAFIS: a score of **40** corresponds approximately to a false match rate (FMR) of 0.01%. See the [SourceAFIS documentation](https://sourceafis.machinezoo.com/java) for threshold guidance.

### Image input

| Source | API | Notes |
|---|---|---|
| Raw grayscale | `FingerprintImage.fromRaw(width, height, pixels, { dpi })` | 8-bit, 0 = black, row-major |
| PGM (P5) | `FingerprintImage.fromPgm(bytes, { dpi })` | 8-bit binary PGM |
| PNG | `FingerprintImage.fromPng(bytes, { dpi })` | 8-bit grayscale, RGB, or RGBA; non-interlaced |
| Auto-detect | `FingerprintImage.decode(bytes, { dpi })` | Sniffs PNG/PGM headers |

DPI defaults to 500. As with upstream SourceAFIS, the algorithm is not scale-invariant — set the DPI to match your sensor.

## How bit-exact equivalence is achieved

Porting numerical Java code to JavaScript naïvely produces *similar* results. nodeAFIS reproduces *identical* results by mirroring Java semantics precisely:

- **32-bit float arithmetic** — every Java `float` operation is emulated with `Math.fround`. For binary32 operands, computing `+`, `-`, `*`, `/` in binary64 and rounding to binary32 is provably equal to native binary32 arithmetic, so the emulation is exact.
- **Integer overflow** — Java `int` wraparound is reproduced with `Math.imul`/`| 0`; the extractor's orientation PRNG, which relies on deliberate 64-bit `long` overflow, is reproduced with `BigInt.asIntN(64, …)`.
- **Collection ordering** — `java.util.PriorityQueue` is re-implemented with the same binary-heap `siftUp`/`siftDown` algorithm, so ties are popped in exactly the same order during minutia pairing.
- **Color management** — for grayscale PNGs, Java's `BufferedImage.getRGB()` applies an ICC linear-gray → sRGB conversion rather than an identity mapping. nodeAFIS embeds the exact 256-entry lookup table produced by the reference JRE (Eclipse Temurin 17).
- **Floating-point expression order** — compound expressions preserve the reference implementation's evaluation order, including subtleties such as `Math.toRadians` operand order.

## Verifying the port

```bash
npm run build && npm test    # self-check: CBOR round-trip, matcher invariants, extractor determinism
npm run parity               # matcher score parity vs. SourceAFIS Java
npm run parity:extract       # extractor template parity vs. SourceAFIS Java
```

The parity harnesses compare nodeAFIS output against genuine SourceAFIS Java 3.18.1 over HTTP. Point `SOURCEAFIS_URL` (default `http://127.0.0.1:8089`) at any thin wrapper exposing:

- `POST /v1/extract` `{image: <base64>}` → `{template: <base64 of FingerprintTemplate.toByteArray()>}`
- `POST /v1/gallery/upsert` `{outlet, memberId, fingerSlot, template}` and `DELETE /v1/gallery` `{outlet}`
- `POST /v1/identify-template` `{outlet, template, topK}` → `{top: [{memberId, score}]}`

Both harnesses assert exact equality — any deviation, down to a single bit of a score double or a single minutia, fails the run.

## Performance

Measured on a desktop-class x86-64 CPU, single-threaded, 300×400 px @ 500 DPI:

| Operation | Time |
|---|---|
| Template extraction | ~200 ms per image |
| Matcher construction (probe indexing) | ~7 ms |
| 1:N matching | ~0.36 ms per candidate (~2,800 candidates/s) |

For larger galleries, shard candidates across `worker_threads` — matching is deterministic and each worker holds its own state, mirroring SourceAFIS's application-side parallelization model.

## Module map

| Module | Ports |
|---|---|
| `src/cbor.ts` | Minimal CBOR codec (replaces jackson-dataformat-cbor) |
| `src/primitives.ts` | `FloatAngle` (binary32), `DoubleAngle`, Java-equivalent `PriorityQueue` |
| `src/templates.ts` | `SearchTemplate`, neighbor-edge table, algorithm parameters |
| `src/matcher.ts` | Edge hashing, root enumeration, pairing graph, scoring |
| `src/image.ts` | `DoubleMatrix`, PNG/PGM/raw decoding, gray→sRGB LUT |
| `src/extractor.ts` | Image pipeline: equalization, orientation field, oriented smoothing, binarization, segmentation masks |
| `src/skeletons.ts` | Binary thinning, ridge tracing, skeleton filters (dots, pores, gaps, tails, fragments, knots) |

## Scope and limitations

- Image decoding covers 8-bit PNG (grayscale/RGB/RGBA, non-interlaced), binary PGM, and raw grayscale buffers. JPEG, WSQ, TIFF, and BMP are out of scope — decode those upstream and pass raw grayscale.
- The SourceAFIS transparency/introspection API is not ported.
- Foreign template formats (ANSI 378, ISO 19794-2) are not ported; only the native CBOR template format is supported.
- Template compatibility is guaranteed against SourceAFIS **3.18.x** only. Upstream does not maintain template compatibility across versions, and neither does this port.

## License and attribution

Licensed under the [Apache License 2.0](LICENSE).

nodeAFIS is a derivative work of [SourceAFIS for Java](https://github.com/robertvazan/sourceafis-java), copyright Robert Važan and contributors, licensed under Apache 2.0. See [NOTICE](NOTICE) for details. This project is not affiliated with or endorsed by the SourceAFIS project.
