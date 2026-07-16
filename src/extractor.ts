/*
 * Port of SourceAFIS engine.extractor (Java 3.18.1): the full image → minutiae pipeline.
 * Stage order and arithmetic mirror the Java sources exactly; iteration over blocks is
 * row-major (y outer, x inner) matching Java's IntPoint/IntRect iterators.
 */

import { DoubleMatrix } from './image';
import { atanVector, DoubleAngle, interpolate2d, interpolateExponential } from './primitives';
import { MinutiaType, MinutiaTypeValue, Parameters } from './templates';
import { createSkeleton, Skeleton, SkeletonType } from './skeletons';

const fround = Math.fround;

export interface FeatureMinutia {
  x: number;
  y: number;
  direction: number; // binary32
  type: MinutiaTypeValue;
}

export interface FeatureTemplateData {
  width: number;
  height: number;
  minutiae: FeatureMinutia[];
}

export class BooleanMatrix {
  readonly cells: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.cells = new Uint8Array(width * height);
  }
  static copyOf(other: BooleanMatrix): BooleanMatrix {
    const copy = new BooleanMatrix(other.width, other.height);
    copy.cells.set(other.cells);
    return copy;
  }
  get(x: number, y: number): boolean {
    return this.cells[y * this.width + x] !== 0;
  }
  getF(x: number, y: number, fallback: boolean): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return fallback;
    return this.cells[y * this.width + x] !== 0;
  }
  set(x: number, y: number, value: boolean): void {
    this.cells[y * this.width + x] = value ? 1 : 0;
  }
  invert(): void {
    for (let i = 0; i < this.cells.length; ++i) this.cells[i] = this.cells[i] ^ 1;
  }
  merge(other: BooleanMatrix): void {
    for (let i = 0; i < this.cells.length; ++i) this.cells[i] |= other.cells[i];
  }
}

class IntMatrix {
  readonly cells: Int32Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.cells = new Int32Array(width * height);
  }
  get(x: number, y: number): number {
    return this.cells[y * this.width + x];
  }
  set(x: number, y: number, value: number): void {
    this.cells[y * this.width + x] = value;
  }
}

class DoublePointMatrix {
  readonly vectors: Float64Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.vectors = new Float64Array(2 * width * height);
  }
  getX(x: number, y: number): number {
    return this.vectors[2 * (y * this.width + x)];
  }
  getY(x: number, y: number): number {
    return this.vectors[2 * (y * this.width + x) + 1];
  }
  add(x: number, y: number, px: number, py: number): void {
    const i = 2 * (y * this.width + x);
    this.vectors[i] += px;
    this.vectors[i + 1] += py;
  }
}

class HistogramCube {
  readonly counts: Int32Array;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly bins: number,
  ) {
    this.counts = new Int32Array(width * height * bins);
  }
  constrain(z: number): number {
    return Math.max(0, Math.min(this.bins - 1, z));
  }
  get(x: number, y: number, z: number): number {
    return this.counts[(y * this.width + x) * this.bins + z];
  }
  sum(x: number, y: number): number {
    let sum = 0;
    for (let i = 0; i < this.bins; ++i) sum += this.get(x, y, i);
    return sum;
  }
  add(x: number, y: number, z: number, value: number): void {
    this.counts[(y * this.width + x) * this.bins + z] += value;
  }
  increment(x: number, y: number, z: number): void {
    this.add(x, y, z, 1);
  }
}

interface IntRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
const rectBetween = (sx: number, sy: number, ex: number, ey: number): IntRect => ({
  x: sx,
  y: sy,
  width: ex - sx,
  height: ey - sy,
});
const rectRight = (r: IntRect): number => r.x + r.width;
const rectBottom = (r: IntRect): number => r.y + r.height;
const rectIntersect = (a: IntRect, b: IntRect): IntRect =>
  rectBetween(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.min(rectRight(a), rectRight(b)), Math.min(rectBottom(a), rectBottom(b)));

class BlockGrid {
  readonly blocksX: number;
  readonly blocksY: number;
  readonly x: Int32Array;
  readonly y: Int32Array;
  constructor(width: number, height: number) {
    this.blocksX = width;
    this.blocksY = height;
    this.x = new Int32Array(width + 1);
    this.y = new Int32Array(height + 1);
  }
  block(atX: number, atY: number): IntRect {
    return rectBetween(this.x[atX], this.y[atY], this.x[atX + 1], this.y[atY + 1]);
  }
}

