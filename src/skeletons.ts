/*
 * Port of SourceAFIS engine.extractor.skeletons + engine.features.Skeleton* (Java 3.18.1).
 * SkeletonRidge mirrors Java's CircularList + ReversedList pair: forward and reversed
 * ridge share one point array; the reversed view prepends on add and reads back-to-front.
 */

import { BooleanMatrix } from './extractor';
import { atanVector, DoubleAngle, JavaPriorityQueue } from './primitives';
import { Parameters } from './templates';

const fround = Math.fround;

export const SkeletonType = { RIDGES: 0, VALLEYS: 1 } as const;
export type SkeletonTypeValue = (typeof SkeletonType)[keyof typeof SkeletonType];

export interface Pos {
  x: number;
  y: number;
}

// Java IntPoint.CORNER_NEIGHBORS — order matters for tracing.
const CORNER_NEIGHBORS: Pos[] = [
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: -1, y: 1 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
];

/** Java IntPoint.lineTo — Bresenham-like with double rounding, ported verbatim. */
export function lineTo(from: Pos, to: Pos): Pos[] {
  const relX = to.x - from.x;
  const relY = to.y - from.y;
  let result: Pos[];
  if (Math.abs(relX) >= Math.abs(relY)) {
    result = new Array(Math.abs(relX) + 1);
    if (relX > 0) {
      for (let i = 0; i <= relX; ++i) result[i] = { x: from.x + i, y: from.y + Math.round(i * (relY / relX)) };
    } else if (relX < 0) {
      for (let i = 0; i <= -relX; ++i) result[i] = { x: from.x - i, y: from.y - Math.round(i * (relY / relX)) };
    } else result[0] = from;
  } else {
    result = new Array(Math.abs(relY) + 1);
    if (relY > 0) {
      for (let i = 0; i <= relY; ++i) result[i] = { x: from.x + Math.round(i * (relX / relY)), y: from.y + i };
    } else if (relY < 0) {
      for (let i = 0; i <= -relY; ++i) result[i] = { x: from.x - Math.round(i * (relX / relY)), y: from.y - i };
    } else result[0] = from;
  }
  return result;
}

class RidgePoints {
  constructor(
    private readonly shared: { pts: Pos[] },
    private readonly rev: boolean,
  ) {}
  size(): number {
    return this.shared.pts.length;
  }
  get(index: number): Pos {
    return this.rev ? this.shared.pts[this.shared.pts.length - 1 - index] : this.shared.pts[index];
  }
  add(point: Pos): void {
    if (this.rev) this.shared.pts.unshift(point);
    else this.shared.pts.push(point);
  }
  removeLast(): void {
    if (this.rev) this.shared.pts.shift();
    else this.shared.pts.pop();
  }
  *[Symbol.iterator](): Iterator<Pos> {
    for (let i = 0; i < this.size(); ++i) yield this.get(i);
  }
  /** @internal */
  sharedStorage(): { pts: Pos[] } {
    return this.shared;
  }
}

export class SkeletonRidge {
  readonly points: RidgePoints;
  readonly reversed: SkeletonRidge;
  private startMinutia: SkeletonMinutia | null = null;
  private endMinutia: SkeletonMinutia | null = null;

  constructor(twin?: SkeletonRidge) {
    if (twin) {
      this.reversed = twin;
      this.points = new RidgePoints(twin.points.sharedStorage(), true);
    } else {
      this.points = new RidgePoints({ pts: [] }, false);
      this.reversed = new SkeletonRidge(this);
    }
  }
  start(): SkeletonMinutia | null {
    return this.startMinutia;
  }
  setStart(value: SkeletonMinutia | null): void {
    if (this.startMinutia !== value) {
      if (this.startMinutia !== null) {
        const detachFrom = this.startMinutia;
        this.startMinutia = null;
        detachFrom.detachStart(this);
      }
      this.startMinutia = value;
      if (this.startMinutia !== null) this.startMinutia.attachStart(this);
      this.reversed.endMinutia = value;
    }
  }
  end(): SkeletonMinutia | null {
    return this.endMinutia;
  }
  setEnd(value: SkeletonMinutia | null): void {
    if (this.endMinutia !== value) {
      this.endMinutia = value;
      this.reversed.setStart(value);
    }
  }
  detach(): void {
    this.setStart(null);
    this.setEnd(null);
  }
  direction(): number {
    let first: number = Parameters.RIDGE_DIRECTION_SKIP;
    let last: number = Parameters.RIDGE_DIRECTION_SKIP + Parameters.RIDGE_DIRECTION_SAMPLE - 1;
    if (last >= this.points.size()) {
      const shift = last - this.points.size() + 1;
      last -= shift;
      first -= shift;
    }
    if (first < 0) first = 0;
    const a = this.points.get(first);
    const b = this.points.get(last);
    return fround(atanVector(b.x - a.x, b.y - a.y));
  }
}

