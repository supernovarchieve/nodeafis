# nodeAFIS

Port murni TypeScript dari **SourceAFIS 3.18.1** ([sourceafis-java](https://github.com/robertvazan/sourceafis-java), Apache-2.0) — extractor + matcher lengkap, zero runtime dependency.

Versi di-pin ke 3.18.1 agar setara persis dengan `sourceafis-sidecar/`. Terverifikasi **bit-exact** terhadap Java:

- **Matcher**: 49/49 pasangan template (sintetis + scan asli device) menghasilkan skor double yang identik bit-per-bit.
- **Extractor**: 7/7 image menghasilkan template yang identik (posisi, arah, tipe, urutan minutiae).

Kesetaraan numerik dicapai dengan: emulasi float 32-bit Java via `Math.fround`, `Math.imul`/`BigInt` untuk overflow int/long, replika `java.util.PriorityQueue` (urutan tie), dan LUT ICC gray→sRGB milik `BufferedImage.getRGB()` untuk PNG grayscale.

## Pakai

```ts
import { FingerprintTemplate, FingerprintMatcher, FingerprintImage } from 'nodeafis';

// Enrollment: image → template (PNG grayscale/RGB, PGM P5, atau raw grayscale)
const image = FingerprintImage.decode(fs.readFileSync('scan.png')); // { dpi: 500 } default
const template = FingerprintTemplate.fromImage(image);
fs.writeFileSync('scan.tpl', template.toByteArray()); // CBOR, kompatibel Java

// Identify 1:N: probe vs gallery
const probe = new FingerprintTemplate(fs.readFileSync('probe.tpl'));
const matcher = new FingerprintMatcher(probe);
const score = matcher.match(template); // >= 40 ≈ FMR 0.01%
```

`.tpl` bisa dibaca-tulis silang dengan sidecar Java — format dan isinya sama.

## Verifikasi

```bash
npm run build && npm test        # self-check (CBOR round-trip, matcher, extractor determinism)
npm run parity                   # paritas skor matcher vs sidecar Java
npm run parity:extract           # paritas template extractor vs sidecar Java
```

Harness paritas membandingkan output nodeafis dengan SourceAFIS Java 3.18.1 asli lewat HTTP.
Sediakan wrapper kecil (Javalin/Spring/apa pun) di `SOURCEAFIS_URL` (default `http://127.0.0.1:8089`) dengan endpoint:

- `POST /v1/extract` `{image: <base64>}` → `{template: <base64 dari FingerprintTemplate.toByteArray()>}`
- `POST /v1/gallery/upsert` `{outlet, memberId, fingerSlot, template}` / `DELETE /v1/gallery` `{outlet}`
- `POST /v1/identify-template` `{outlet, template, topK}` → `{top: [{memberId, score}]}`

## Catatan implementasi

- `src/cbor.ts` — codec CBOR minimal (pengganti jackson-dataformat-cbor)
- `src/primitives.ts` — FloatAngle (fround), DoubleAngle, replika PriorityQueue Java
- `src/templates.ts` — SearchTemplate, edge table, parameter algoritma
- `src/matcher.ts` — edge hash, root enumeration, pairing, scoring
- `src/image.ts` — DoubleMatrix + decoder PNG/PGM/raw (termasuk LUT gray→sRGB)
- `src/extractor.ts` — pipeline image → minutiae (equalization, orientasi, smoothing, binarisasi, mask)
- `src/skeletons.ts` — thinning, tracing, filter skeleton (pore/gap/tail/fragment/knot)

Batasan yang disengaja: decoder image hanya PNG 8-bit (gray/RGB/RGBA, non-interlaced), PGM P5, dan raw grayscale — tidak ada JPEG/WSQ/TIFF. Transparency API SourceAFIS tidak di-port.