export class BlockMap {
  readonly pixelsX: number;
  readonly pixelsY: number;
  readonly primary: BlockGrid;
  readonly secondary: BlockGrid;
  constructor(width: number, height: number, maxBlockSize: number) {
    this.pixelsX = width;
    this.pixelsY = height;
    const roundUpDiv = (a: number, b: number): number => Math.trunc((a + b - 1) / b);
    this.primary = new BlockGrid(roundUpDiv(width, maxBlockSize), roundUpDiv(height, maxBlockSize));
    for (let y = 0; y <= this.primary.blocksY; ++y) this.primary.y[y] = Math.trunc((y * height) / this.primary.blocksY);
    for (let x = 0; x <= this.primary.blocksX; ++x) this.primary.x[x] = Math.trunc((x * width) / this.primary.blocksX);
    this.secondary = new BlockGrid(this.primary.blocksX + 1, this.primary.blocksY + 1);
    this.secondary.y[0] = 0;
    for (let y = 0; y < this.primary.blocksY; ++y) {
      const b = this.primary.block(0, y);
      this.secondary.y[y + 1] = Math.trunc((b.y + rectBottom(b)) / 2); // IntRect.center().y
    }
    this.secondary.y[this.secondary.blocksY] = height;
    this.secondary.x[0] = 0;
    for (let x = 0; x < this.primary.blocksX; ++x) {
      const b = this.primary.block(x, 0);
      this.secondary.x[x + 1] = Math.trunc((rectRight(b) + b.x) / 2); // IntRect.center().x
    }
    this.secondary.x[this.secondary.blocksX] = width;
  }
}

// ---- ImageResizer ----

function resizeTo(input: DoubleMatrix, newWidth: number, newHeight: number): DoubleMatrix {
  if (newWidth === input.width && newHeight === input.height) return input;
  const output = new DoubleMatrix(newWidth, newHeight);
  const scaleX = newWidth / input.width;
  const scaleY = newHeight / input.height;
  const descaleX = 1 / scaleX;
  const descaleY = 1 / scaleY;
  for (let y = 0; y < newHeight; ++y) {
    const y1 = y * descaleY;
    const y2 = y1 + descaleY;
    const y1i = Math.trunc(y1);
    const y2i = Math.min(Math.ceil(y2), input.height);
    for (let x = 0; x < newWidth; ++x) {
      const x1 = x * descaleX;
      const x2 = x1 + descaleX;
      const x1i = Math.trunc(x1);
      const x2i = Math.min(Math.ceil(x2), input.width);
      let sum = 0;
      for (let oy = y1i; oy < y2i; ++oy) {
        const ry = Math.min(oy + 1, y2) - Math.max(oy, y1);
        for (let ox = x1i; ox < x2i; ++ox) {
          const rx = Math.min(ox + 1, x2) - Math.max(ox, x1);
          sum += rx * ry * input.get(ox, oy);
        }
      }
      output.set(x, y, sum * (scaleX * scaleY));
    }
  }
  return output;
}

function resize(input: DoubleMatrix, dpi: number): DoubleMatrix {
  return resizeTo(input, Math.round((500.0 / dpi) * input.width), Math.round((500.0 / dpi) * input.height));
}

// ---- LocalHistograms ----

function histogramCreate(blocks: BlockMap, image: DoubleMatrix): HistogramCube {
  const histogram = new HistogramCube(blocks.primary.blocksX, blocks.primary.blocksY, Parameters.HISTOGRAM_DEPTH);
  for (let by = 0; by < blocks.primary.blocksY; ++by)
    for (let bx = 0; bx < blocks.primary.blocksX; ++bx) {
      const area = blocks.primary.block(bx, by);
      for (let y = area.y; y < rectBottom(area); ++y)
        for (let x = area.x; x < rectRight(area); ++x) {
          const depth = Math.trunc(image.get(x, y) * histogram.bins);
          histogram.increment(bx, by, histogram.constrain(depth));
        }
    }
  return histogram;
}

function histogramSmooth(blocks: BlockMap, input: HistogramCube): HistogramCube {
  const around = [
    [0, 0],
    [-1, 0],
    [0, -1],
    [-1, -1],
  ];
  const output = new HistogramCube(blocks.secondary.blocksX, blocks.secondary.blocksY, input.bins);
  for (let cy = 0; cy < blocks.secondary.blocksY; ++cy)
    for (let cx = 0; cx < blocks.secondary.blocksX; ++cx)
      for (const [rx, ry] of around) {
        const bx = cx + rx;
        const by = cy + ry;
        if (bx >= 0 && by >= 0 && bx < blocks.primary.blocksX && by < blocks.primary.blocksY)
          for (let i = 0; i < input.bins; ++i) output.add(cx, cy, i, input.get(bx, by, i));
      }
  return output;
}

// ---- SegmentationMask + contrast ----

