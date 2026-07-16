/*
 * Image input for the extractor — equivalent of Java FingerprintImage:
 * raw 8-bit grayscale, PGM (P5), and PNG (8-bit gray/RGB/RGBA, non-interlaced).
 * ponytail: not a general image library; formats beyond what the kiosk produces are out of scope.
 */

import { inflateSync } from 'node:zlib';

/** Row-major double matrix, mirror of engine.primitives.DoubleMatrix. */
export class DoubleMatrix {
  readonly cells: Float64Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.cells = new Float64Array(width * height);
  }
  get(x: number, y: number): number {
    return this.cells[y * this.width + x];
  }
  set(x: number, y: number, value: number): void {
    this.cells[y * this.width + x] = value;
  }
  add(x: number, y: number, value: number): void {
    this.cells[y * this.width + x] += value;
  }
  multiply(x: number, y: number, value: number): void {
    this.cells[y * this.width + x] *= value;
  }
}

export class FingerprintImage {
  readonly matrix: DoubleMatrix;
  readonly dpi: number;

  private constructor(matrix: DoubleMatrix, dpi: number) {
    this.matrix = matrix;
    this.dpi = dpi;
  }

  /** Raw 8-bit grayscale, 0 = black, 255 = white, row-major from top-left (Java raw constructor). */
  static fromRaw(width: number, height: number, pixels: Uint8Array, options?: { dpi?: number }): FingerprintImage {
    const dpi = options?.dpi ?? 500;
    if (dpi < 20 || dpi > 20_000) throw new RangeError('dpi out of range');
    if (width <= 0 || height <= 0 || pixels.length !== width * height) throw new RangeError('pixels length must be width*height');
    const matrix = new DoubleMatrix(width, height);
    for (let y = 0; y < height; ++y)
      for (let x = 0; x < width; ++x) matrix.set(x, y, 1 - pixels[y * width + x] / 255.0);
    return new FingerprintImage(matrix, dpi);
  }

  /** Decodes PNG or PGM by sniffing the header. */
  static decode(bytes: Uint8Array, options?: { dpi?: number }): FingerprintImage {
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return FingerprintImage.fromPng(bytes, options);
    if (bytes.length > 2 && bytes[0] === 0x50 && bytes[1] === 0x35) return FingerprintImage.fromPgm(bytes, options);
    throw new Error('Unsupported image format (expected PNG or PGM P5).');
  }

  static fromPgm(bytes: Uint8Array, options?: { dpi?: number }): FingerprintImage {
    // P5 <width> <height> <maxval>\n<binary>
    let offset = 0;
    const token = (): string => {
      while (offset < bytes.length && (isSpace(bytes[offset]) || bytes[offset] === 0x23)) {
        if (bytes[offset] === 0x23) while (offset < bytes.length && bytes[offset] !== 0x0a) offset++;
        else offset++;
      }
      const start = offset;
      while (offset < bytes.length && !isSpace(bytes[offset])) offset++;
      return new TextDecoder().decode(bytes.subarray(start, offset));
    };
    if (token() !== 'P5') throw new Error('Not a P5 PGM.');
    const width = parseInt(token(), 10);
    const height = parseInt(token(), 10);
    const maxval = parseInt(token(), 10);
    offset++; // single whitespace after maxval
    if (!(width > 0) || !(height > 0) || maxval !== 255) throw new Error('Unsupported PGM (need 8-bit, maxval 255).');
    return FingerprintImage.fromRaw(width, height, bytes.subarray(offset, offset + width * height), options);
  }

