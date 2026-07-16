/* Self-check nodeafis: round-trip CBOR + invarian matcher + smoke extractor. Jalankan: node test/selfcheck.js */
const assert = require('node:assert');
const { FingerprintTemplate, FingerprintMatcher, FingerprintImage } = require('../dist/index');
const { encodePersistentTemplate } = require('../dist/cbor');

// LCG deterministik — bukan crypto, cuma data sintetis stabil antar run.
let seed = 42;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

function syntheticTemplate({ count, jitter = 0 }) {
  const positionsX = [];
  const positionsY = [];
  const directions = [];
  let types = '';
  for (let i = 0; i < count; i++) {
    positionsX.push(Math.floor(rand() * 280) + 10 + Math.round(jitter * (rand() - 0.5)));
    positionsY.push(Math.floor(rand() * 380) + 10 + Math.round(jitter * (rand() - 0.5)));
    directions.push(Math.fround(rand() * 6.28));
    types += rand() < 0.5 ? 'E' : 'B';
  }
  return encodePersistentTemplate({
    version: '3.18.1-java',
    width: 300,
    height: 400,
    positionsX,
    positionsY,
    directions,
    types,
  });
}

// 1. Round-trip: decode → encode → decode menghasilkan minutiae identik
const bytesA = syntheticTemplate({ count: 40 });
const a = new FingerprintTemplate(bytesA);
const a2 = new FingerprintTemplate(a.toByteArray());
assert.deepStrictEqual(a2.inner.minutiae, a.inner.minutiae, 'round-trip minutiae mismatch');

// 2. Self-match: skor tinggi, deterministik antar pemanggilan
const matcherA = new FingerprintMatcher(a);
const self1 = matcherA.match(a);
const self2 = matcherA.match(new FingerprintTemplate(bytesA));
assert.ok(self1 >= 40, `self-match score too low: ${self1}`);
assert.strictEqual(self1, self2, 'self-match not deterministic');

// 3. Non-match: template acak lain harus skor rendah
const b = new FingerprintTemplate(syntheticTemplate({ count: 40 }));
const cross = matcherA.match(b);
assert.ok(cross < self1, `cross score ${cross} not below self score ${self1}`);
assert.ok(cross < 40, `random cross-match unexpectedly above threshold: ${cross}`);

// 4. Empty template tidak match apa pun (perilaku Java: skor 0)
assert.strictEqual(new FingerprintMatcher(FingerprintTemplate.empty()).match(a), 0);
assert.strictEqual(matcherA.match(FingerprintTemplate.empty()), 0);

// 5. Template korup ditolak
assert.throws(() => new FingerprintTemplate(Buffer.from('bukan cbor')), /not a valid|CBOR/i);

// 6. Extractor smoke: ridge sintetis (sinus konsentris + mask elips) → minutiae deterministik
const W = 240;
const H = 320;
const pixels = new Uint8Array(W * H);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const nx = (x - W / 2) / (W * 0.42);
    const ny = (y - H / 2) / (H * 0.45);
    const inside = nx * nx + ny * ny < 1;
    // interferensi dua pusat gelombang → bifurcation/ending alami
    const r1 = Math.hypot(x - W * 0.35, y - H * 0.4);
    const r2 = Math.hypot(x - W * 0.7, y - H * 0.65);
    const wave = Math.sin(r1 / 3.5) + Math.sin(r2 / 3.5);
    pixels[y * W + x] = inside ? Math.round(128 + 60 * wave) : 255;
  }
const img = FingerprintImage.fromRaw(W, H, pixels);
const ex1 = FingerprintTemplate.fromImage(img);
const ex2 = FingerprintTemplate.fromImage(FingerprintImage.fromRaw(W, H, pixels));
assert.ok(ex1.inner.minutiae.length >= 5, `extractor found too few minutiae: ${ex1.inner.minutiae.length}`);
assert.deepStrictEqual(ex2.inner.minutiae, ex1.inner.minutiae, 'extraction not deterministic');
// Pola sintetis terlalu mulus untuk skor tinggi; yang penting: match dan positif.
const exSelf = new FingerprintMatcher(ex1).match(ex2);
assert.ok(exSelf > 0, `extracted self-match not positive: ${exSelf}`);

console.log(`OK — self=${self1.toFixed(4)} cross=${cross.toFixed(4)} extract=${ex1.inner.minutiae.length} minutiae, selfmatch=${exSelf.toFixed(2)}`);
