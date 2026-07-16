#!/usr/bin/env node
/**
 * Paritas skor nodeafis vs sidecar SourceAFIS Java.
 * Gerbang verifikasi Fase 1: skor identify harus IDENTIK (bit-exact double).
 *
 * Usage:
 *   node test/parity-vs-sidecar.js [--url http://127.0.0.1:8089] [--dir /path/tpl] [--samples /tmp/sourceafis-samples]
 *
 * Tanpa --dir: extract template dari PNG di --samples via sidecar, simpan .tpl ke tmp.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { FingerprintTemplate, FingerprintMatcher } = require('../dist/index');

function parseArgs(argv) {
  const args = {
    url: process.env.SOURCEAFIS_URL || 'http://127.0.0.1:8089',
    dir: null,
    samples: '/tmp/sourceafis-samples',
    outlet: 'PARITY-NODEAFIS',
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--url') args.url = argv[++i];
    else if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--samples') args.samples = argv[++i];
    else if (argv[i] === '--outlet') args.outlet = argv[++i];
    else throw new Error(`Argumen tidak dikenal: ${argv[i]}`);
  }
  return args;
}

async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function ensureTemplates(args) {
  if (args.dir) return args.dir;
  const pngs = fs
    .readdirSync(args.samples)
    .filter((f) => f.endsWith('.png'))
    .sort();
  if (pngs.length === 0) throw new Error(`Tidak ada PNG di ${args.samples} — jalankan gen-synthetic-fingerprints.py dulu`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeafis-parity-'));
  for (const png of pngs) {
    const image = fs.readFileSync(path.join(args.samples, png)).toString('base64');
    const { template } = await req('POST', `${args.url}/v1/extract`, { image });
    fs.writeFileSync(path.join(dir, png.replace('.png', '.tpl')), Buffer.from(template, 'base64'));
  }
  console.log(`Extracted ${pngs.length} template → ${dir}`);
  return dir;
}

async function main() {
  const args = parseArgs(process.argv);
  const dir = await ensureTemplates(args);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.tpl'))
    .sort();
  const bytes = files.map((f) => fs.readFileSync(path.join(dir, f)));
  const templates = bytes.map((b) => new FingerprintTemplate(b));
  console.log(`${files.length} template: ${files.join(', ')}`);

  // Seed gallery sidecar
  await req('DELETE', `${args.url}/v1/gallery`, { outlet: args.outlet });
  for (let i = 0; i < files.length; i++)
    await req('POST', `${args.url}/v1/gallery/upsert`, {
      outlet: args.outlet,
      memberId: 1000 + i,
      fingerSlot: 1,
      template: bytes[i].toString('base64'),
    });

  let pairs = 0;
  let exact = 0;
  let maxDiff = 0;
  let rankMismatch = 0;
  for (let i = 0; i < files.length; i++) {
    const java = await req('POST', `${args.url}/v1/identify-template`, {
      outlet: args.outlet,
      template: bytes[i].toString('base64'),
      topK: files.length,
    });
    const matcher = new FingerprintMatcher(templates[i]);
    const node = files.map((_, j) => ({ memberId: 1000 + j, score: matcher.match(templates[j]) }));
    const nodeById = new Map(node.map((h) => [h.memberId, h.score]));
    for (const hit of java.top) {
      const ours = nodeById.get(hit.memberId);
      const diff = Math.abs(ours - hit.score);
      pairs++;
      if (diff === 0) exact++;
      else maxDiff = Math.max(maxDiff, diff);
      if (diff > 1e-9)
        console.log(`  DIFF ${files[i]} vs member ${hit.memberId}: java=${hit.score} node=${ours} (Δ${diff})`);
    }
    const javaTop = java.top[0];
    const nodeTop = [...node].sort((a, b) => b.score - a.score)[0];
    if (javaTop && javaTop.memberId !== nodeTop.memberId && javaTop.score !== nodeTop.score) rankMismatch++;
  }

  console.log(`\nPairs: ${pairs} | bit-exact: ${exact} | maxDiff: ${maxDiff} | rank mismatch: ${rankMismatch}`);
  await req('DELETE', `${args.url}/v1/gallery`, { outlet: args.outlet });
  if (exact !== pairs || rankMismatch > 0) {
    console.error('PARITY FAILED');
    process.exit(1);
  }
  console.log('PARITY OK — skor identik dengan SourceAFIS Java');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
