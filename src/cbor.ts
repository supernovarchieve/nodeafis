/*
 * Minimal CBOR codec — just enough to read/write SourceAFIS 3.18.1 templates
 * (jackson-dataformat-cbor output: maps with text keys, int/float32 arrays, text strings).
 * ponytail: not a general CBOR library; extend only if template format grows.
 */

export type CborValue =
  | number
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | CborValue[]
  | { [key: string]: CborValue };

class Reader {
  private offset = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private u8(): number {
    if (this.offset >= this.bytes.length) throw new Error('CBOR: unexpected end of input');
    return this.bytes[this.offset++];
  }
  private length(info: number): number {
    if (info < 24) return info;
    if (info === 24) return this.u8();
    if (info === 25) {
      const v = this.view.getUint16(this.offset);
      this.offset += 2;
      return v;
    }
    if (info === 26) {
      const v = this.view.getUint32(this.offset);
      this.offset += 4;
      return v;
    }
    if (info === 27) {
      const v = this.view.getBigUint64(this.offset);
      this.offset += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR: 64-bit length too large');
      return Number(v);
    }
    throw new Error(`CBOR: unsupported additional info ${info}`);
  }
  private chunk(major: number): Uint8Array {
    const initial = this.u8();
    if (initial >>> 5 !== major) throw new Error('CBOR: mismatched chunk type in indefinite string');
    const len = this.length(initial & 0x1f);
    const slice = this.bytes.subarray(this.offset, this.offset + len);
    if (slice.length !== len) throw new Error('CBOR: unexpected end of input');
    this.offset += len;
    return slice;
  }
  decode(): CborValue {
    const initial = this.u8();
    const major = initial >>> 5;
    const info = initial & 0x1f;
    switch (major) {
      case 0:
        return this.length(info);
      case 1:
        return -1 - this.length(info);
      case 2:
      case 3: {
        let bytes: Uint8Array;
        if (info === 31) {
          const chunks: Uint8Array[] = [];
          while (this.bytes[this.offset] !== 0xff) chunks.push(this.chunk(major));
          this.offset++;
          const total = chunks.reduce((n, c) => n + c.length, 0);
          bytes = new Uint8Array(total);
          let at = 0;
          for (const c of chunks) {
            bytes.set(c, at);
            at += c.length;
          }
        } else {
          const len = this.length(info);
          bytes = this.bytes.subarray(this.offset, this.offset + len);
          if (bytes.length !== len) throw new Error('CBOR: unexpected end of input');
          this.offset += len;
        }
        return major === 2 ? new Uint8Array(bytes) : new TextDecoder().decode(bytes);
      }
      case 4: {
        const array: CborValue[] = [];
        if (info === 31) {
          while (this.bytes[this.offset] !== 0xff) array.push(this.decode());
          this.offset++;
        } else {
          const len = this.length(info);
          for (let i = 0; i < len; i++) array.push(this.decode());
        }
        return array;
      }
      case 5: {
        const map: { [key: string]: CborValue } = {};
        const entry = (): void => {
          const key = this.decode();
          if (typeof key !== 'string') throw new Error('CBOR: non-text map key unsupported');
          map[key] = this.decode();
        };
        if (info === 31) {
          while (this.bytes[this.offset] !== 0xff) entry();
          this.offset++;
        } else {
          const len = this.length(info);
          for (let i = 0; i < len; i++) entry();
        }
        return map;
      }
      case 6:
        this.length(info); // tag number — ignored
        return this.decode();
      case 7: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 25) {
          // float16
          const half = this.view.getUint16(this.offset);
          this.offset += 2;
          const sign = half & 0x8000 ? -1 : 1;
          const exp = (half >>> 10) & 0x1f;
          const frac = half & 0x3ff;
          if (exp === 0) return sign * frac * 2 ** -24;
          if (exp === 31) return frac ? NaN : sign * Infinity;
          return sign * (1 + frac / 1024) * 2 ** (exp - 15);
        }
        if (info === 26) {
          const v = this.view.getFloat32(this.offset);
          this.offset += 4;
          return v;
        }
        if (info === 27) {
          const v = this.view.getFloat64(this.offset);
          this.offset += 8;
          return v;
        }
        throw new Error(`CBOR: unsupported simple value ${info}`);
      }
      default:
        throw new Error(`CBOR: unsupported major type ${major}`);
    }
  }
}

export function cborDecode(bytes: Uint8Array): CborValue {
  return new Reader(bytes).decode();
}

class Writer {
  private chunks: number[] = [];
  private head(major: number, value: number): void {
    if (value < 24) {
      this.chunks.push((major << 5) | value);
    } else if (value < 0x100) {
      this.chunks.push((major << 5) | 24, value);
    } else if (value < 0x10000) {
      this.chunks.push((major << 5) | 25, value >>> 8, value & 0xff);
    } else {
      this.chunks.push((major << 5) | 26, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
    }
  }
  int(value: number): void {
    if (!Number.isInteger(value)) throw new Error('CBOR: non-integer where integer expected');
    if (value >= 0) this.head(0, value);
    else this.head(1, -1 - value);
  }
  float32(value: number): void {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setFloat32(0, value);
    this.chunks.push(0xfa, ...buf);
  }
  text(value: string): void {
    const bytes = new TextEncoder().encode(value);
    this.head(3, bytes.length);
    this.chunks.push(...bytes);
  }
  arrayHead(length: number): void {
    this.head(4, length);
  }
  mapHead(entries: number): void {
    this.head(5, entries);
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

/** Serialized fields of a SourceAFIS persistent template (CBOR map, jackson field order). */
export interface PersistentTemplateFields {
  version: string;
  width: number;
  height: number;
  positionsX: number[];
  positionsY: number[];
  directions: number[];
  types: string;
}

export function encodePersistentTemplate(t: PersistentTemplateFields): Uint8Array {
  const w = new Writer();
  w.mapHead(7);
  w.text('version');
  w.text(t.version);
  w.text('width');
  w.int(t.width);
  w.text('height');
  w.int(t.height);
  w.text('positionsX');
  w.arrayHead(t.positionsX.length);
  for (const v of t.positionsX) w.int(v);
  w.text('positionsY');
  w.arrayHead(t.positionsY.length);
  for (const v of t.positionsY) w.int(v);
  w.text('directions');
  w.arrayHead(t.directions.length);
  for (const v of t.directions) w.float32(v);
  w.text('types');
  w.text(t.types);
  return w.bytes();
}
