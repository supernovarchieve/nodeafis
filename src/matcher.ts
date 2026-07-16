/*
 * Port of SourceAFIS engine.matcher (Java 3.18.1):
 * EdgeHashes, RootEnumerator, PairingGraph, EdgeSpider, Scoring, MatcherEngine.
 * Transparency logging is omitted (NoTransparency path), which also means
 * supportEnabled is always false, exactly like the default Java configuration.
 */

import { FloatAngle, JavaPriorityQueue } from './primitives';
import { EdgeShape, IndexedEdge, NeighborEdge, Parameters, SearchTemplate } from './templates';

const fround = Math.fround;

const COMPLEMENTARY_MAX_ANGLE_ERROR = FloatAngle.complementary(Parameters.MAX_ANGLE_ERROR);

export const EdgeHashes = {
  hash(edge: EdgeShape): number {
    const lengthBin = Math.trunc(edge.length / Parameters.MAX_DISTANCE_ERROR);
    const referenceAngleBin = Math.trunc(fround(edge.referenceAngle / Parameters.MAX_ANGLE_ERROR));
    const neighborAngleBin = Math.trunc(fround(edge.neighborAngle / Parameters.MAX_ANGLE_ERROR));
    return (referenceAngleBin << 24) + (neighborAngleBin << 16) + lengthBin;
  },
  matching(probe: EdgeShape, candidate: EdgeShape): boolean {
    const lengthDelta = probe.length - candidate.length;
    if (lengthDelta >= -Parameters.MAX_DISTANCE_ERROR && lengthDelta <= Parameters.MAX_DISTANCE_ERROR) {
      const referenceDelta = FloatAngle.difference(probe.referenceAngle, candidate.referenceAngle);
      if (referenceDelta <= Parameters.MAX_ANGLE_ERROR || referenceDelta >= COMPLEMENTARY_MAX_ANGLE_ERROR) {
        const neighborDelta = FloatAngle.difference(probe.neighborAngle, candidate.neighborAngle);
        if (neighborDelta <= Parameters.MAX_ANGLE_ERROR || neighborDelta >= COMPLEMENTARY_MAX_ANGLE_ERROR) return true;
      }
    }
    return false;
  },
  coverage(edge: EdgeShape): number[] {
    const minLengthBin = Math.trunc((edge.length - Parameters.MAX_DISTANCE_ERROR) / Parameters.MAX_DISTANCE_ERROR);
    const maxLengthBin = Math.trunc((edge.length + Parameters.MAX_DISTANCE_ERROR) / Parameters.MAX_DISTANCE_ERROR);
    const angleBins = Math.ceil((2 * Math.PI) / Parameters.MAX_ANGLE_ERROR);
    const minReferenceBin = Math.trunc(
      fround(FloatAngle.difference(edge.referenceAngle, Parameters.MAX_ANGLE_ERROR) / Parameters.MAX_ANGLE_ERROR),
    );
    const maxReferenceBin = Math.trunc(
      fround(FloatAngle.add(edge.referenceAngle, Parameters.MAX_ANGLE_ERROR) / Parameters.MAX_ANGLE_ERROR),
    );
    const endReferenceBin = (maxReferenceBin + 1) % angleBins;
    const minNeighborBin = Math.trunc(
      fround(FloatAngle.difference(edge.neighborAngle, Parameters.MAX_ANGLE_ERROR) / Parameters.MAX_ANGLE_ERROR),
    );
    const maxNeighborBin = Math.trunc(
      fround(FloatAngle.add(edge.neighborAngle, Parameters.MAX_ANGLE_ERROR) / Parameters.MAX_ANGLE_ERROR),
    );
    const endNeighborBin = (maxNeighborBin + 1) % angleBins;
    const coverage: number[] = [];
    for (let lengthBin = minLengthBin; lengthBin <= maxLengthBin; ++lengthBin)
      for (let referenceBin = minReferenceBin; referenceBin !== endReferenceBin; referenceBin = (referenceBin + 1) % angleBins)
        for (let neighborBin = minNeighborBin; neighborBin !== endNeighborBin; neighborBin = (neighborBin + 1) % angleBins)
          coverage.push((referenceBin << 24) + (neighborBin << 16) + lengthBin);
    return coverage;
  },
  build(template: SearchTemplate): Map<number, IndexedEdge[]> {
    const map = new Map<number, IndexedEdge[]>();
    for (let reference = 0; reference < template.minutiae.length; ++reference)
      for (let neighbor = 0; neighbor < template.minutiae.length; ++neighbor)
        if (reference !== neighbor) {
          const edge = new IndexedEdge(template.minutiae, reference, neighbor);
          for (const hash of EdgeHashes.coverage(edge)) {
            let list = map.get(hash);
            if (list === undefined) map.set(hash, (list = []));
            list.push(edge);
          }
        }
    return map;
  },
};