export class SkeletonMinutia {
  readonly ridges: SkeletonRidge[] = [];
  constructor(
    readonly x: number,
    readonly y: number,
  ) {}
  attachStart(ridge: SkeletonRidge): void {
    if (!this.ridges.includes(ridge)) {
      this.ridges.push(ridge);
      ridge.setStart(this);
    }
  }
  detachStart(ridge: SkeletonRidge): void {
    const index = this.ridges.indexOf(ridge);
    if (index >= 0) {
      this.ridges.splice(index, 1);
      if (ridge.start() === this) ridge.setStart(null);
    }
  }
}

export class Skeleton {
  readonly minutiae: SkeletonMinutia[] = [];
  constructor(
    readonly type: SkeletonTypeValue,
    readonly width: number,
    readonly height: number,
  ) {}
  addMinutia(minutia: SkeletonMinutia): void {
    this.minutiae.push(minutia);
  }
  removeMinutia(minutia: SkeletonMinutia): void {
    const index = this.minutiae.indexOf(minutia);
    if (index >= 0) this.minutiae.splice(index, 1);
  }
  shadow(): BooleanMatrix {
    const shadow = new BooleanMatrix(this.width, this.height);
    for (const minutia of this.minutiae) {
      shadow.set(minutia.x, minutia.y, true);
      for (const ridge of minutia.ridges)
        if ((ridge.start() as SkeletonMinutia).y <= (ridge.end() as SkeletonMinutia).y)
          for (const point of ridge.points) shadow.set(point.x, point.y, true);
    }
    return shadow;
  }
}

// ---- BinaryThinning ----

const enum NeighborhoodType {
  Skeleton,
  Ending,
  Removable,
}

let cachedNeighborhoodTypes: Uint8Array | null = null;

function neighborhoodTypes(): Uint8Array {
  if (cachedNeighborhoodTypes) return cachedNeighborhoodTypes;
  const types = new Uint8Array(256);
  for (let mask = 0; mask < 256; ++mask) {
    const TL = (mask & 1) !== 0;
    const TC = (mask & 2) !== 0;
    const TR = (mask & 4) !== 0;
    const CL = (mask & 8) !== 0;
    const CR = (mask & 16) !== 0;
    const BL = (mask & 32) !== 0;
    const BC = (mask & 64) !== 0;
    const BR = (mask & 128) !== 0;
    let count = 0;
    for (let bit = mask; bit !== 0; bit >>= 1) count += bit & 1;
    const diagonal = (!TC && !CL && TL) || (!CL && !BC && BL) || (!BC && !CR && BR) || (!CR && !TC && TR);
    const horizontal = !TC && !BC && (TR || CR || BR) && (TL || CL || BL);
    const vertical = !CL && !CR && (TL || TC || TR) && (BL || BC || BR);
    const end = count === 1;
    if (end) types[mask] = NeighborhoodType.Ending;
    else if (!diagonal && !horizontal && !vertical) types[mask] = NeighborhoodType.Removable;
    else types[mask] = NeighborhoodType.Skeleton;
  }
  cachedNeighborhoodTypes = types;
  return types;
}

function isFalseEnding(binary: BooleanMatrix, endingX: number, endingY: number): boolean {
  for (const relative of CORNER_NEIGHBORS) {
    const nx = endingX + relative.x;
    const ny = endingY + relative.y;
    if (binary.get(nx, ny)) {
      let count = 0;
      for (const relative2 of CORNER_NEIGHBORS) if (binary.getF(nx + relative2.x, ny + relative2.y, false)) ++count;
      return count > 2;
    }
  }
  return false;
}

