/*
 * Port of SourceAFIS engine.features + engine.templates (Java 3.18.1), matcher subset:
 * EdgeShape, NeighborEdge, IndexedEdge, SearchMinutia, SearchTemplate, PersistentTemplate.
 */

import { cborDecode, encodePersistentTemplate, PersistentTemplateFields } from './cbor';
import { atanVector, FloatAngle } from './primitives';

const fround = Math.fround;

export const Parameters = {
  BLOCK_SIZE: 15,
  HISTOGRAM_DEPTH: 256,
  CLIPPED_CONTRAST: 0.08,
  MIN_ABSOLUTE_CONTRAST: 17 / 255.0,
  MIN_RELATIVE_CONTRAST: 0.34,
  RELATIVE_CONTRAST_SAMPLE: 168568,
  RELATIVE_CONTRAST_PERCENTILE: 0.49,
  MASK_VOTE_RADIUS: 7,
  MASK_VOTE_MAJORITY: 0.51,
  MASK_VOTE_BORDER_DISTANCE: 4,
  BLOCK_ERRORS_VOTE_RADIUS: 1,
  BLOCK_ERRORS_VOTE_MAJORITY: 0.7,
  BLOCK_ERRORS_VOTE_BORDER_DISTANCE: 4,
  MAX_EQUALIZATION_SCALING: 3.99,
  MIN_EQUALIZATION_SCALING: 0.25,
  MIN_ORIENTATION_RADIUS: 2,
  MAX_ORIENTATION_RADIUS: 6,
  ORIENTATION_SPLIT: 50,
  ORIENTATIONS_CHECKED: 20,
  ORIENTATION_SMOOTHING_RADIUS: 1,
  PARALLEL_SMOOTHING_RESOLUTION: 32,
  PARALLEL_SMOOTHING_RADIUS: 7,
  PARALLEL_SMOOTHING_STEP: 1.59,
  ORTHOGONAL_SMOOTHING_RESOLUTION: 11,
  ORTHOGONAL_SMOOTHING_RADIUS: 4,
  ORTHOGONAL_SMOOTHING_STEP: 1.11,
  BINARIZED_VOTE_RADIUS: 2,
  BINARIZED_VOTE_MAJORITY: 0.61,
  BINARIZED_VOTE_BORDER_DISTANCE: 17,
  INNER_MASK_BORDER_DISTANCE: 14,
  MASK_DISPLACEMENT: 10.06,
  MINUTIA_CLOUD_RADIUS: 20,
  MAX_CLOUD_SIZE: 4,
  SORT_BY_NEIGHBOR: 5,
  THINNING_ITERATIONS: 26,
  MAX_PORE_ARM: 41,
  SHORTEST_JOINED_ENDING: 7,
  MAX_RUPTURE_SIZE: 5,
  MAX_GAP_SIZE: 20,
  GAP_ANGLE_OFFSET: 22,
  TOLERATED_GAP_OVERLAP: 2,
  MIN_TAIL_LENGTH: 21,
  MIN_FRAGMENT_LENGTH: 22,
  MAX_GAP_ANGLE: (45 / 180.0) * Math.PI, // Java Math.toRadians(45): angdeg/180*PI — same op order
  RIDGE_DIRECTION_SAMPLE: 21,
  RIDGE_DIRECTION_SKIP: 1,
  MAX_MINUTIAE: 100,
  EDGE_TABLE_NEIGHBORS: 9,
  MAX_DISTANCE_ERROR: 13,
  // Java: FloatAngle.PI / 180 * 10 — float division then float multiplication
  MAX_ANGLE_ERROR: fround(fround(FloatAngle.PI / 180) * 10),
  MAX_TRIED_ROOTS: 70,
  MIN_ROOT_EDGE_LENGTH: 58,
  MAX_ROOT_EDGE_LOOKUPS: 1633,
  MIN_SUPPORTING_EDGES: 1,
  DISTANCE_ERROR_FLATNESS: 0.69,
  ANGLE_ERROR_FLATNESS: 0.27,
  MINUTIA_SCORE: 0.032,
  MINUTIA_FRACTION_SCORE: 8.98,
  MINUTIA_TYPE_SCORE: 0.629,
  SUPPORTED_MINUTIA_SCORE: 0.193,
  EDGE_SCORE: 0.265,
  DISTANCE_ACCURACY_SCORE: 9.9,
  ANGLE_ACCURACY_SCORE: 2.79,
  THRESHOLD_FMR_MAX: 8.48,
  THRESHOLD_FMR_2: 11.12,
  THRESHOLD_FMR_10: 14.15,
  THRESHOLD_FMR_100: 18.22,
  THRESHOLD_FMR_1000: 22.39,
  THRESHOLD_FMR_10_000: 27.24,
  THRESHOLD_FMR_100_000: 32.01,
} as const;