function clippedContrast(blocks: BlockMap, histogram: HistogramCube): DoubleMatrix {
  const result = new DoubleMatrix(blocks.primary.blocksX, blocks.primary.blocksY);
  for (let by = 0; by < blocks.primary.blocksY; ++by)
    for (let bx = 0; bx < blocks.primary.blocksX; ++bx) {
      const volume = histogram.sum(bx, by);
      const clipLimit = Math.round(volume * Parameters.CLIPPED_CONTRAST);
      let accumulator = 0;
      let lowerBound = histogram.bins - 1;
      for (let i = 0; i < histogram.bins; ++i) {
        accumulator += histogram.get(bx, by, i);
        if (accumulator > clipLimit) {
          lowerBound = i;
          break;
        }
      }
      accumulator = 0;
      let upperBound = 0;
      for (let i = histogram.bins - 1; i >= 0; --i) {
        accumulator += histogram.get(bx, by, i);
        if (accumulator > clipLimit) {
          upperBound = i;
          break;
        }
      }
      result.set(bx, by, (upperBound - lowerBound) * (1.0 / (histogram.bins - 1)));
    }
  return result;
}

function absoluteContrastMask(contrast: DoubleMatrix): BooleanMatrix {
  const result = new BooleanMatrix(contrast.width, contrast.height);
  for (let y = 0; y < contrast.height; ++y)
    for (let x = 0; x < contrast.width; ++x) if (contrast.get(x, y) < Parameters.MIN_ABSOLUTE_CONTRAST) result.set(x, y, true);
  return result;
}

function relativeContrastMask(contrast: DoubleMatrix, blocks: BlockMap): BooleanMatrix {
  const sortedContrast: number[] = [];
  for (let y = 0; y < contrast.height; ++y) for (let x = 0; x < contrast.width; ++x) sortedContrast.push(contrast.get(x, y));
  sortedContrast.sort((a, b) => b - a);
  const pixelsPerBlock = Math.trunc((blocks.pixelsX * blocks.pixelsY) / (blocks.primary.blocksX * blocks.primary.blocksY));
  const sampleCount = Math.min(sortedContrast.length, Math.trunc(Parameters.RELATIVE_CONTRAST_SAMPLE / pixelsPerBlock));
  const consideredBlocks = Math.max(Math.round(sampleCount * Parameters.RELATIVE_CONTRAST_PERCENTILE), 1);
  let sum = 0;
  for (let i = 0; i < consideredBlocks; ++i) sum += sortedContrast[i];
  const averageContrast = sum / consideredBlocks;
  const limit = averageContrast * Parameters.MIN_RELATIVE_CONTRAST;
  const result = new BooleanMatrix(blocks.primary.blocksX, blocks.primary.blocksY);
  for (let y = 0; y < result.height; ++y)
    for (let x = 0; x < result.width; ++x) if (contrast.get(x, y) < limit) result.set(x, y, true);
  return result;
}

export function voteFilter(
  input: BooleanMatrix,
  mask: BooleanMatrix | null,
  radius: number,
  majority: number,
  borderDistance: number,
): BooleanMatrix {
  const sizeX = input.width;
  const sizeY = input.height;
  const rect: IntRect = { x: borderDistance, y: borderDistance, width: sizeX - 2 * borderDistance, height: sizeY - 2 * borderDistance };
  const thresholds = new Int32Array((2 * radius + 1) * (2 * radius + 1) + 1);
  for (let i = 0; i < thresholds.length; ++i) thresholds[i] = Math.ceil(majority * i);
  const counts = new IntMatrix(sizeX, sizeY);
  const output = new BooleanMatrix(sizeX, sizeY);
  for (let y = rect.y; y < rectBottom(rect); ++y) {
    const superTop = y - radius - 1;
    const superBottom = y + radius;
    const yMin = Math.max(0, y - radius);
    const yMax = Math.min(sizeY - 1, y + radius);
    const yRange = yMax - yMin + 1;
    for (let x = rect.x; x < rectRight(rect); ++x)
      if (mask === null || mask.get(x, y)) {
        const left = x > 0 ? counts.get(x - 1, y) : 0;
        const top = y > 0 ? counts.get(x, y - 1) : 0;
        const diagonal = x > 0 && y > 0 ? counts.get(x - 1, y - 1) : 0;
        const xMin = Math.max(0, x - radius);
        const xMax = Math.min(sizeX - 1, x + radius);
        let ones: number;
        if (left > 0 && top > 0 && diagonal > 0) {
          ones = top + left - diagonal - 1;
          const superLeft = x - radius - 1;
          const superRight = x + radius;
          if (superLeft >= 0 && superTop >= 0 && input.get(superLeft, superTop)) ++ones;
          if (superLeft >= 0 && superBottom < sizeY && input.get(superLeft, superBottom)) --ones;
          if (superRight < sizeX && superTop >= 0 && input.get(superRight, superTop)) --ones;
          if (superRight < sizeX && superBottom < sizeY && input.get(superRight, superBottom)) ++ones;
        } else {
          ones = 0;
          for (let ny = yMin; ny <= yMax; ++ny) for (let nx = xMin; nx <= xMax; ++nx) if (input.get(nx, ny)) ++ones;
        }
        counts.set(x, y, ones + 1);
        if (ones >= thresholds[yRange * (xMax - xMin + 1)]) output.set(x, y, true);
      }
  }
  return output;
}