function thin(input: BooleanMatrix): BooleanMatrix {
  const types = neighborhoodTypes();
  const sizeX = input.width;
  const sizeY = input.height;
  const partial = new BooleanMatrix(sizeX, sizeY);
  for (let y = 1; y < sizeY - 1; ++y) for (let x = 1; x < sizeX - 1; ++x) partial.set(x, y, input.get(x, y));
  const thinned = new BooleanMatrix(sizeX, sizeY);
  let removedAnything = true;
  for (let i = 0; i < Parameters.THINNING_ITERATIONS && removedAnything; ++i) {
    removedAnything = false;
    for (let evenY = 0; evenY < 2; ++evenY)
      for (let evenX = 0; evenX < 2; ++evenX)
        for (let y = 1 + evenY; y < sizeY - 1; y += 2)
          for (let x = 1 + evenX; x < sizeX - 1; x += 2)
            if (
              partial.get(x, y) &&
              !thinned.get(x, y) &&
              !(partial.get(x, y - 1) && partial.get(x, y + 1) && partial.get(x - 1, y) && partial.get(x + 1, y))
            ) {
              const neighbors =
                (partial.get(x + 1, y + 1) ? 128 : 0) |
                (partial.get(x, y + 1) ? 64 : 0) |
                (partial.get(x - 1, y + 1) ? 32 : 0) |
                (partial.get(x + 1, y) ? 16 : 0) |
                (partial.get(x - 1, y) ? 8 : 0) |
                (partial.get(x + 1, y - 1) ? 4 : 0) |
                (partial.get(x, y - 1) ? 2 : 0) |
                (partial.get(x - 1, y - 1) ? 1 : 0);
              if (
                types[neighbors] === NeighborhoodType.Removable ||
                (types[neighbors] === NeighborhoodType.Ending && isFalseEnding(partial, x, y))
              ) {
                removedAnything = true;
                partial.set(x, y, false);
              } else thinned.set(x, y, true);
            }
  }
  return thinned;
}

// ---- SkeletonTracing ----

function traceSkeleton(thinned: BooleanMatrix, type: SkeletonTypeValue): Skeleton {
  const width = thinned.width;
  const key = (p: Pos): number => p.y * width + p.x;
  const skeleton = new Skeleton(type, thinned.width, thinned.height);

  // findMinutiae — row-major scan
  const minutiaPoints: Pos[] = [];
  for (let y = 0; y < thinned.height; ++y)
    for (let x = 0; x < thinned.width; ++x)
      if (thinned.get(x, y)) {
        let count = 0;
        for (const relative of CORNER_NEIGHBORS) if (thinned.getF(x + relative.x, y + relative.y, false)) ++count;
        if (count === 1 || count > 2) minutiaPoints.push({ x, y });
      }

  // linkNeighboringMinutiae
  const linking = new Map<number, Pos[]>();
  for (const minutiaPos of minutiaPoints) {
    let ownLinks: Pos[] | null = null;
    for (const neighborRelative of CORNER_NEIGHBORS) {
      const neighborKey = key({ x: minutiaPos.x + neighborRelative.x, y: minutiaPos.y + neighborRelative.y });
      const neighborLinks = linking.get(neighborKey);
      if (neighborLinks !== undefined && neighborLinks !== ownLinks) {
        if (ownLinks !== null) {
          neighborLinks.push(...ownLinks);
          for (const mergedPos of ownLinks) linking.set(key(mergedPos), neighborLinks);
        }
        ownLinks = neighborLinks;
      }
    }
    if (ownLinks === null) ownLinks = [];
    ownLinks.push(minutiaPos);
    linking.set(key(minutiaPos), ownLinks);
  }

  // minutiaCenters — iterate keys sorted by (y, x); numeric key preserves that order
  const centers = new Map<number, SkeletonMinutia>();
  const sortedKeys = [...linking.keys()].sort((a, b) => a - b);
  for (const currentKey of sortedKeys) {
    const linkedMinutiae = linking.get(currentKey) as Pos[];
    const primaryKey = key(linkedMinutiae[0]);
    if (!centers.has(primaryKey)) {
      let sumX = 0;
      let sumY = 0;
      for (const linkedPos of linkedMinutiae) {
        sumX += linkedPos.x;
        sumY += linkedPos.y;
      }
      const minutia = new SkeletonMinutia(Math.trunc(sumX / linkedMinutiae.length), Math.trunc(sumY / linkedMinutiae.length));
      skeleton.addMinutia(minutia);
      centers.set(primaryKey, minutia);
    }
    centers.set(currentKey, centers.get(primaryKey) as SkeletonMinutia);
  }

  // traceRidges
  const leads = new Map<number, SkeletonRidge>();
  for (const minutiaKey of sortedKeys) {
    if (!centers.has(minutiaKey)) continue;
    const minutiaPoint: Pos = { x: minutiaKey % width, y: Math.trunc(minutiaKey / width) };
    for (const startRelative of CORNER_NEIGHBORS) {
      const start: Pos = { x: minutiaPoint.x + startRelative.x, y: minutiaPoint.y + startRelative.y };
      if (thinned.getF(start.x, start.y, false) && !centers.has(key(start)) && !leads.has(key(start))) {
        const ridge = new SkeletonRidge();
        ridge.points.add(minutiaPoint);
        ridge.points.add(start);
        let previous = minutiaPoint;
        let current = start;
        do {
          let next: Pos = { x: 0, y: 0 };
          for (const nextRelative of CORNER_NEIGHBORS) {
            next = { x: current.x + nextRelative.x, y: current.y + nextRelative.y };
            if (thinned.getF(next.x, next.y, false) && !(next.x === previous.x && next.y === previous.y)) break;
          }
          previous = current;
          current = next;
          ridge.points.add(current);
        } while (!centers.has(key(current)));
        const end = current;
        ridge.setStart(centers.get(key(minutiaPoint)) as SkeletonMinutia);
        ridge.setEnd(centers.get(key(end)) as SkeletonMinutia);
        leads.set(key(ridge.points.get(1)), ridge);
        leads.set(key(ridge.reversed.points.get(1)), ridge);
      }
    }
  }

  // fixLinkingGaps
  for (const minutia of skeleton.minutiae) {
    for (const ridge of minutia.ridges) {
      const first = ridge.points.get(0);
      if (!(first.x === minutia.x && first.y === minutia.y)) {
        const filling = lineTo(first, { x: minutia.x, y: minutia.y });
        for (let i = 1; i < filling.length; ++i) ridge.reversed.points.add(filling[i]);
      }
    }
  }

  return skeleton;
}