  static fromPng(bytes: Uint8Array, options?: { dpi?: number }): FingerprintImage {
    const dpi = options?.dpi ?? 500;
    if (dpi < 20 || dpi > 20_000) throw new RangeError('dpi out of range');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idat: Uint8Array[] = [];
    while (offset < bytes.length) {
      const length = view.getUint32(offset);
      const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === 'IHDR') {
        width = view.getUint32(offset + 8);
        height = view.getUint32(offset + 12);
        bitDepth = data[8];
        colorType = data[9];
        if (bitDepth !== 8) throw new Error('Only 8-bit PNG supported.');
        if (colorType !== 0 && colorType !== 2 && colorType !== 6) throw new Error(`Unsupported PNG color type ${colorType}.`);
        if (data[12] !== 0) throw new Error('Interlaced PNG not supported.');
      } else if (type === 'IDAT') {
        idat.push(data);
      } else if (type === 'IEND') {
        break;
      }
      offset += 12 + length;
    }
    const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : 4;
    const stride = width * channels;
    const raw = inflateSync(Buffer.concat(idat));
    const pixels = new Uint8Array(width * height * channels);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < height; ++y) {
      const filter = raw[y * (stride + 1)];
      const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      const out = pixels.subarray(y * stride, (y + 1) * stride);
      for (let i = 0; i < stride; ++i) {
        const left = i >= channels ? out[i - channels] : 0;
        const up = prev[i];
        const upLeft = i >= channels ? prev[i - channels] : 0;
        let value = line[i];
        switch (filter) {
          case 0:
            break;
          case 1:
            value += left;
            break;
          case 2:
            value += up;
            break;
          case 3:
            value += (left + up) >> 1;
            break;
          case 4: {
            const p = left + up - upLeft;
            const pa = Math.abs(p - left);
            const pb = Math.abs(p - up);
            const pc = Math.abs(p - upLeft);
            value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
            break;
          }
          default:
            throw new Error(`Unsupported PNG filter ${filter}.`);
        }
        out[i] = value & 0xff;
      }
      prev = out;
    }
    // Java path: BufferedImage.getRGB() then color = r+g+b, matrix = 1 - color/(3*255).
    // For grayscale PNG, ImageIO yields TYPE_BYTE_GRAY (linear gray) and getRGB() converts
    // through ICC to sRGB — NOT identity. GRAY_TO_SRGB replicates that exact 8-bit LUT
    // (dumped from eclipse-temurin 17, the sidecar's JRE).
    const matrix = new DoubleMatrix(width, height);
    for (let y = 0; y < height; ++y)
      for (let x = 0; x < width; ++x) {
        let color: number;
        if (channels === 1) color = 3 * GRAY_TO_SRGB[pixels[y * stride + x]];
        else color = pixels[y * stride + x * channels] + pixels[y * stride + x * channels + 1] + pixels[y * stride + x * channels + 2];
        matrix.set(x, y, 1 - color * (1.0 / (3.0 * 255.0)));
      }
    return new FingerprintImage(matrix, dpi);
  }
}

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

// prettier-ignore
const GRAY_TO_SRGB = Uint8Array.from([
  0,13,22,28,34,38,42,46,50,53,56,59,61,64,66,69,71,73,75,77,79,81,83,85,86,88,90,92,93,95,96,98,
  99,101,102,104,105,106,108,109,110,112,113,114,115,117,118,119,120,121,122,124,125,126,127,128,129,130,131,132,133,134,135,136,
  137,138,139,140,141,142,143,144,145,146,147,148,148,149,150,151,152,153,154,155,155,156,157,158,159,159,160,161,162,163,163,164,
  165,166,167,167,168,169,170,170,171,172,173,173,174,175,175,176,177,178,178,179,180,180,181,182,182,183,184,185,185,186,187,187,
  188,189,189,190,190,191,192,192,193,194,194,195,196,196,197,197,198,199,199,200,200,201,202,202,203,203,204,205,205,206,206,207,
  208,208,209,209,210,210,211,212,212,213,213,214,214,215,215,216,216,217,218,218,219,219,220,220,221,221,222,222,223,223,224,224,
  225,226,226,227,227,228,228,229,229,230,230,231,231,232,232,233,233,234,234,235,235,236,236,237,237,238,238,238,239,239,240,240,
  241,241,242,242,243,243,244,244,245,245,246,246,246,247,247,248,248,249,249,250,250,251,251,251,252,252,253,253,254,254,255,255,
]);