function segmentationFilter(input: BooleanMatrix): BooleanMatrix {
  return voteFilter(
    input,
    null,
    Parameters.BLOCK_ERRORS_VOTE_RADIUS,
    Parameters.BLOCK_ERRORS_VOTE_MAJORITY,
    Parameters.BLOCK_ERRORS_VOTE_BORDER_DISTANCE,
  );
}

function segmentationMask(blocks: BlockMap, histogram: HistogramCube): BooleanMatrix {
  const contrast = clippedContrast(blocks, histogram);
  const mask = absoluteContrastMask(contrast);
  mask.merge(relativeContrastMask(contrast, blocks));
  mask.merge(segmentationFilter(mask));
  mask.invert();
  mask.merge(segmentationFilter(mask));
  mask.merge(segmentationFilter(mask));
  mask.merge(voteFilter(mask, null, Parameters.MASK_VOTE_RADIUS, Parameters.MASK_VOTE_MAJORITY, Parameters.MASK_VOTE_BORDER_DISTANCE));
  return mask;
}

function pixelwiseMask(mask: BooleanMatrix, blocks: BlockMap): BooleanMatrix {
  const pixelized = new BooleanMatrix(blocks.pixelsX, blocks.pixelsY);
  for (let by = 0; by < blocks.primary.blocksY; ++by)
    for (let bx = 0; bx < blocks.primary.blocksX; ++bx)
      if (mask.get(bx, by)) {
        const area = blocks.primary.block(bx, by);
        for (let y = area.y; y < rectBottom(area); ++y) for (let x = area.x; x < rectRight(area); ++x) pixelized.set(x, y, true);
      }
  return pixelized;
}

function shrinkMask(mask: BooleanMatrix, amount: number): BooleanMatrix {
  const shrunk = new BooleanMatrix(mask.width, mask.height);
  for (let y = amount; y < mask.height - amount; ++y)
    for (let x = amount; x < mask.width - amount; ++x)
      shrunk.set(x, y, mask.get(x, y - amount) && mask.get(x, y + amount) && mask.get(x - amount, y) && mask.get(x + amount, y));
  return shrunk;
}

function innerMask(outer: BooleanMatrix): BooleanMatrix {
  let inner = new BooleanMatrix(outer.width, outer.height);
  for (let y = 1; y < outer.height - 1; ++y) for (let x = 1; x < outer.width - 1; ++x) inner.set(x, y, outer.get(x, y));
  if (Parameters.INNER_MASK_BORDER_DISTANCE >= 1) inner = shrinkMask(inner, 1);
  let total = 1;
  for (let step = 1; total + step <= Parameters.INNER_MASK_BORDER_DISTANCE; step *= 2) {
    inner = shrinkMask(inner, step);
    total += step;
  }
  if (total < Parameters.INNER_MASK_BORDER_DISTANCE) inner = shrinkMask(inner, Parameters.INNER_MASK_BORDER_DISTANCE - total);
  return inner;
}

// ---- ImageEqualization ----