export class Probe {
  constructor(
    readonly template: SearchTemplate,
    readonly hash: Map<number, IndexedEdge[]>,
  ) {}
}

export interface MinutiaPair {
  probe: number;
  candidate: number;
  probeRef: number;
  candidateRef: number;
  distance: number;
  supportingEdges: number;
}

function newPair(): MinutiaPair {
  return { probe: 0, candidate: 0, probeRef: 0, candidateRef: 0, distance: 0, supportingEdges: 0 };
}

class RootList {
  count = 0;
  readonly pairs: MinutiaPair[] = new Array(Parameters.MAX_TRIED_ROOTS);
  readonly duplicates = new Set<number>();
  add(pair: MinutiaPair): void {
    this.pairs[this.count] = pair;
    ++this.count;
  }
  discard(): void {
    this.count = 0;
    this.duplicates.clear();
  }
}

class PairingGraph {
  count = 0;
  tree: (MinutiaPair | null)[] = [null];
  byProbe: (MinutiaPair | null)[] = [null];
  byCandidate: (MinutiaPair | null)[] = [null];
  reserveProbe(probe: Probe): void {
    const capacity = probe.template.minutiae.length;
    if (capacity > this.tree.length) {
      this.tree = new Array(capacity).fill(null);
      this.byProbe = new Array(capacity).fill(null);
    }
  }
  reserveCandidate(candidate: SearchTemplate): void {
    const capacity = candidate.minutiae.length;
    if (this.byCandidate.length < capacity) this.byCandidate = new Array(capacity).fill(null);
  }
  addPair(pair: MinutiaPair): void {
    this.tree[this.count] = pair;
    this.byProbe[pair.probe] = pair;
    this.byCandidate[pair.candidate] = pair;
    ++this.count;
  }
  support(pair: MinutiaPair): void {
    const paired = this.byProbe[pair.probe];
    if (paired !== null && paired.candidate === pair.candidate) {
      ++paired.supportingEdges;
      ++(this.byProbe[pair.probeRef] as MinutiaPair).supportingEdges;
    }
  }
  clear(): void {
    for (let i = 0; i < this.count; ++i) {
      const pair = this.tree[i] as MinutiaPair;
      this.byProbe[pair.probe] = null;
      this.byCandidate[pair.candidate] = null;
      if (i === 0) pair.supportingEdges = 0; // root pair is reused by RootList
      this.tree[i] = null;
    }
    this.count = 0;
  }
}

const EdgeSpider = {
  matchPairs(pstar: NeighborEdge[], cstar: NeighborEdge[]): MinutiaPair[] {
    const results: MinutiaPair[] = [];
    let start = 0;
    let end = 0;
    for (let cindex = 0; cindex < cstar.length; ++cindex) {
      const cedge = cstar[cindex];
      while (start < pstar.length && pstar[start].length < cedge.length - Parameters.MAX_DISTANCE_ERROR) ++start;
      if (end < start) end = start;
      while (end < pstar.length && pstar[end].length <= cedge.length + Parameters.MAX_DISTANCE_ERROR) ++end;
      for (let pindex = start; pindex < end; ++pindex) {
        const pedge = pstar[pindex];
        const rdiff = FloatAngle.difference(pedge.referenceAngle, cedge.referenceAngle);
        if (rdiff <= Parameters.MAX_ANGLE_ERROR || rdiff >= COMPLEMENTARY_MAX_ANGLE_ERROR) {
          const ndiff = FloatAngle.difference(pedge.neighborAngle, cedge.neighborAngle);
          if (ndiff <= Parameters.MAX_ANGLE_ERROR || ndiff >= COMPLEMENTARY_MAX_ANGLE_ERROR) {
            const pair = newPair();
            pair.probe = pedge.neighbor;
            pair.candidate = cedge.neighbor;
            pair.distance = cedge.length;
            results.push(pair);
          }
        }
      }
    }
    return results;
  },
  collectEdges(
    pedges: NeighborEdge[][],
    cedges: NeighborEdge[][],
    pairing: PairingGraph,
    queue: JavaPriorityQueue<MinutiaPair>,
  ): void {
    const reference = pairing.tree[pairing.count - 1] as MinutiaPair;
    const pstar = pedges[reference.probe];
    const cstar = cedges[reference.candidate];
    for (const pair of EdgeSpider.matchPairs(pstar, cstar)) {
      pair.probeRef = reference.probe;
      pair.candidateRef = reference.candidate;
      if (pairing.byCandidate[pair.candidate] === null && pairing.byProbe[pair.probe] === null) queue.add(pair);
      else pairing.support(pair);
    }
  },
  skipPaired(pairing: PairingGraph, queue: JavaPriorityQueue<MinutiaPair>): void {
    while (!queue.isEmpty() && (pairing.byProbe[queue.peek().probe] !== null || pairing.byCandidate[queue.peek().candidate] !== null))
      pairing.support(queue.remove());
  },
  crawl(
    pedges: NeighborEdge[][],
    cedges: NeighborEdge[][],
    pairing: PairingGraph,
    root: MinutiaPair,
    queue: JavaPriorityQueue<MinutiaPair>,
  ): void {
    queue.add(root);
    do {
      pairing.addPair(queue.remove());
      EdgeSpider.collectEdges(pedges, cedges, pairing, queue);
      EdgeSpider.skipPaired(pairing, queue);
    } while (!queue.isEmpty());
  },
};