export const MinutiaType = {
  ENDING: 0,
  BIFURCATION: 1,
} as const;
export type MinutiaTypeValue = (typeof MinutiaType)[keyof typeof MinutiaType];

export interface SearchMinutia {
  readonly x: number;
  readonly y: number;
  readonly direction: number; // binary32 value
  readonly type: MinutiaTypeValue;
}

// EdgeShape polar cache (Java static initializer)
const POLAR_CACHE_BITS = 8;
const POLAR_CACHE_RADIUS = 1 << POLAR_CACHE_BITS;
const POLAR_DISTANCE_CACHE = new Int32Array(POLAR_CACHE_RADIUS * POLAR_CACHE_RADIUS);
const POLAR_ANGLE_CACHE = new Float32Array(POLAR_CACHE_RADIUS * POLAR_CACHE_RADIUS);
for (let y = 0; y < POLAR_CACHE_RADIUS; ++y)
  for (let x = 0; x < POLAR_CACHE_RADIUS; ++x) {
    POLAR_DISTANCE_CACHE[y * POLAR_CACHE_RADIUS + x] = Math.round(Math.sqrt(x * x + y * y));
    POLAR_ANGLE_CACHE[y * POLAR_CACHE_RADIUS + x] = y > 0 || x > 0 ? atanVector(x, y) : 0;
  }

export class EdgeShape {
  readonly length: number;
  readonly referenceAngle: number;
  readonly neighborAngle: number;
  constructor(reference: SearchMinutia, neighbor: SearchMinutia) {
    let quadrant = 0;
    let x = neighbor.x - reference.x;
    let y = neighbor.y - reference.y;
    if (y < 0) {
      x = -x;
      y = -y;
      quadrant = FloatAngle.PI;
    }
    if (x < 0) {
      const tmp = -x;
      x = y;
      y = tmp;
      quadrant = fround(quadrant + FloatAngle.HALF_PI);
    }
    const shift = 32 - Math.clz32((x | y) >>> POLAR_CACHE_BITS);
    const offset = (y >> shift) * POLAR_CACHE_RADIUS + (x >> shift);
    this.length = ((POLAR_DISTANCE_CACHE[offset] << shift) << 16) >> 16; // Java (short) cast
    const angle = fround(POLAR_ANGLE_CACHE[offset] + quadrant);
    this.referenceAngle = FloatAngle.difference(reference.direction, angle);
    this.neighborAngle = FloatAngle.difference(neighbor.direction, FloatAngle.opposite(angle));
  }
}

export class NeighborEdge extends EdgeShape {
  readonly neighbor: number;
  constructor(minutiae: SearchMinutia[], reference: number, neighbor: number) {
    super(minutiae[reference], minutiae[neighbor]);
    this.neighbor = neighbor;
  }

  static buildTable(minutiae: SearchMinutia[]): NeighborEdge[][] {
    const edges: NeighborEdge[][] = new Array(minutiae.length);
    const star: NeighborEdge[] = [];
    const allSqDistances = new Int32Array(minutiae.length);
    for (let reference = 0; reference < edges.length; ++reference) {
      const rminutia = minutiae[reference];
      let maxSqDistance = 0x7fffffff;
      if (minutiae.length - 1 > Parameters.EDGE_TABLE_NEIGHBORS) {
        for (let neighbor = 0; neighbor < minutiae.length; ++neighbor) {
          const nminutia = minutiae[neighbor];
          allSqDistances[neighbor] =
            (rminutia.x - nminutia.x) * (rminutia.x - nminutia.x) + (rminutia.y - nminutia.y) * (rminutia.y - nminutia.y);
        }
        allSqDistances.sort();
        maxSqDistance = allSqDistances[Parameters.EDGE_TABLE_NEIGHBORS];
      }
      for (let neighbor = 0; neighbor < minutiae.length; ++neighbor) {
        const nminutia = minutiae[neighbor];
        const sqDistance =
          (rminutia.x - nminutia.x) * (rminutia.x - nminutia.x) + (rminutia.y - nminutia.y) * (rminutia.y - nminutia.y);
        if (neighbor !== reference && sqDistance <= maxSqDistance) star.push(new NeighborEdge(minutiae, reference, neighbor));
      }
      star.sort((a, b) => a.length - b.length || a.neighbor - b.neighbor);
      star.length = Math.min(star.length, Parameters.EDGE_TABLE_NEIGHBORS);
      edges[reference] = star.slice();
      star.length = 0;
    }
    return edges;
  }
}

