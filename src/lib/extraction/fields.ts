import type { Confidence, Field } from "./types";
import type { Resolved } from "./strategies";

/** Shared helpers for building fields and choosing their confidence. */

export const missing = <T>(source = "missing"): Field<T> => ({ value: null, confidence: "low", source });

export interface ConfidenceInput {
  knownLayout: boolean;
  /** The field took part in a cross-check that passed (totals reconcile, rate plausible, dates in order, …) */
  checked: boolean;
  /** A cross-check involving the field failed */
  failed?: boolean;
  /** Cap for free-text fields with no cross-check, e.g. a client name */
  max?: Confidence;
}

const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const cap = (c: Confidence, max: Confidence = "high"): Confidence => (rank[c] > rank[max] ? max : c);

/**
 * high: a known layout and a passed cross-check, with no strategy disagreeing;
 * medium: read at a label (or by the sequential reader) without conflict;
 * low: a value-shape guess with no label, a weak synonym's guess that failed a check, or a failed cross-check.
 */
export function confidenceOf<T>(r: Resolved<T>, c: ConfidenceInput): Confidence {
  if (r.value === null || r.patternOnly || c.failed) return "low";
  const disagreed = r.distinct.length > 1;
  if (c.knownLayout && c.checked && !disagreed && !r.weakOnly) return cap("high", c.max);
  return cap("medium", c.max);
}

/** A field from a resolution. `unreadableLabel` marks "label found, value not readable" (the wrappers map it to NaN). */
export function toField<T>(r: Resolved<T>, confidence: Confidence, unreadableLabel?: string): Field<T> {
  if (r.value !== null) return { value: r.value, confidence, source: r.source };
  if (r.conflict) return { value: null, confidence: "low", source: r.source };
  return { value: null, confidence: "low", source: unreadableLabel ? `unreadable:${unreadableLabel}` : "missing" };
}

/** True when a null field's label was on the page (unreadable or conflicting), as opposed to absent. */
export const labelWasFound = (f: Field<unknown>) => f.value === null && /^(?:unreadable|conflict):/.test(f.source);

export const near = (a: number, b: number) => Math.abs(a - b) <= 0.01;
