# Leg: proxy-program

**Status**: completed
**Flight**: [Contained Network and Isolation Runtime](../flight.md)

## Objective
Write the egress proxy that every contained sandbox, clone and networked scanner will go through, as one self-contained CommonJS file that mcp-everything will run with `node -e` in a container. This leg ships and tests the program with no Docker and no caller. The program must:
- enforce the allowlist;
- classify every address it would connect to, refusing local ones;
- connect only to checked literal addresses;
- handle exactly one request per client connection;
- carry the operator's TCP forwards;
- keep a bounded refusal list in fixed vocabulary;
- report its status on loopback.

## Context
- **The specification.**
  - **Flight DD4** is the specification: what the proxy does, where it listens, name resolution, IP literals, refused ranges, matching, and hostile input.
  - Also: DD9 (refusals), DD10 (forwards, `/etc/hosts` for `host.docker.internal`), DD2 (the labels hash the program's version) and DD12 (scanner entries may be local).
  - Trials T4, T5 and T11–T13.
- **Leg 1** (`network-config`, landed):
  - `src/network/hosts.ts` exports `HostEntry` (`{ host, wildcard, ports, literal }`, with `host` lower-case ASCII, no trailing dot, IPv6 literals **bracketed**) and `PROXY_PORT = 3128`.
  - Agent entries are names only. Scanner entries may be IP literals. Local-access targets are names.
  - The proxy does not import leg 1's TypeScript, because it must be self-contained. It receives normalized entries in its JSON configuration, which this leg's TypeScript builder makes, and re-validates them.
- **This is the hostile-input leg** (flight 1 debrief). Everything the proxy reads comes from the project's code.
- **Design review 1** was attack-minded (Developer, 2026-11-22, with experiments on Node v22.22.0, re-run by the Flight Director). It found that Node's HTTP server **fires a second `request` or a `connect` event for pipelined input on the same socket even after `Connection: close`**: `GET … \r\n\r\nCONNECT b.com:443` in one write gave a 200 and then a `connect` event for `b.com:443`. Its other findings are folded in below: the authority grammar, embedded-address classes, the IPv6 table, handshake deadlines, injection through refusal text, upstream crashes, hop-by-hop headers, and the test hooks.
- **Decisions taken at this leg's design** (Flight Director, 2026-11-22; recorded in the flight log):
  1. **Plain HTTP is GET and HEAD only.** Debian's `apt` needs no more, and request bodies over plain HTTP are not needed by any recipe.
  2. **The test hooks are not in the shipped program.** The child-process test passes its own `deps` by appending JavaScript after the file's text.
  3. **An uncaught exception fails closed.** The proxy logs one line to stderr and exits non-zero. Leg 5's repair restarts it, and while it is down the sandbox has no way out.
  4. **`Via` and `X-Forwarded-*` are stripped, and none are added.**
  5. **On native Linux, `host-gateway` is the bridge gateway**, which is inside the proxy's own `bridge` CIDR. So a forward may reach **exactly** the addresses `/etc/hosts` gives for the name `host.docker.internal`, even inside `ownCidrs`, and nothing else in `ownCidrs`. Leg 4 measures it on native Linux.
- **Delivery** (decided at design; Flight Director trial on 2026-11-22):
  - **Source**: `src/network/proxy/proxy.cjs` is plain JavaScript, `// @ts-check` with JSDoc. Under `strict` every parameter needs a type: the review saw `tsc` fail with TS7006 on an unannotated one.
  - **Build**: `tsconfig.json` gains `"allowJs": true`. There are no other `.js`, `.cjs` or `.mjs` files under `src` or `test`. `tsc` emits `dist/network/proxy/proxy.cjs`, prepending `"use strict";` (so the source starts with it already) and appending `//# sourceMappingURL=…`, which `proxySource()` strips.
  - **Runtime**: leg 4 runs `node -e "<text>\n;main(JSON.parse(process.argv[1]))" '<config>'`. Linux limits one argument to 128 KiB, so the shipped text stays under 96 KiB. Windows command lines are shorter; the project targets Linux, which the README already says.
- **Node's own HTTP parser** (llhttp) parses requests, with its limits set; there is no hand-written HTTP parsing. The *authority* (host and port) is parsed by the program's own strict grammar, because Node passes `req.url` through unchanged (review: `0x7f.1:443`, `a@b:443`, `[fe80::1%eth0]:443` all reach the handler).
- No caller yet. Leg 4 runs it in containers, leg 5 makes project proxies, and leg 7 reads refusals.

## Inputs
- Flight DD4, DD9, DD10, DD12; trials T4, T5, T11–T13.
- `src/network/hosts.ts` (leg 1).
- `tsconfig.json`; `.github/workflows/ci.yml` (its pack check).

## Outputs
- `src/network/proxy/proxy.cjs` (new): the program.
- `src/network/proxy/config.ts` (new): the configuration's type, `PROXY_PROGRAM_VERSION`, `proxySource()`, and the builder from leg 1's entries. Nothing calls them yet.
- `tsconfig.json`: `"allowJs": true`.
- `.github/workflows/ci.yml`: the pack check also requires `dist/network/proxy/proxy.cjs`.
- `test/proxy-rules.test.ts`, `test/proxy-server.test.ts` (new).

## Acceptance Criteria

**Configuration** (one JSON object; the program validates it at start, and any invalid field exits non-zero with a one-line reason on stderr):
- [ ] **Fields**:
  - `version`, `listenCidr` (IPv4 CIDR), `port`, `controlPort`;
  - `allow`: `{ host, wildcard, ports, literal, local }`, where `host` is a lower-case name or a canonical IP literal without brackets;
  - `forwards`: `{ host, port }`;
  - `resolvers`;
  - `limits`.
- [ ] **No test-only fields exist.** Unknown fields are refused.
- [ ] **Resolvers** must be a non-empty list of IP literals without `%`. `127.0.0.11` (Docker's embedded DNS, alias-poisoned per T11 and T12) and any loopback resolver are refused.
- [ ] **Ports** are 1–65535. A forward on `port` or `controlPort` is refused, and so are two forwards on one port.
- [ ] **The builder** `proxyConfig(...)` in `config.ts`:
  - converts leg 1's `HostEntry` values, unbracketing and canonicalizing IPv6;
  - sets `local: true` **only** for entries from a scanner's `hosts` (DD12);
  - emits keys in sorted order.

  It is unit-tested.

**Authority grammar** (pure exported `parseAuthority(text)`, used for CONNECT targets, absolute-URI authorities and nothing else):
- [ ] **Accepts** only `host:port`, `[ipv6]:port`, and for plain HTTP also `host` or `[ipv6]` with an implied 80.
- [ ] **Port**: must match `^[1-9][0-9]{0,4}$` and be at most 65535. `Number()` is never used on unchecked text: it accepts `4e2`, `+443` and `0x1bb`.
- [ ] **A bracketed IPv6 literal** goes through the program's own IPv6 parser, which refuses `%`, `/`, `@`, `\`, whitespace and non-ASCII.
- [ ] **An unbracketed host** is either a strict dotted-decimal IPv4 with no leading zeros, or a name of `[a-z0-9-]` labels (1–63 characters, not starting or ending with `-`, at most 253 in all, after lower-casing and removing one trailing dot) whose last label does not end in a number (`^[0-9]+$` or `^0x[0-9a-f]*$`).
- [ ] **Anything else is `400`** and is never resolved. That includes `0x7f.1`, `127.1`, `2130706433`, `a@b`, `a%2eb`, `evil.com:443/x`, `*:1`, `[::1]` without a port on CONNECT, `foo` without a port on CONNECT, `a.com:0443`, `a.com:+443`, `[fe80::1%eth0]:443` and a non-ASCII host.
- [ ] **A table test** covers every spelling named in this leg.

**Address classes** (pure exported `classify(address, ownCidrs) → "never" | "local" | "public"`; the worst class wins when embeddings nest):
- [ ] **IPv4.**
  - `never`: `0/8`, `127/8`, `169.254/16`, `224/4`, `240/4`, `255.255.255.255`, `100.100.100.200` (a cloud metadata address), and every `ownCidrs` subnet.
  - `local`: `10/8`, `100.64/10`, `172.16/12`, `192.0.0/24`, `192.88.99/24`, `192.168/16`, `198.18/15`.
  - `public`: everything else. **TEST-NET (`192.0.2/24`, `198.51.100/24`, `203.0.113/24`) is deliberately public**: the tests use `203.0.113.x` as public addresses. A comment says so, so nobody "fixes" it.
- [ ] **IPv6 is an allowlist.**
  - `never`: `::`, `::1`, `::/96` (IPv4-compatible), `fe80::/10`, `ff00::/8`, `fd00:ec2::254` (a cloud metadata address), and `ownCidrs`.
  - **Judged by the embedded IPv4**, taking the worse of the embedded class and `local`:
    - `::ffff:0:0/96` (mapped) and `::ffff:0:0:0/96` (SIIT);
    - `64:ff9b::/96` (NAT64);
    - `2002::/16`, from bits 16–47;
    - Teredo `2001::/32`: the client is the last 32 bits XOR `0xffffffff`, and the server is bits 32–63. Both are judged.
  - `local`: `fc00::/7`, `fec0::/10`, `64:ff9b:1::/48` (not decoded), `100::/64`, `2001:db8::/32`, `2001::/23` (other than Teredo), and **everything outside `2000::/3`**.
  - `public`: the rest of `2000::/3`.
- [ ] **Precedence** (design review 2): `ownCidrs` is checked first, for IPv4, for IPv6 and for an embedded IPv4. Then `never` beats `local`, which beats `public`. That is how `100.100.100.200` (in `100.64/10`), `fd00:ec2::254` (in `fc00::/7`) and `255.255.255.255` (in `240/4`) end up `never`; each is tested.
  - 6to4 and Teredo addresses are never `public` (the worse of the embedded class and `local`). Tests that need a public IPv6 use addresses such as `2606:4700::1111` or `2001:4860:4860::8888`.
- [ ] **Canonical IPv6 text** is lower-case, compresses the longest run of zero groups (the first on a tie, and only runs of two or more), and has no dotted tail. That is the form `new URL("http://[…]").hostname` gives, minus brackets, and leg 1 stores it.
  - The program's parser accepts a dotted IPv4 tail only under the strict IPv4 rules (no leading zeros) and converts it to hex.
  - A test cross-checks the program's canonicalizer against `new URL` over a corpus of at least 50 spellings.
- [ ] **Unparseable input is `never`.** The parser is the program's own, with no regex shortcut and no zone ids.
- [ ] **`ownCidrs`** comes from `os.networkInterfaces()`, **re-read for each connection** (interfaces can be added after start, when leg 4 connects the second network). It is sorted.

**Matching** (pure exported `matchEntry(entries, host, port)`):
- [ ] Applies to a host that passed `parseAuthority`. `*.example.com` matches `a.example.com` and `a.b.example.com`, not `example.com` or `badexample.com`. The port must be in `ports`.
- [ ] **An IP literal matches only an entry with `literal: true` and the same canonical address.** A name never matches a literal entry, and a literal never matches a name entry.

**Which addresses may be used:**
- [ ] **An ordinary entry** may use only `public` addresses.
- [ ] **A `local: true` entry** may use `public` and `local`, never `never`.
- [ ] **A forward** may use `public` and `local`, never `never`, with one exception (decision 5), scoped precisely (design review 2). An address may be used even though it falls in `ownCidrs` only when **all** of these hold:
  - the forward's target name is exactly `host.docker.internal`;
  - the address came from `/etc/hosts`, not the resolvers;
  - `classify(address, [])`, without the proxy's own subnets, is not `never`;
  - the address is not one of the proxy's own interface addresses.

  An `/etc/hosts` line naming both `db.lan` and `host.docker.internal` does not exempt a forward whose target is `db.lan`.
- [ ] **`forwards.host`** is a name under leg 1's grammar, validated at start. Names do not allow `_`, consistently with leg 1, and a comment says so, so nobody "fixes" it.
- [ ] **Tests**:
  - every embedding of `127.0.0.1` and `169.254.169.254` (mapped, SIIT, NAT64, 6to4, Teredo client and server) is refused for an ordinary entry, a `local` entry and a forward;
  - a forward to `127.0.0.1` is refused, and so is one to `localhost` and to the container's own hostname (both from `/etc/hosts`);
  - the `host.docker.internal` exemption works for an `ownCidrs` address, and refuses `127.0.0.1` and `::ffff:127.0.0.1` given under that name;
  - it does not apply to `db.lan` on the same `/etc/hosts` line, nor to a resolver answer.

**One request per client connection:**
- [ ] **On the first `request` or `connect` event**, the socket is marked (a `WeakSet`). **Any later `request`, `connect` or `upgrade` event on a marked socket destroys it with no processing and no response.**
- [ ] `server.keepAliveTimeout = 0`.
- [ ] **An `upgrade` listener** is registered that destroys the socket at once. The review measured that without one, an upgrade request stays open until the timeout.
- [ ] **Tests**, each in one write, through a real client socket: GET then GET, GET then CONNECT, CONNECT then GET, CONNECT then CONNECT, and **a refused first request (`403`) then a pipelined second**. Only the first is processed, and the second never reaches the resolver or `connect`. After a CONNECT, the trailing bytes arrive in `head` and go only to the already-allowed target.

**CONNECT:**
- [ ] **A whole-handshake deadline** of 15 s by default, covering resolve, connect and the 200. It is a `setTimeout` **timer** started at the event, not `socket.setTimeout` (an idle timer that client bytes would reset). It is cleared at the `200`, which switches to the tunnel idle timeout.
  - Each address attempt has its own 5 s cap, and at most 4 addresses are tried.
  - Tunnels are not bounded by `requestTimeout`; measured in review 2. The idle timeout is their bound, and a test keeps a tunnel open past a small `requestTimeout`.
- [ ] **Steps**:
  1. `parseAuthority`, then `matchEntry`; else `403`.
  2. Resolve, unless the host is a literal: `dns.Resolver` with `setServers(config.resolvers)`, `resolve4` and `resolve6` in parallel. There is **no cache**, on purpose: a cache would reopen check-then-use races. A comment says so.
  3. Keep the addresses the entry may use; if none, `403` "resolves only to refused addresses".
  4. Connect to each kept address in order with `net.connect({ host: <literal>, port, family, autoSelectFamily: false })`, never passing a `lookup`.
  5. On success, answer `200`, write `head` upstream, and pipe both ways.
  6. Failures: `502` (resolution or connect failure), `504` (deadline).
- [ ] **Tunnels** have an idle timeout (default 15 minutes) and TCP keepalive on both sockets.
- [ ] **A test replaces `connect`** and asserts that every address it ever receives satisfies `net.isIP(address) !== 0`.

**Plain HTTP:**
- [ ] **Only `GET` and `HEAD` with an absolute `http://` URI.** The scheme is compared case-insensitively. Everything else gets `400` or `405`: origin-form, `https:`, other schemes, `//host`, `*`, and any method other than GET and HEAD.
- [ ] **A request with a body is refused**: `Content-Length` must be absent or match `^0+$` (no `Number()`), and **any** `Transfer-Encoding` header is refused, checked in the `request` handler, not left to `clientError`. Review 2 measured `Transfer-Encoding: identity` and `\tchunked` reaching the handler.
- [ ] **The path**: `http://a.com` becomes `/`, and `http://a.com?x` becomes `/?x`.
- [ ] **The destination** is `parseAuthority` of the URI's authority (the text after `http://` up to `/`, `?` or the end), never `Host`. The outgoing `Host` is set from it, and a default `:80` is dropped.
- [ ] **Removed from the request**: every header named in `Connection`, and `Connection`, `Keep-Alive`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`, `Expect`, `Via`, `Forwarded`, `X-Forwarded-*` and every `Proxy-*`. Nothing is added except `Host` and `Connection: close`.
- [ ] **The response**: hop-by-hop headers are removed the same way, and `Connection: close` is set. Redirects are passed to the client, never followed.
  - **Only the status code** is relayed, never the upstream `statusMessage`.
  - An upstream `101`, or a client-request `upgrade` event, destroys both sockets.
  - The upstream response has an idle timeout (default 60 s), so a slow upstream cannot hold a connection slot.
  - A `clientError` after a response has started destroys only; it writes no `400`.
- [ ] **The outgoing request** uses the resolved literal (`http.request({ host: <literal>, setHost: false, … })`), with `maxHeaderSize` on the response.
- [ ] **Every request, response and socket has an `error` handler.** Relaying is wrapped so that a malformed upstream response (for example a header with `\x01`, which makes Node's client emit `HPE_INVALID_HEADER_TOKEN`) ends in `502` or a closed socket, never an exception. Test with a hostile stub upstream.

**TCP forwards** (DD10):
- [ ] **Listeners**: one per forward port, on the bind address, with the same handshake deadline for resolve and connect.
- [ ] **The target** is resolved first from `/etc/hosts`, read at connection time:
  - CRLF and tabs are handled, and `#` comments stripped;
  - zone ids are refused;
  - every line whose name fields (the second onward) contain the target exactly (case-insensitive) counts;
  - otherwise, the resolvers are used.
- [ ] **Allowed addresses**: those the "which addresses" rules allow for a forward.
- [ ] **The exemption is scoped to the listener.** A `CONNECT db.lan:6379` through the proxy port is refused unless the allowlist itself allows it. Unit case.

**Bounds and resilience:**
- [ ] **Parser limits**: `maxHeaderSize` 16 KiB, `server.maxHeadersCount` 100, `headersTimeout` 10 s, `requestTimeout` 30 s, `connectionsCheckingInterval` 1 s.
- [ ] **One connection cap for the proxy port and every forward port combined** (default 256). Over it, new connections are destroyed at once. The control endpoint does not count.
- [ ] **Handler exceptions**: every event handler (`request`, `connect`, `upgrade`, `clientError`, and each forward's `connection`) is wrapped in a try/catch that destroys only that connection's sockets.
- [ ] **Uncaught exceptions**, the last resort: `process.on("uncaughtException")` writes one cleaned line to stderr and exits with code 70 (decision 3). A child-process test triggers it through a `deps` hook and asserts code 70.

**Refusals and status** (DD9):
- [ ] **The refusal list is aggregated** so that a sandbox cannot flush evidence with spam (design review 2). It holds at most 50 rows keyed by `(kind, host, port, reason)`, each `{ kind, host, port, reason, count, firstAt, lastAt }`. When full, the least recently seen row is evicted. All `<malformed>` refusals share one row per kind, and so do all `cap` refusals. `/status` also carries a monotonic `total`.
  - `kind` is `connect`, `http` or `forward`.
  - `reason` is a **fixed code**: `not-allowed`, `refused-address`, `no-address`, `resolve-failed`, `connect-failed`, `timeout`, `bad-request`, `method`, `cap`.
  - `host` is recorded **only if it passed `parseAuthority`**; otherwise `"<malformed>"`. For `cap`, and for a `bad-request` or `method` refusal without a parsed host, `host` and `port` are `null`.
  - A valid host name is still sandbox-chosen text, up to 253 characters. Leg 7 renders refusal hosts as quoted data. This residual is accepted.
- [ ] **`GET /status`** on `127.0.0.1:<controlPort>` returns JSON `{ version, startedAt, configHash, refusals, resolverFailures }`.
  - `configHash` is a SHA-256 of the configuration serialized with sorted keys.
  - `resolverFailures` counts consecutive failed resolutions, where both families failed. It is reset by any success.
  - Any other method or path, or a request with a body, gets `405` or `404`.
  - Tests: `CONNECT 127.0.0.1:<controlPort>` and `CONNECT localhost:<controlPort>` through the proxy port are refused.

**Delivery:**
- [ ] **Self-contained**:
  - the file starts with `"use strict";` and `require`s only `node:` built-ins (a test asserts this);
  - it exports its pure functions and `main(config, deps?)` through `module.exports`;
  - it starts nothing when required.
- [ ] **Injection for tests** is only through `deps`: `resolve`, `connect`, `interfaces`, `readHosts`, and a `fault` hook for the exit-70 test. It is an **optional seam, never filled in production**: production calls `main(config)` with one argument, and leg 4's launch text is tested to have no second argument. Tests use `127.0.0.0/8` as `listenCidr` only together with `deps.interfaces`; there is no configuration flag for it.
- [ ] **The child-process test** runs `node -e "<proxySource()>\n;main(JSON.parse(process.argv[1]), <test deps written as JavaScript in the test>)" '<config>'` with `listenCidr: "127.0.0.0/8"` and loopback stubs. It checks that:
  - an allowed CONNECT is tunnelled;
  - a disallowed one gets `403`;
  - the pipelined second request is dropped;
  - `/status` answers.
- [ ] **`proxySource()`** reads `new URL("./proxy.cjs", import.meta.url)` and strips a trailing `//# sourceMappingURL=` line. It works from `src` (vitest) and `dist` (built).
- [ ] **Size**: under 96 KiB, asserted on the final `-e` text including the appended `main(…)` line, and on `dist/network/proxy/proxy.cjs` when it exists.
- [ ] **Build**: `npm run build` emits `dist/network/proxy/proxy.cjs`, and the CI pack check asserts it is packed.
- [ ] **Versioning**: `PROXY_PROGRAM_VERSION` in `config.ts` equals the program's own version constant (test).

**Nothing else changes**:
- [ ] No module outside `src/network/` imports the new code.
- [ ] `npm run typecheck`, `npm run build` and `npm test` pass, and the existing test count does not drop.

## Verification Steps
- `npx vitest run test/proxy-rules.test.ts test/proxy-server.test.ts`:
  - the authority table;
  - classification, with every boundary on both sides and every embedding;
  - matching;
  - in-process servers driven through **real client sockets** (`net.connect`, `http.get` through the proxy), so Node's parser is in the loop;
  - the child-process smoke test.
- `npm run typecheck`, `npm run build`, `ls dist/network/proxy/proxy.cjs`, `npm test` (counts into the flight log).
- **Trials**. Weaken the source, confirm a test fails, and restore by editing (never git):
  - the Teredo decoding;
  - the literal-only `connect`;
  - the scoped forward exemption;
  - the single-use socket guard;
  - the `parseAuthority` refusal of `0x7f.1`.

## Implementation Guidance
1. **Pure core first.** IPv4 and IPv6 parsing and expansion, `classify`, `parseAuthority`, `matchEntry`, configuration validation, and `/etc/hosts` parsing. Table-test them before any server code.
2. **Then the servers.** The proxy port (`http.createServer` with the limits; `request`, `connect`, `upgrade` and `clientError` handlers; the single-use `WeakSet`), the forward listeners (`net.createServer`), the control endpoint, and the shared connection counter.
3. **`main(config, deps)`** validates, finds the bind address and starts the servers. Finding the bind address retries every 500 ms for up to 10 s if no interface is yet in `listenCidr`, then exits non-zero naming the CIDR. Leg 4 connects the networks before starting the program, and this covers the race.
4. **Child-process test.** The test builds the `-e` text from `proxySource()`, plus a line calling `main` with a `deps` object literal whose `resolve` and `connect` map test names to loopback stubs. No environment variable or configuration field enables test behavior.
5. **`config.ts`**: `proxySource()`, `PROXY_PROGRAM_VERSION`, the types, and `proxyConfig(...)`.
6. **CI**: extend the pack-check step's inline script to also require `dist/network/proxy/proxy.cjs`, keeping its quoting style.

## Edge Cases
- **A name resolving to public and refused addresses** (rebinding, split answers): the refused ones are dropped and the public one used. A name resolving only to refused ones gets `403`. Both are tested.
- **CONNECT with a body (`Content-Length`)**: Node puts the bytes in `head`. They are written upstream only after the `200`, and only if the target was allowed.
- **HTTP/1.0 absolute-URI GET with no `Host`**: works, because the destination is the URI.
- **Duplicate or hostile `Host` headers**: ignored for routing.
- **A forward whose `/etc/hosts` has a malformed line**: the line is skipped.
- **One resolver family fails (SERVFAIL) while the other answers**: the answer is used and `resolverFailures` resets.
- **A client that resets during the `head` write, or half-closes**: both sockets are destroyed, with no unhandled `error`.
- **Many concurrent tunnels at the cap**: the 257th connection on any listener is destroyed; the control endpoint still answers.
- **Residual routes, which leg 9's README lists**:
  - **A wildcard entry lets the sandbox cause lookups of arbitrary labels** under it (DNS exfiltration). This is inherent.
  - **Azure's `168.63.129.16`**: public-looking, not coverable by a table.
  - **IPv6 forms not decoded**: ISATAP interface identifiers (`…:5efe:a.b.c.d`) in a public prefix, and nonstandard NAT64 prefixes. Both are only reachable where such a translator sits on the path.

## Files Affected
- `src/network/proxy/proxy.cjs`, `src/network/proxy/config.ts`: new.
- `tsconfig.json`: `allowJs`.
- `.github/workflows/ci.yml`: pack-check assertion.
- `test/proxy-rules.test.ts`, `test/proxy-server.test.ts`: new.

## Citation Audit
Checked on 2026-11-22:
- `tsconfig.json`: no `allowJs`; `include: ["src", "test"]`. No `.js`, `.cjs` or `.mjs` files under `src` or `test` (design review, `find`).
- `.github/workflows/ci.yml`: the "Pack check" step asserts `dist/index.js` is packed.
- `src/network/hosts.ts` (leg 1, landed): `HostEntry`, `PROXY_PORT`, and bracketed IPv6 in `host`.
- Pipelining behavior re-run by the Flight Director from the review's `t3.js` (scratchpad). It printed `CONNECT event b.com:443` after a GET on one socket, and an upgrade request stayed open until the request timeout.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