function equalize(blocks: BlockMap, image: DoubleMatrix, histogram: HistogramCube, blockMask: BooleanMatrix): DoubleMatrix {
  const rangeMin = -1;
  const rangeMax = 1;
  const rangeSize = rangeMax - rangeMin;
  const widthMax = (rangeSize / 256) * Parameters.MAX_EQUALIZATION_SCALING;
  const widthMin = (rangeSize / 256) * Parameters.MIN_EQUALIZATION_SCALING;
  const bins = histogram.bins;
  const limitedMin = new Float64Array(bins);
  const limitedMax = new Float64Array(bins);
  const dequantized = new Float64Array(bins);
  for (let i = 0; i < bins; ++i) {
    limitedMin[i] = Math.max(i * widthMin + rangeMin, rangeMax - (bins - 1 - i) * widthMax);
    limitedMax[i] = Math.min(i * widthMax + rangeMin, rangeMax - (bins - 1 - i) * widthMin);
    dequantized[i] = i / (bins - 1);
  }
  const cornersX = blocks.secondary.blocksX;
  const mappings: (Float64Array | null)[] = new Array(cornersX * blocks.secondary.blocksY).fill(null);
  for (let cy = 0; cy < blocks.secondary.blocksY; ++cy)
    for (let cx = 0; cx < cornersX; ++cx) {
      const mapping = new Float64Array(bins);
      mappings[cy * cornersX + cx] = mapping;
      if (
        blockMask.getF(cx, cy, false) ||
        blockMask.getF(cx - 1, cy, false) ||
        blockMask.getF(cx, cy - 1, false) ||
        blockMask.getF(cx - 1, cy - 1, false)
      ) {
        const step = rangeSize / histogram.sum(cx, cy);
        let top = rangeMin;
        for (let i = 0; i < bins; ++i) {
          const band = histogram.get(cx, cy, i) * step;
          let equalized = top + dequantized[i] * band;
          top += band;
          if (equalized < limitedMin[i]) equalized = limitedMin[i];
          if (equalized > limitedMax[i]) equalized = limitedMax[i];
          mapping[i] = equalized;
        }
      }
    }
  const result = new DoubleMatrix(blocks.pixelsX, blocks.pixelsY);
  for (let by = 0; by < blocks.primary.blocksY; ++by)
    for (let bx = 0; bx < blocks.primary.blocksX; ++bx) {
      const area = blocks.primary.block(bx, by);
      if (blockMask.get(bx, by)) {
        const topleft = mappings[by * cornersX + bx] as Float64Array;
        const topright = mappings[by * cornersX + bx + 1] as Float64Array;
        const bottomleft = mappings[(by + 1) * cornersX + bx] as Float64Array;
        const bottomright = mappings[(by + 1) * cornersX + bx + 1] as Float64Array;
        for (let y = area.y; y < rectBottom(area); ++y)
          for (let x = area.x; x < rectRight(area); ++x) {
            const depth = histogram.constrain(Math.trunc(image.get(x, y) * bins));
            const rx = (x - area.x + 0.5) / area.width;
            const ry = (y - area.y + 0.5) / area.height;
            result.set(x, y, interpolate2d(bottomleft[depth], bottomright[depth], topleft[depth], topright[depth], rx, ry));
          }
      } else {
        for (let y = area.y; y < rectBottom(area); ++y) for (let x = area.x; x < rectRight(area); ++x) result.set(x, y, -1);
      }
    }
  return result;
}

// ---- Orientations ----

/** Java OrientationRandom — int overflow in seed, 64-bit long wraparound per step. */
class OrientationRandom {
  private static readonly PRIME = 1610612741n;
  private state = BigInt.asIntN(
    64,
    BigInt.asIntN(32, BigInt.asIntN(32, OrientationRandom.PRIME * OrientationRandom.PRIME) * OrientationRandom.PRIME),
  );
  next(): number {
    this.state = BigInt.asIntN(64, this.state * OrientationRandom.PRIME);
    return (Number(this.state & 0x3fffffffn) + 0.5) * (1 / (1 << 30));
  }
}

interface ConsideredOrientation {
  offsetX: number;
  offsetY: number;
  orientationX: number;
  orientationY: number;
}

let cachedPlan: ConsideredOrientation[][] | null = null;

function orientationPlan(): ConsideredOrientation[][] {
  // Java rebuilds this per call from a fixed-seed PRNG — output is always identical, so cache it.
  if (cachedPlan) return cachedPlan;
  const random = new OrientationRandom();
  const splits: ConsideredOrientation[][] = [];
  for (let i = 0; i < Parameters.ORIENTATION_SPLIT; ++i) {
    const orientations: ConsideredOrientation[] = [];
    for (let j = 0; j < Parameters.ORIENTATIONS_CHECKED; ++j) {
      let offsetX = 0;
      let offsetY = 0;
      do {
        const angle = random.next() * Math.PI;
        const distance = interpolateExponential(Parameters.MIN_ORIENTATION_RADIUS, Parameters.MAX_ORIENTATION_RADIUS, random.next());
        offsetX = Math.round(Math.cos(angle) * distance);
        offsetY = Math.round(Math.sin(angle) * distance);
      } while ((offsetX === 0 && offsetY === 0) || offsetY < 0 || orientations.some((o) => o.offsetX === offsetX && o.offsetY === offsetY));
      const direction = DoubleAngle.add(DoubleAngle.toOrientation(atanVector(offsetX, offsetY)), Math.PI);
      orientations.push({ offsetX, offsetY, orientationX: Math.cos(direction), orientationY: Math.sin(direction) });
    }
    splits.push(orientations);
  }
  cachedPlan = splits;
  return splits;
}

