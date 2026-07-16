/*
 * nodeAFIS — pure-TypeScript port of the SourceAFIS 3.18.1 fingerprint matcher.
 * Java reference implementation: https://github.com/robertvazan/sourceafis-java (Apache-2.0).
 * Phase 1 scope: template deserialization (.tpl CBOR) + 1:N matching.
 * Extraction (image → template) is not ported yet — use the Java sidecar or fjfx for enrollment.
 */

import { extractFeatures } from './extractor';
import { FingerprintImage } from './image';
import { EdgeHashes, MatcherEngine, Probe } from './matcher';
import { SearchTemplate } from './templates';

export { FingerprintImage };

export class FingerprintTemplate {
  /** @internal */
  readonly inner: SearchTemplate;

  /** Deserializes a CBOR template produced by SourceAFIS `FingerprintTemplate.toByteArray()`. */
  constructor(serialized: Uint8Array) {
    if (!(serialized instanceof Uint8Array)) throw new TypeError('serialized template must be a Uint8Array/Buffer');
    this.inner = SearchTemplate.fromByteArray(serialized);
  }

  private static wrap(inner: SearchTemplate): FingerprintTemplate {
    return Object.create(FingerprintTemplate.prototype, { inner: { value: inner } }) as FingerprintTemplate;
  }

  /** Extracts a template from a fingerprint image (Java `new FingerprintTemplate(FingerprintImage)`). */
  static fromImage(image: FingerprintImage): FingerprintTemplate {
    const features = extractFeatures(image.matrix, image.dpi);
    return FingerprintTemplate.wrap(new SearchTemplate(features.width, features.height, features.minutiae));
  }

  static empty(): FingerprintTemplate {
    return FingerprintTemplate.wrap(SearchTemplate.EMPTY);
  }

  /** Serializes back to SourceAFIS-compatible CBOR (readable by the Java 3.18.x implementation). */
  toByteArray(): Uint8Array {
    return this.inner.toByteArray();
  }
}

export class FingerprintMatcher {
  private readonly probe: Probe;

  constructor(probe: FingerprintTemplate) {
    if (!probe) throw new TypeError('probe is required');
    this.probe = new Probe(probe.inner, EdgeHashes.build(probe.inner));
  }

  /**
   * Similarity score, identical to SourceAFIS Java. Threshold 40 ≈ FMR 0.01%.
   * Thread-note: safe to call repeatedly for 1:N; single-threaded per Node worker.
   */
  match(candidate: FingerprintTemplate): number {
    if (!candidate) throw new TypeError('candidate is required');
    return MatcherEngine.match(this.probe, candidate.inner);
  }
}