const RootEnumerator = {
  enumerate(probe: Probe, candidate: SearchTemplate, roots: RootList): void {
    const cminutiae = candidate.minutiae;
    let lookups = 0;
    let tried = 0;
    for (const shortEdges of [false, true]) {
      for (let period = 1; period < cminutiae.length; ++period) {
        for (let phase = 0; phase <= period; ++phase) {
          for (let creference = phase; creference < cminutiae.length; creference += period + 1) {
            const cneighbor = (creference + period) % cminutiae.length;
            const cedge = new EdgeShape(cminutiae[creference], cminutiae[cneighbor]);
            if (cedge.length >= Parameters.MIN_ROOT_EDGE_LENGTH !== shortEdges) {
              const matches = probe.hash.get(EdgeHashes.hash(cedge));
              if (matches !== undefined) {
                for (const match of matches) {
                  if (EdgeHashes.matching(match, cedge)) {
                    const duplicateKey = (match.reference << 16) | creference;
                    if (!roots.duplicates.has(duplicateKey)) {
                      roots.duplicates.add(duplicateKey);
                      const pair = newPair();
                      pair.probe = match.reference;
                      pair.candidate = creference;
                      roots.add(pair);
                    }
                    ++tried;
                    if (tried >= Parameters.MAX_TRIED_ROOTS) return;
                  }
                }
              }
              ++lookups;
              if (lookups >= Parameters.MAX_ROOT_EDGE_LOOKUPS) return;
            }
          }
        }
      }
    }
  },
};