function maskRange(mask: BooleanMatrix, y: number): { start: number; end: number } {
  let first = -1;
  let last = -1;
  for (let x = 0; x < mask.width; ++x)
    if (mask.get(x, y)) {
      last = x;
      if (first < 0) first = x;
    }
  return first >= 0 ? { start: first, end: last + 1 } : { start: 0, end: 0 };
}

function pixelwiseOrientations(input: DoubleMatrix, mask: BooleanMatrix, blocks: BlockMap): DoublePointMatrix {
  const neighbors = orientationPlan();
  const orientation = new DoublePointMatrix(input.width, input.height);
  for (let blockY = 0; blockY < blocks.primary.blocksY; ++blockY) {
    const range = maskRange(mask, blockY);
    if (range.end - range.start > 0) {
      const validXRange = {
        start: blocks.primary.block(range.start, blockY).x,
        end: rectRight(blocks.primary.block(range.end - 1, blockY)),
      };
      const blockRect = blocks.primary.block(0, blockY);
      for (let y = blockRect.y; y < rectBottom(blockRect); ++y) {
        for (const neighbor of neighbors[y % neighbors.length]) {
          const radius = Math.max(Math.abs(neighbor.offsetX), Math.abs(neighbor.offsetY));
          if (y - radius >= 0 && y + radius < input.height) {
            const startX = Math.max(radius, validXRange.start);
            const endX = Math.min(input.width - radius, validXRange.end);
            for (let x = startX; x < endX; ++x) {
              const before = input.get(x - neighbor.offsetX, y - neighbor.offsetY);
              const at = input.get(x, y);
              const after = input.get(x + neighbor.offsetX, y + neighbor.offsetY);
              const strength = at - Math.max(before, after);
              if (strength > 0) orientation.add(x, y, neighbor.orientationX * strength, neighbor.orientationY * strength);
            }
          }
        }
      }
    }
  }
  return orientation;
}

function blockOrientations(image: DoubleMatrix, mask: BooleanMatrix, blocks: BlockMap): DoubleMatrix {
  const accumulated = pixelwiseOrientations(image, mask, blocks);
  // aggregate
  const sums = new DoublePointMatrix(blocks.primary.blocksX, blocks.primary.blocksY);
  for (let by = 0; by < blocks.primary.blocksY; ++by)
    for (let bx = 0; bx < blocks.primary.blocksX; ++bx)
      if (mask.get(bx, by)) {
        const area = blocks.primary.block(bx, by);
        for (let y = area.y; y < rectBottom(area); ++y)
          for (let x = area.x; x < rectRight(area); ++x) sums.add(bx, by, accumulated.getX(x, y), accumulated.getY(x, y));
      }
  // smooth
  const width = mask.width;
  const height = mask.height;
  const smoothed = new DoublePointMatrix(width, height);
  for (let by = 0; by < height; ++by)
    for (let bx = 0; bx < width; ++bx)
      if (mask.get(bx, by)) {
        const neighborsRect = rectIntersect(
          rectBetween(
            bx - Parameters.ORIENTATION_SMOOTHING_RADIUS,
            by - Parameters.ORIENTATION_SMOOTHING_RADIUS,
            bx + Parameters.ORIENTATION_SMOOTHING_RADIUS + 1,
            by + Parameters.ORIENTATION_SMOOTHING_RADIUS + 1,
          ),
          { x: 0, y: 0, width, height },
        );
        for (let ny = neighborsRect.y; ny < rectBottom(neighborsRect); ++ny)
          for (let nx = neighborsRect.x; nx < rectRight(neighborsRect); ++nx)
            if (mask.get(nx, ny)) smoothed.add(bx, by, sums.getX(nx, ny), sums.getY(nx, ny));
      }
  // angles
  const angles = new DoubleMatrix(width, height);
  for (let by = 0; by < height; ++by)
    for (let bx = 0; bx < width; ++bx) if (mask.get(bx, by)) angles.set(bx, by, atanVector(smoothed.getX(bx, by), smoothed.getY(bx, by)));
  return angles;
}

// ---- OrientedSmoothing ----

function smoothingLines(resolution: number, radius: number, step: number): Array<Array<[number, number]>> {
  const result: Array<Array<[number, number]>> = [];
  for (let orientationIndex = 0; orientationIndex < resolution; ++orientationIndex) {
    const line: Array<[number, number]> = [[0, 0]];
    const angle = DoubleAngle.fromOrientation(DoubleAngle.bucketCenter(orientationIndex, resolution));
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    for (let r = radius; r >= 0.5; r /= step) {
      const sampleX = Math.round(dirX * r);
      const sampleY = Math.round(dirY * r);
      if (!line.some(([lx, ly]) => lx === sampleX && ly === sampleY)) {
        line.push([sampleX, sampleY]);
        line.push([-sampleX, -sampleY]);
      }
    }
    result.push(line);
  }
  return result;
}