// ---- Filters ----

function dotFilter(skeleton: Skeleton): void {
  const removed = skeleton.minutiae.filter((m) => m.ridges.length === 0);
  for (const minutia of removed) skeleton.removeMinutia(minutia);
}

function knotFilter(skeleton: Skeleton): void {
  for (const minutia of skeleton.minutiae) {
    if (minutia.ridges.length === 2 && minutia.ridges[0].reversed !== minutia.ridges[1]) {
      let extended = minutia.ridges[0].reversed;
      let removed = minutia.ridges[1];
      if (extended.points.size() < removed.points.size()) {
        const tmp = extended;
        extended = removed;
        removed = tmp;
        extended = extended.reversed;
        removed = removed.reversed;
      }
      extended.points.removeLast();
      for (const point of removed.points) extended.points.add(point);
      extended.setEnd(removed.end());
      removed.detach();
    }
  }
  dotFilter(skeleton);
}

function poreFilter(skeleton: Skeleton): void {
  for (const minutia of skeleton.minutiae) {
    if (minutia.ridges.length === 3) {
      for (let exit = 0; exit < 3; ++exit) {
        const exitRidge = minutia.ridges[exit];
        const arm1 = minutia.ridges[(exit + 1) % 3];
        const arm2 = minutia.ridges[(exit + 2) % 3];
        if (arm1.end() === arm2.end() && exitRidge.end() !== arm1.end() && arm1.end() !== minutia && exitRidge.end() !== minutia) {
          const end = arm1.end() as SkeletonMinutia;
          if (end.ridges.length === 3 && arm1.points.size() <= Parameters.MAX_PORE_ARM && arm2.points.size() <= Parameters.MAX_PORE_ARM) {
            arm1.detach();
            arm2.detach();
            const merged = new SkeletonRidge();
            merged.setStart(minutia);
            merged.setEnd(end);
            for (const point of lineTo({ x: minutia.x, y: minutia.y }, { x: end.x, y: end.y })) merged.points.add(point);
          }
          break;
        }
      }
    }
  }
  knotFilter(skeleton);
}

interface SkeletonGap {
  distance: number;
  end1: SkeletonMinutia;
  end2: SkeletonMinutia;
}

function compareGap(a: SkeletonGap, b: SkeletonGap): number {
  if (a.distance !== b.distance) return a.distance - b.distance;
  if (a.end1.y !== b.end1.y) return a.end1.y - b.end1.y;
  if (a.end1.x !== b.end1.x) return a.end1.x - b.end1.x;
  if (a.end2.y !== b.end2.y) return a.end2.y - b.end2.y;
  return a.end2.x - b.end2.x;
}

function angleSampleForGapRemoval(minutia: SkeletonMinutia): Pos {
  const ridge = minutia.ridges[0];
  if (Parameters.GAP_ANGLE_OFFSET < ridge.points.size()) return ridge.points.get(Parameters.GAP_ANGLE_OFFSET);
  const end = ridge.end() as SkeletonMinutia;
  return { x: end.x, y: end.y };
}