export class IndexedEdge extends EdgeShape {
  readonly reference: number;
  readonly neighbor: number;
  constructor(minutiae: SearchMinutia[], reference: number, neighbor: number) {
    super(minutiae[reference], minutiae[neighbor]);
    this.reference = reference & 0xff;
    this.neighbor = neighbor & 0xff;
  }
}

const PRIME = 1610612741;

export class SearchTemplate {
  static readonly EMPTY = new SearchTemplate(1, 1, []);
  readonly width: number;
  readonly height: number;
  readonly minutiae: SearchMinutia[];
  readonly edges: NeighborEdge[][];

  constructor(width: number, height: number, minutiae: SearchMinutia[]) {
    this.width = width;
    this.height = height;
    // Java sorts by an int-overflowing hash to deterministically shuffle minutiae.
    const key = (m: SearchMinutia): number => Math.imul((Math.imul(m.x, PRIME) + m.y) | 0, PRIME);
    this.minutiae = [...minutiae].sort(
      (a, b) => key(a) - key(b) || a.x - b.x || a.y - b.y || a.direction - b.direction || a.type - b.type,
    );
    this.edges = NeighborEdge.buildTable(this.minutiae);
  }

  /** Deserialize a template produced by FingerprintTemplate.toByteArray() (CBOR). */
  static fromByteArray(serialized: Uint8Array): SearchTemplate {
    const raw = cborDecode(serialized);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || raw instanceof Uint8Array)
      throw new Error('This is not a valid SourceAFIS template.');
    const map = raw as { [key: string]: unknown };
    const positionsX = map.positionsX as number[];
    const positionsY = map.positionsY as number[];
    const directions = map.directions as number[];
    const types = map.types as string;
    if (!Array.isArray(positionsX) || !Array.isArray(positionsY) || !Array.isArray(directions) || typeof types !== 'string')
      throw new Error('This is not a valid SourceAFIS template.');
    if (positionsX.length !== types.length || positionsY.length !== types.length || directions.length !== types.length)
      throw new Error('Inconsistent lengths of minutia property arrays.');
    const minutiae: SearchMinutia[] = [];
    for (let i = 0; i < types.length; ++i) {
      if (Math.abs(positionsX[i]) > 10_000 || Math.abs(positionsY[i]) > 10_000)
        throw new Error('Minutia position out of range.');
      const direction = fround(directions[i]);
      if (!FloatAngle.normalized(direction)) throw new Error('Denormalized minutia direction.');
      const typeChar = types.charAt(i);
      if (typeChar !== 'E' && typeChar !== 'B') throw new Error('Unknown minutia type.');
      minutiae.push({
        x: (positionsX[i] << 16) >> 16,
        y: (positionsY[i] << 16) >> 16,
        direction,
        type: typeChar === 'B' ? MinutiaType.BIFURCATION : MinutiaType.ENDING,
      });
    }
    return new SearchTemplate((map.width as number) ?? 0, (map.height as number) ?? 0, minutiae);
  }

  /** Serialize into the same CBOR shape as the Java implementation (readable by SourceAFIS 3.18.x). */
  toByteArray(): Uint8Array {
    const fields: PersistentTemplateFields = {
      version: '3.18.1-node',
      width: this.width,
      height: this.height,
      positionsX: this.minutiae.map((m) => m.x),
      positionsY: this.minutiae.map((m) => m.y),
      directions: this.minutiae.map((m) => m.direction),
      types: this.minutiae.map((m) => (m.type === MinutiaType.BIFURCATION ? 'B' : 'E')).join(''),
    };
    return encodePersistentTemplate(fields);
  }
}