function orientedSmooth(
  input: DoubleMatrix,
  orientation: DoubleMatrix,
  mask: BooleanMatrix,
  blocks: BlockMap,
  angle: number,
  lines: Array<Array<[number, number]>>,
): DoubleMatrix {
  const output = new DoubleMatrix(input.width, input.height);
  const pixelsRect: IntRect = { x: 0, y: 0, width: blocks.pixelsX, height: blocks.pixelsY };
  for (let by = 0; by < blocks.primary.blocksY; ++by)
    for (let bx = 0; bx < blocks.primary.blocksX; ++bx)
      if (mask.get(bx, by)) {
        const line = lines[DoubleAngle.quantize(DoubleAngle.add(orientation.get(bx, by), angle), lines.length)];
        for (const [lx, ly] of line) {
          const block = blocks.primary.block(bx, by);
          const source = rectIntersect({ x: block.x + lx, y: block.y + ly, width: block.width, height: block.height }, pixelsRect);
          const target: IntRect = { x: source.x - lx, y: source.y - ly, width: source.width, height: source.height };
          for (let y = target.y; y < rectBottom(target); ++y)
            for (let x = target.x; x < rectRight(target); ++x) output.add(x, y, input.get(x + lx, y + ly));
        }
        const blockArea = blocks.primary.block(bx, by);
        for (let y = blockArea.y; y < rectBottom(blockArea); ++y)
          for (let x = blockArea.x; x < rectRight(blockArea); ++x) output.multiply(x, y, 1.0 / line.length);
      }
  return output;
}

// ---- Binarization ----

function binarize(input: DoubleMatrix, baseline: DoubleMatrix, mask: BooleanMatrix, blocks: BlockMap): BooleanMatrix {
  const binarized = new BooleanMatrix(input.width, input.height);
  for (let by = 0; by < blocks.primary.blocksY; ++by)
    for (let bx = 0; bx < blocks.primary.blocksX; ++bx)
      if (mask.get(bx, by)) {
        const rect = blocks.primary.block(bx, by);
        for (let y = rect.y; y < rectBottom(rect); ++y)
          for (let x = rect.x; x < rectRight(rect); ++x) if (input.get(x, y) - baseline.get(x, y) > 0) binarized.set(x, y, true);
      }
  return binarized;
}

function removeCrosses(input: BooleanMatrix): void {
  let any = true;
  while (any) {
    any = false;
    for (let y = 0; y < input.height - 1; ++y)
      for (let x = 0; x < input.width - 1; ++x)
        if (
          (input.get(x, y) && input.get(x + 1, y + 1) && !input.get(x, y + 1) && !input.get(x + 1, y)) ||
          (input.get(x, y + 1) && input.get(x + 1, y) && !input.get(x, y) && !input.get(x + 1, y + 1))
        ) {
          input.set(x, y, false);
          input.set(x, y + 1, false);
          input.set(x + 1, y, false);
          input.set(x + 1, y + 1, false);
          any = true;
        }
  }
}

function binarizedCleanup(binary: BooleanMatrix, mask: BooleanMatrix): void {
  const inverted = BooleanMatrix.copyOf(binary);
  inverted.invert();
  const islands = voteFilter(inverted, mask, Parameters.BINARIZED_VOTE_RADIUS, Parameters.BINARIZED_VOTE_MAJORITY, Parameters.BINARIZED_VOTE_BORDER_DISTANCE);
  const holes = voteFilter(binary, mask, Parameters.BINARIZED_VOTE_RADIUS, Parameters.BINARIZED_VOTE_MAJORITY, Parameters.BINARIZED_VOTE_BORDER_DISTANCE);
  for (let y = 0; y < binary.height; ++y)
    for (let x = 0; x < binary.width; ++x) binary.set(x, y, (binary.get(x, y) && !islands.get(x, y)) || holes.get(x, y));
  removeCrosses(binary);
}

function invertBinary(binary: BooleanMatrix, mask: BooleanMatrix): BooleanMatrix {
  const inverted = new BooleanMatrix(binary.width, binary.height);
  for (let y = 0; y < binary.height; ++y) for (let x = 0; x < binary.width; ++x) inverted.set(x, y, !binary.get(x, y) && mask.get(x, y));
  return inverted;
}

// ---- Minutiae collection + filters ----