const Scoring = {
  compute(probe: SearchTemplate, candidate: SearchTemplate, pairing: PairingGraph): number {
    const pminutiae = probe.minutiae;
    const cminutiae = candidate.minutiae;
    const minutiaCount = pairing.count;
    const minutiaScore = Parameters.MINUTIA_SCORE * minutiaCount;
    const minutiaFractionInProbe = pairing.count / pminutiae.length;
    const minutiaFractionInCandidate = pairing.count / cminutiae.length;
    const minutiaFraction = 0.5 * (minutiaFractionInProbe + minutiaFractionInCandidate);
    const minutiaFractionScore = Parameters.MINUTIA_FRACTION_SCORE * minutiaFraction;
    let supportingEdgeSum = 0;
    let supportedMinutiaCount = 0;
    let minutiaTypeHits = 0;
    for (let i = 0; i < pairing.count; ++i) {
      const pair = pairing.tree[i] as MinutiaPair;
      supportingEdgeSum += pair.supportingEdges;
      if (pair.supportingEdges >= Parameters.MIN_SUPPORTING_EDGES) ++supportedMinutiaCount;
      if (pminutiae[pair.probe].type === cminutiae[pair.candidate].type) ++minutiaTypeHits;
    }
    const edgeCount = pairing.count + supportingEdgeSum;
    const edgeScore = Parameters.EDGE_SCORE * edgeCount;
    const supportedMinutiaScore = Parameters.SUPPORTED_MINUTIA_SCORE * supportedMinutiaCount;
    const minutiaTypeScore = Parameters.MINUTIA_TYPE_SCORE * minutiaTypeHits;
    const innerDistanceRadius = Math.round(Parameters.DISTANCE_ERROR_FLATNESS * Parameters.MAX_DISTANCE_ERROR);
    const innerAngleRadius = fround(Parameters.ANGLE_ERROR_FLATNESS * Parameters.MAX_ANGLE_ERROR);
    let distanceErrorSum = 0;
    let angleErrorSum = 0; // Java float field — fround after every accumulation
    for (let i = 1; i < pairing.count; ++i) {
      const pair = pairing.tree[i] as MinutiaPair;
      const probeEdge = new EdgeShape(pminutiae[pair.probeRef], pminutiae[pair.probe]);
      const candidateEdge = new EdgeShape(cminutiae[pair.candidateRef], cminutiae[pair.candidate]);
      distanceErrorSum += Math.max(innerDistanceRadius, Math.abs(probeEdge.length - candidateEdge.length));
      angleErrorSum = fround(
        angleErrorSum + Math.max(innerAngleRadius, FloatAngle.distance(probeEdge.referenceAngle, candidateEdge.referenceAngle)),
      );
      angleErrorSum = fround(
        angleErrorSum + Math.max(innerAngleRadius, FloatAngle.distance(probeEdge.neighborAngle, candidateEdge.neighborAngle)),
      );
    }
    const distanceErrorPotential = Parameters.MAX_DISTANCE_ERROR * Math.max(0, pairing.count - 1);
    const distanceAccuracySum = distanceErrorPotential - distanceErrorSum;
    const distanceAccuracyScore =
      Parameters.DISTANCE_ACCURACY_SCORE * (distanceErrorPotential > 0 ? distanceAccuracySum / distanceErrorPotential : 0);
    const angleErrorPotential = fround(fround(Parameters.MAX_ANGLE_ERROR * Math.max(0, pairing.count - 1)) * 2);
    const angleAccuracySum = fround(angleErrorPotential - angleErrorSum);
    const angleAccuracyScore =
      Parameters.ANGLE_ACCURACY_SCORE * (angleErrorPotential > 0 ? fround(angleAccuracySum / angleErrorPotential) : 0);
    const totalScore =
      minutiaScore +
      minutiaFractionScore +
      supportedMinutiaScore +
      edgeScore +
      minutiaTypeScore +
      distanceAccuracyScore +
      angleAccuracyScore;
    return Scoring.shape(totalScore);
  },
  shape(raw: number): number {
    const P = Parameters;
    if (raw < P.THRESHOLD_FMR_MAX) return 0;
    if (raw < P.THRESHOLD_FMR_2) return Scoring.interpolate(raw, P.THRESHOLD_FMR_MAX, P.THRESHOLD_FMR_2, 0, 3);
    if (raw < P.THRESHOLD_FMR_10) return Scoring.interpolate(raw, P.THRESHOLD_FMR_2, P.THRESHOLD_FMR_10, 3, 7);
    if (raw < P.THRESHOLD_FMR_100) return Scoring.interpolate(raw, P.THRESHOLD_FMR_10, P.THRESHOLD_FMR_100, 10, 10);
    if (raw < P.THRESHOLD_FMR_1000) return Scoring.interpolate(raw, P.THRESHOLD_FMR_100, P.THRESHOLD_FMR_1000, 20, 10);
    if (raw < P.THRESHOLD_FMR_10_000) return Scoring.interpolate(raw, P.THRESHOLD_FMR_1000, P.THRESHOLD_FMR_10_000, 30, 10);
    if (raw < P.THRESHOLD_FMR_100_000) return Scoring.interpolate(raw, P.THRESHOLD_FMR_10_000, P.THRESHOLD_FMR_100_000, 40, 10);
    return ((raw - P.THRESHOLD_FMR_100_000) / (P.THRESHOLD_FMR_100_000 - P.THRESHOLD_FMR_100)) * 30 + 50;
  },
  interpolate(raw: number, min: number, max: number, start: number, length: number): number {
    return ((raw - min) / (max - min)) * length + start;
  },
};

// Java keeps this state in a ThreadLocal; Node is single-threaded per worker,
// so one module-level instance is the exact equivalent.
const thread = {
  roots: new RootList(),
  pairing: new PairingGraph(),
  queue: new JavaPriorityQueue<MinutiaPair>((a, b) => a.distance - b.distance),
};

export const MatcherEngine = {
  match(probe: Probe, candidate: SearchTemplate): number {
    thread.pairing.reserveProbe(probe);
    thread.pairing.reserveCandidate(candidate);
    RootEnumerator.enumerate(probe, candidate, thread.roots);
    let high = 0;
    let best = -1;
    for (let i = 0; i < thread.roots.count; ++i) {
      EdgeSpider.crawl(probe.template.edges, candidate.edges, thread.pairing, thread.roots.pairs[i], thread.queue);
      const partial = Scoring.compute(probe.template, candidate, thread.pairing);
      if (best < 0 || partial > high) {
        high = partial;
        best = i;
      }
      thread.pairing.clear();
    }
    thread.roots.discard();
    return high;
  },
};