function isWithinGapLimits(end1: SkeletonMinutia, end2: SkeletonMinutia): boolean {
  const dx = end1.x - end2.x;
  const dy = end1.y - end2.y;
  const distanceSq = dx * dx + dy * dy;
  if (distanceSq <= Parameters.MAX_RUPTURE_SIZE * Parameters.MAX_RUPTURE_SIZE) return true;
  if (distanceSq > Parameters.MAX_GAP_SIZE * Parameters.MAX_GAP_SIZE) return false;
  const gapDirection = atanVector(end2.x - end1.x, end2.y - end1.y);
  const sample1 = angleSampleForGapRemoval(end1);
  const direction1 = atanVector(sample1.x - end1.x, sample1.y - end1.y);
  if (DoubleAngle.distance(direction1, DoubleAngle.opposite(gapDirection)) > Parameters.MAX_GAP_ANGLE) return false;
  const sample2 = angleSampleForGapRemoval(end2);
  const direction2 = atanVector(sample2.x - end2.x, sample2.y - end2.y);
  if (DoubleAngle.distance(direction2, gapDirection) > Parameters.MAX_GAP_ANGLE) return false;
  return true;
}

function isRidgeOverlapping(line: Pos[], shadow: BooleanMatrix): boolean {
  for (let i = Parameters.TOLERATED_GAP_OVERLAP; i < line.length - Parameters.TOLERATED_GAP_OVERLAP; ++i)
    if (shadow.get(line[i].x, line[i].y)) return true;
  return false;
}

function addGapRidge(shadow: BooleanMatrix, gap: SkeletonGap, line: Pos[]): void {
  const ridge = new SkeletonRidge();
  for (const point of line) ridge.points.add(point);
  ridge.setStart(gap.end1);
  ridge.setEnd(gap.end2);
  for (const point of line) shadow.set(point.x, point.y, true);
}

function gapFilter(skeleton: Skeleton): void {
  const queue = new JavaPriorityQueue<SkeletonGap>(compareGap);
  for (const end1 of skeleton.minutiae)
    if (end1.ridges.length === 1 && end1.ridges[0].points.size() >= Parameters.SHORTEST_JOINED_ENDING)
      for (const end2 of skeleton.minutiae)
        if (
          end2 !== end1 &&
          end2.ridges.length === 1 &&
          end1.ridges[0].end() !== end2 &&
          end2.ridges[0].points.size() >= Parameters.SHORTEST_JOINED_ENDING &&
          isWithinGapLimits(end1, end2)
        ) {
          const dx = end1.x - end2.x;
          const dy = end1.y - end2.y;
          queue.add({ distance: dx * dx + dy * dy, end1, end2 });
        }
  const shadow = skeleton.shadow();
  while (!queue.isEmpty()) {
    const gap = queue.remove();
    if (gap.end1.ridges.length === 1 && gap.end2.ridges.length === 1) {
      const line = lineTo({ x: gap.end1.x, y: gap.end1.y }, { x: gap.end2.x, y: gap.end2.y });
      if (!isRidgeOverlapping(line, shadow)) addGapRidge(shadow, gap, line);
    }
  }
  knotFilter(skeleton);
}

function tailFilter(skeleton: Skeleton): void {
  for (const minutia of skeleton.minutiae) {
    if (minutia.ridges.length === 1 && (minutia.ridges[0].end() as SkeletonMinutia).ridges.length >= 3)
      if (minutia.ridges[0].points.size() < Parameters.MIN_TAIL_LENGTH) minutia.ridges[0].detach();
  }
  dotFilter(skeleton);
  knotFilter(skeleton);
}

function fragmentFilter(skeleton: Skeleton): void {
  for (const minutia of skeleton.minutiae)
    if (minutia.ridges.length === 1) {
      const ridge = minutia.ridges[0];
      if ((ridge.end() as SkeletonMinutia).ridges.length === 1 && ridge.points.size() < Parameters.MIN_FRAGMENT_LENGTH) ridge.detach();
    }
  dotFilter(skeleton);
}

export function createSkeleton(binary: BooleanMatrix, type: SkeletonTypeValue): Skeleton {
  const thinned = thin(binary);
  const skeleton = traceSkeleton(thinned, type);
  dotFilter(skeleton);
  poreFilter(skeleton);
  gapFilter(skeleton);
  tailFilter(skeleton);
  fragmentFilter(skeleton);
  return skeleton;
}