function collectMinutiae(minutiae: FeatureMinutia[], skeleton: Skeleton, type: MinutiaTypeValue): void {
  for (const sminutia of skeleton.minutiae)
    if (sminutia.ridges.length === 1)
      minutiae.push({ x: sminutia.x, y: sminutia.y, direction: sminutia.ridges[0].direction(), type });
}

function innerMinutiaeFilter(minutiae: FeatureMinutia[], mask: BooleanMatrix): FeatureMinutia[] {
  return minutiae.filter((minutia) => {
    const arrowX = Math.round(Math.cos(minutia.direction) * -Parameters.MASK_DISPLACEMENT);
    const arrowY = Math.round(Math.sin(minutia.direction) * -Parameters.MASK_DISPLACEMENT);
    return mask.getF(minutia.x + arrowX, minutia.y + arrowY, false);
  });
}

function minutiaCloudFilter(minutiae: FeatureMinutia[]): FeatureMinutia[] {
  const radiusSq = Parameters.MINUTIA_CLOUD_RADIUS * Parameters.MINUTIA_CLOUD_RADIUS;
  const removed = new Set<FeatureMinutia>();
  for (const minutia of minutiae) {
    let cloud = 0;
    for (const neighbor of minutiae) {
      const dx = neighbor.x - minutia.x;
      const dy = neighbor.y - minutia.y;
      if (dx * dx + dy * dy <= radiusSq) ++cloud;
    }
    if (Parameters.MAX_CLOUD_SIZE < cloud - 1) removed.add(minutia);
  }
  return minutiae.filter((m) => !removed.has(m));
}

function topMinutiaeFilter(minutiae: FeatureMinutia[]): FeatureMinutia[] {
  if (minutiae.length <= Parameters.MAX_MINUTIAE) return minutiae;
  const rank = (minutia: FeatureMinutia): number => {
    const distances = minutiae.map((neighbor) => {
      const dx = minutia.x - neighbor.x;
      const dy = minutia.y - neighbor.y;
      return dx * dx + dy * dy;
    });
    distances.sort((a, b) => a - b);
    return Parameters.SORT_BY_NEIGHBOR < distances.length ? distances[Parameters.SORT_BY_NEIGHBOR] : 0x7fffffff;
  };
  const ranks = new Map<FeatureMinutia, number>();
  for (const m of minutiae) ranks.set(m, rank(m));
  return [...minutiae].sort((a, b) => (ranks.get(b) as number) - (ranks.get(a) as number)).slice(0, Parameters.MAX_MINUTIAE);
}

// ---- FeatureExtractor ----

export function extractFeatures(raw: DoubleMatrix, dpi: number): FeatureTemplateData {
  const scaled = resize(raw, dpi);
  const blocks = new BlockMap(scaled.width, scaled.height, Parameters.BLOCK_SIZE);
  const histogram = histogramCreate(blocks, scaled);
  const smoothHistogram = histogramSmooth(blocks, histogram);
  const mask = segmentationMask(blocks, histogram);
  const equalized = equalize(blocks, scaled, smoothHistogram, mask);
  const orientation = blockOrientations(equalized, mask, blocks);
  const smoothed = orientedSmooth(
    equalized,
    orientation,
    mask,
    blocks,
    0,
    smoothingLines(Parameters.PARALLEL_SMOOTHING_RESOLUTION, Parameters.PARALLEL_SMOOTHING_RADIUS, Parameters.PARALLEL_SMOOTHING_STEP),
  );
  const orthogonal = orientedSmooth(
    smoothed,
    orientation,
    mask,
    blocks,
    Math.PI,
    smoothingLines(Parameters.ORTHOGONAL_SMOOTHING_RESOLUTION, Parameters.ORTHOGONAL_SMOOTHING_RADIUS, Parameters.ORTHOGONAL_SMOOTHING_STEP),
  );
  const binary = binarize(smoothed, orthogonal, mask, blocks);
  const pixelMask = pixelwiseMask(mask, blocks);
  binarizedCleanup(binary, pixelMask);
  const inverted = invertBinary(binary, pixelMask);
  const inner = innerMask(pixelMask);
  const ridges = createSkeleton(binary, SkeletonType.RIDGES);
  const valleys = createSkeleton(inverted, SkeletonType.VALLEYS);
  let minutiae: FeatureMinutia[] = [];
  collectMinutiae(minutiae, ridges, MinutiaType.ENDING);
  collectMinutiae(minutiae, valleys, MinutiaType.BIFURCATION);
  minutiae = innerMinutiaeFilter(minutiae, inner);
  minutiae = minutiaCloudFilter(minutiae);
  minutiae = topMinutiaeFilter(minutiae);
  return { width: scaled.width, height: scaled.height, minutiae };
}

export { fround };
