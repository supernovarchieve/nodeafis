/*
 * Port of SourceAFIS engine.primitives (Java 3.18.1), matcher subset.
 * Java `float` arithmetic is emulated with Math.fround after every operation —
 * fround(double op) is exactly the correctly-rounded binary32 result for +,-,*,/
 * on binary32 operands, so scores stay bit-identical to the Java implementation.
 */

const fround = Math.fround;

export const FloatAngle = {
  PI2: fround(2 * Math.PI),
  PI: fround(Math.PI),
  HALF_PI: fround(0.5 * Math.PI),

  add(start: number, delta: number): number {
    const angle = fround(start + delta);
    return angle < FloatAngle.PI2 ? angle : fround(angle - FloatAngle.PI2);
  },
  difference(first: number, second: number): number {
    const angle = fround(first - second);
    return angle >= 0 ? angle : fround(angle + FloatAngle.PI2);
  },
  distance(first: number, second: number): number {
    const delta = Math.abs(fround(first - second));
    return delta <= FloatAngle.PI ? delta : fround(FloatAngle.PI2 - delta);
  },
  opposite(angle: number): number {
    return angle < FloatAngle.PI ? fround(angle + FloatAngle.PI) : fround(angle - FloatAngle.PI);
  },
  complementary(angle: number): number {
    const complement = fround(FloatAngle.PI2 - angle);
    return complement < FloatAngle.PI2 ? complement : fround(complement - FloatAngle.PI2);
  },
  normalized(angle: number): boolean {
    return angle >= 0 && angle < FloatAngle.PI2;
  },
};

/** DoubleAngle.atan(DoublePoint) — double precision, no rounding games. */
export function atanVector(x: number, y: number): number {
  const angle = Math.atan2(y, x);
  return angle >= 0 ? angle : angle + 2 * Math.PI;
}

/** Port of engine.primitives.DoubleAngle (double-precision subset used by the extractor). */
export const DoubleAngle = {
  PI2: 2 * Math.PI,
  atan: atanVector,
  toOrientation(angle: number): number {
    return angle < Math.PI ? 2 * angle : 2 * (angle - Math.PI);
  },
  fromOrientation(angle: number): number {
    return 0.5 * angle;
  },
  add(start: number, delta: number): number {
    const angle = start + delta;
    return angle < DoubleAngle.PI2 ? angle : angle - DoubleAngle.PI2;
  },
  bucketCenter(bucket: number, resolution: number): number {
    return (DoubleAngle.PI2 * (2 * bucket + 1)) / (2 * resolution);
  },
  quantize(angle: number, resolution: number): number {
    const result = Math.trunc(angle * (1 / DoubleAngle.PI2) * resolution);
    if (result < 0) return 0;
    if (result >= resolution) return resolution - 1;
    return result;
  },
  opposite(angle: number): number {
    return angle < Math.PI ? angle + Math.PI : angle - Math.PI;
  },
  distance(first: number, second: number): number {
    const delta = Math.abs(first - second);
    return delta <= Math.PI ? delta : DoubleAngle.PI2 - delta;
  },
};

export function interpolate(start: number, end: number, position: number): number {
  return start + position * (end - start);
}

export function interpolate2d(
  bottomleft: number,
  bottomright: number,
  topleft: number,
  topright: number,
  x: number,
  y: number,
): number {
  const left = interpolate(topleft, bottomleft, y);
  const right = interpolate(topright, bottomright, y);
  return interpolate(left, right, x);
}

export function interpolateExponential(start: number, end: number, position: number): number {
  return Math.pow(end / start, position) * start;
}

/**
 * Replica of java.util.PriorityQueue (binary heap, identical siftUp/siftDown),
 * so that ties in the comparator pop in exactly the same order as in Java.
 */
export class JavaPriorityQueue<T> {
  private heap: T[] = [];
  private count = 0;
  constructor(private readonly compare: (a: T, b: T) => number) {}

  get size(): number {
    return this.count;
  }
  isEmpty(): boolean {
    return this.count === 0;
  }
  peek(): T {
    return this.heap[0];
  }
  add(item: T): void {
    if (this.count === 0) this.heap[0] = item;
    else this.siftUp(this.count, item);
    this.count++;
  }
  remove(): T {
    const result = this.heap[0];
    const last = this.heap[--this.count];
    this.heap.length = this.count;
    if (this.count !== 0) this.siftDown(0, last);
    return result;
  }
  private siftUp(index: number, item: T): void {
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this.compare(item, this.heap[parent]) >= 0) break;
      this.heap[index] = this.heap[parent];
      index = parent;
    }
    this.heap[index] = item;
  }
  private siftDown(index: number, item: T): void {
    const half = this.count >>> 1;
    while (index < half) {
      let child = 2 * index + 1;
      const right = child + 1;
      if (right < this.count && this.compare(this.heap[child], this.heap[right]) > 0) child = right;
      if (this.compare(item, this.heap[child]) <= 0) break;
      this.heap[index] = this.heap[child];
      index = child;
    }
    this.heap[index] = item;
  }
}
