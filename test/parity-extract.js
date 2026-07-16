#!/usr/bin/env node
/**
 * Paritas extractor nodeafis vs sidecar SourceAFIS Java.
 * Extract dari image yang sama di kedua sisi, bandingkan minutiae template.
 *
 * Usage: node test/parity-extract.js [--url http://127.0.0.1:8089] [--samples /tmp/sourceafis-samples]
 */
const fs = require('node:fs');
const path = require('node:path');
const { FingerprintTemplate, FingerprintImage } = require('../dist/index');
const { cborDecode } = require('../dist/cbor');

const url = process.env.SOURCEAFIS_URL || 'http://127.0.0.1:8089';
const samples = process.argv.includes('--samples') ? process.argv[process.argv.indexOf('--samples') + 1] : '/tmp/sourceafis-samples';

async function javaExtract(pngPath) {
  const image = fs.readFileSync(pngPath).toString('base64');
  const res = await fetch(`${url}/v1/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return Buffer.from(json.template, 'base64');
}

function fields(tplBytes) {
  const map = cborDecode(tplBytes);
  return {
    width: map.width,
    height: map.height,
    positionsX: map.positionsX,
    positionsY: map.positionsY,
    directions: map.directions.map(Math.fround),
    types: map.types,
  };
}

async function main() {
  const pngs = fs.readdirSync(samples).filter((f) => f.endsWith('.png')).sort();
  let allIdentical = true;
  for (const png of pngs) {
    const javaTpl = fields(await javaExtract(path.join(samples, png)));
    const nodeTpl = fields(FingerprintTemplate.fromImage(FingerprintImage.decode(fs.readFileSync(path.join(samples, png)))).toByteArray());

    let verdict;
    if (javaTpl.types.length !== nodeTpl.types.length) {
      verdict = `MISMATCH count java=${javaTpl.types.length} node=${nodeTpl.types.length}`;
      allIdentical = false;
    } else {
      let diffs = 0;
      let firstDiff = -1;
      for (let i = 0; i < javaTpl.types.length; i++) {
        if (
          javaTpl.positionsX[i] !== nodeTpl.positionsX[i] ||
          javaTpl.positionsY[i] !== nodeTpl.positionsY[i] ||
          javaTpl.directions[i] !== nodeTpl.directions[i] ||
          javaTpl.types[i] !== nodeTpl.types[i]
        ) {
          diffs++;
          if (firstDiff < 0) firstDiff = i;
        }
      }
      if (javaTpl.width !== nodeTpl.width || javaTpl.height !== nodeTpl.height) {
        verdict = `MISMATCH size java=${javaTpl.width}x${javaTpl.height} node=${nodeTpl.width}x${nodeTpl.height}`;
        allIdentical = false;
      } else if (diffs === 0) {
        verdict = `IDENTICAL (${javaTpl.types.length} minutiae)`;
      } else {
        verdict = `MISMATCH ${diffs}/${javaTpl.types.length} minutiae (first at ${firstDiff}: java=[${javaTpl.positionsX[firstDiff]},${javaTpl.positionsY[firstDiff]},${javaTpl.directions[firstDiff]},${javaTpl.types[firstDiff]}] node=[${nodeTpl.positionsX[firstDiff]},${nodeTpl.positionsY[firstDiff]},${nodeTpl.directions[firstDiff]},${nodeTpl.types[firstDiff]}])`;
        allIdentical = false;
      }
    }
    console.log(`${png.padEnd(18)} ${verdict}`);
  }
  console.log(allIdentical ? '\nEXTRACT PARITY OK — template identik dengan Java' : '\nEXTRACT PARITY: ada perbedaan');
  process.exit(allIdentical ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
