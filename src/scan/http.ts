/**
 * Bounded HTTP for the dependency check: an injected `fetch`, no redirect followed, a per-request timeout combined
 * with the caller's signal, and a body read as a stream and refused (not truncated) past a byte cap. A failure is an
 * `HttpFailure` with a fixed `kind`; it never carries response content or the underlying exception's text.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type HttpFailureKind = "redirect" | "timeout" | "aborted" | "cap" | "network";

export class HttpFailure extends Error {
  constructor(readonly kind: HttpFailureKind) {
    super(kind);
    this.name = "HttpFailure";
  }
}

export interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
}

export interface HttpOptions {
  headers?: Record<string, string>;
  /** The most bytes of body read; more is a `cap` failure. */
  capBytes: number;
  /** Per-request timeout (default 15 s). */
  timeoutMs?: number;
  /** The caller's signal (the deadline and the clone's failure). */
  signal?: AbortSignal;
  /** Called immediately before the request is sent, and not at all when the signal was already aborted. */
  onSend?: () => void;
}

export const REQUEST_TIMEOUT_MS = 15_000;

async function request(fetchImpl: FetchLike, url: string, method: "GET" | "POST", body: string | undefined, opts: HttpOptions): Promise<HttpResult> {
  const outer = opts.signal;
  if (outer?.aborted) throw new HttpFailure("aborted");
  const timer = AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = outer ? AbortSignal.any([timer, outer]) : timer;
  try {
    opts.onSend?.();
    const res = await fetchImpl(url, { method, headers: opts.headers, body, redirect: "error", signal });
    const text = await readCapped(res, opts.capBytes);
    return { status: res.status, headers: res.headers, text };
  } catch (e) {
    if (e instanceof HttpFailure) throw e;
    // Which source aborted is read from the signals, not from the error's name.
    if (outer?.aborted) throw new HttpFailure("aborted");
    if (timer.aborted) throw new HttpFailure("timeout");
    const cause = e instanceof Error ? (e as Error & { cause?: unknown }).cause : undefined;
    const message = cause instanceof Error ? cause.message : undefined;
    if (message === "unexpected redirect") throw new HttpFailure("redirect");
    throw new HttpFailure("network");
  }
}

async function readCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new HttpFailure("cap");
    }
    chunks.push(value);
  }
  const decoder = new TextDecoder();
  let out = "";
  for (const c of chunks) out += decoder.decode(c, { stream: true });
  return out + decoder.decode();
}

export function getCapped(fetchImpl: FetchLike, url: string, opts: HttpOptions): Promise<HttpResult> {
  return request(fetchImpl, url, "GET", undefined, opts);
}

export function postCapped(fetchImpl: FetchLike, url: string, body: string, opts: HttpOptions): Promise<HttpResult> {
  return request(fetchImpl, url, "POST", body, opts);
}
