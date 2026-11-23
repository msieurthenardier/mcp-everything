import { oneLine } from "../util/text.js";

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Own-property read, so `__proto__` and friends are never inherited values. */
export function own(o: Record<string, unknown>, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

/** Slice before cleaning so hostile megabyte strings cost nothing, then clean to one line and cap. */
export function clean(text: string, max: number): string {
  return oneLine(text.slice(0, max * 4), max);
}
