# Leg: network-config

**Status**: completed
**Flight**: [Contained Network and Isolation Runtime](../flight.md)

## Objective
Parse and validate every new network setting: `MCPE_NETWORK`, `MCPE_LOCAL_ACCESS` and a scanner's `hosts`. Define the grammar of a host entry the agent may add, and the default host table per build system. All of it is pure and unit-tested, with no Docker and no caller yet.

## Context
- Flight DD1 (`MCPE_NETWORK`), DD5 (the default table), DD6 (the agent's host entries), DD10 (`MCPE_LOCAL_ACCESS`, by repository, port rules) and DD12 (scanner `hosts`, a startup error under containment).
- This is the first leg; there is no prior leg outcome. Nothing in this leg is called by the install path, the server or the Docker layer: later legs wire it in (legs 4–7). `Config` gains one field, which every config literal in the tests must then carry.
- Conventions to follow:
  - **Startup errors** are `ConfigError` (`src/errors.ts`) with a message naming the variable and the allowed form, never a silent fallback. See `parseScan` and `parseNamePrefix` in `src/config.ts`, and squawk 0015's rule.
  - **The scanners file's validation** is in `src/scan/scanners-file.ts`: unknown keys are refused, and every message names the file, the entry and the field.
  - **Repository identity**: `parseRepoRef(input, hosts)` in `src/forge/repo-ref.ts` gives a `RepoRef` whose `id` is `github:owner/name`, `gitlab:group/name` or `<host>:path`. `Registry.resolve` compares ids case-insensitively.
- **Two tightenings of the flight spec**, decided at this leg's design (to be recorded in the flight log's Decisions):
  1. **`MCPE_LOCAL_ACCESS` targets are host names, not IP literals.** A contained sandbox has no route to any address (T1). It reaches an operator's target only by a **name** that resolves, on its own network, to the proxy (DD10, T8). An IP literal such as `192.168.1.20:5432` could never be reached from the sandbox, so it is refused at startup with a message saying why.
     - Consequence for DD13: the Docker suite's "local service" cannot be "a container on `bridge`, named by its bridge address". Legs 5 and 7 will name it `host.docker.internal:<published port>`, a container on `bridge` with a published port.
  2. **The agent's `hosts` entries are names only.** An IP literal is refused by the grammar, whatever its range. This is stricter than DD4 and DD6, which allowed a public literal. It keeps the refused-range table entirely in leg 3 (`proxy-program`), and the agent loses nothing it needs.
     - Scanner `hosts` (the operator's file) may hold IP literals, local ones included (DD12).

## Inputs
- `src/config.ts`: `Config`, `loadConfig`, `parseHosts`, `parseScan`.
- `src/scan/scanners-file.ts`: `parseScannersFile`, with `KEYS` at the top.
- `src/scan/types.ts`: `ScannerSpec`.
- `src/forge/repo-ref.ts`: `parseRepoRef`.
- `src/types.ts`: `Ecosystem`, `RepoRef`.
- `test/config.test.ts` and `test/scan-scanners-file.test.ts`, the patterns for new cases.

## Outputs
- `src/network/hosts.ts` (new): the host-entry grammar.
- `src/network/defaults.ts` (new): the default host table and its version.
- `src/network/local-access.ts` (new): the `MCPE_LOCAL_ACCESS` parser and lookup.
- `src/config.ts`: `Config.network`; `MCPE_NETWORK`, `MCPE_LOCAL_ACCESS` and the cross-check of scanners under containment.
- `src/scan/scanners-file.ts`, `src/scan/types.ts`: scanner `hosts`.
- Tests: `test/network-hosts.test.ts`, `test/network-defaults.test.ts`, `test/network-local-access.test.ts` (new), plus cases added to `test/config.test.ts` and `test/scan-scanners-file.test.ts`.
  - Every test builds `Config` through `loadConfig`, so no `Config` literal changes (design review).
  - Hand-built `ScannerSpec` literals gain `hosts: []`:
    - `test/installer.test.ts:1922`, `:2150`;
    - `test/docker.test.ts:191`;
    - `test/scan-policy.test.ts:83`;
    - `test/scan-run.test.ts:13`;
    - `test/integration/docker.test.ts`, the `scanner()` helper near line 1148.
  - Whole-object assertions that gain `hosts: []`: `test/scan-scanners-file.test.ts:16` and `test/config.test.ts:139`.

## Acceptance Criteria
- [ ] **`MCPE_NETWORK`.**
  - Unset, empty, `open` (any case, trimmed) → `cfg.network.mode === "open"`.
  - `contained` → `"contained"`.
  - Anything else → `ConfigError` naming `MCPE_NETWORK` and both values.
- [ ] **Host-entry grammar** (`src/network/hosts.ts`).
  - **Signature**: `parseHostEntry(raw, mode)`, where `mode` is `"agent"`, `"local-access"` or `"scanner"`. It returns `{ host, wildcard, ports, literal }` or throws an `Error` with a reason. Every stored value is the normalized form, never the raw input.
  - **Order of checks** (design review: `domainToASCII` rewrites IPv4 shorthand into dotted quads, e.g. `127.1`, `0x7f.1` and `2130706433` all become `127.0.0.1`, while `net.isIP` of the raw input is 0):
    1. **Raw checks**, before any conversion. Refuse:
       - empty, longer than 300 characters;
       - any whitespace or control character, `@`, `/`, `\`, `%`, `?`, `#`;
       - a scheme (`://`).
    2. **Split off the port.**
       - A bracketed IPv6 is `[addr]` or `[addr]:port`. Otherwise the port is after the last `:`. A second `:` outside brackets (unbracketed IPv6) is refused.
       - The port must match `^[1-9][0-9]{0,4}$` and be at most 65535. So `:0`, `:65536`, `:080`, `:+80`, `:80.0`, `:0x50` and an empty `:` are refused.
       - **No port means `[443, 80]`. A named port means only that port**, so `name:443` is `[443]` and `name:80` is plain HTTP only.
    3. **IP literals.**
       - A bracketed host is an IPv6 literal. It is canonicalized with `new URL("http://[" + addr + "]").hostname`, so `[0:0:0:0:0:0:0:1]` becomes `[::1]`, and an IPv4-mapped form is accepted as written in canonical form, such as `[::ffff:7f00:1]`. A zone id (`%`) was already refused in step 1.
       - A dotted quad passing `net.isIP` is an IPv4 literal.
       - Literals are accepted only in `"scanner"` mode.
    4. **Names.**
       - If the input is ASCII, it must match `[A-Za-z0-9.*-]` and is lower-cased. It is converted with `url.domainToASCII` only if a label starts with `xn--` (after lower-casing), so `XN--A.COM` is refused like `xn--a.com`.
       - If it contains non-ASCII, it is converted with `url.domainToASCII`.
       - An empty conversion result is refused (`xn--a.com`, `xn--zz.com`, `XN--A.COM`). The converted form is what is stored, so `ａ.com` is stored as `a.com`; a test pins this.
    5. **On the result, in exactly this order** (design review 2: removing the dot after the checks let `1.2.3.4.` through):
       1. remove **one** trailing dot;
       2. refuse empty labels (`a..b`, and `a.com..`, which still has one after step 1);
       3. split off a leading `*.` label as the wildcard flag (validated only by step 7). A `*` anywhere in the rest is refused;
       4. on the remaining name: **refuse it if `net.isIP` passes** (outside `"scanner"` mode), or if its **last label ends in a number** in the WHATWG sense, that is, it matches `^[0-9]+$` or `^0[xX][0-9a-fA-F]*$`. This catches `1.2.3`, `127.1`, `0x7f.0x1` and `1.0x1`, and refuses `a.0x7f` too, which is safe because it is not resolvable;
       5. every label must be 1–63 characters of `[a-z0-9-]`, not starting or ending with `-` (`-a.com`, `a_b.com` are refused);
       6. at most 253 characters for the name (without port or wildcard), and at least two labels (`localhost` and `0x7f` are refused).
    6. **Local names**, in `"agent"` mode only, checked on the name after step 5: refuse a last label of `localhost`, `local`, `internal`, `lan`, `home`, `arpa` or `localdomain`. That covers `host.docker.internal` and `foo.localhost`. The operator's `"local-access"` and `"scanner"` modes accept them (`db.lan`, `host.docker.internal`). Leg 3's resolve-time range check is the real boundary; this refusal gives the agent an early, clear message.
    7. **Wildcards.** Only `*.` as the whole first label, in `"agent"` and `"scanner"` modes; never in `"local-access"`. Refused:
       - a bare `*`;
       - `*` elsewhere;
       - `*.<tld>`;
       - `*.<x>.<cc>`, where `<cc>` is a two-letter TLD and `<x>` is in the exported list `co com net org gov edu ac or ne go gob nic mil ltd plc sch` (so `*.co.uk` and `*.com.au` are refused, and `*.a.co.uk` is accepted).

       The module comment says this is a heuristic, not a public-suffix list. Hosting suffixes such as `*.github.io`, `*.pages.dev` and `*.s3.amazonaws.com` pass.
  - **How a test sees which step refused**: the thrown error is a `HostEntryError` with a `step` property, one of `raw`, `port`, `literal`, `name`, `number`, `label`, `local` and `wildcard`, and a message that names the problem. Tests assert the `step`, and for a few cases the message.
  - **Negative cases required:**
    - **IPv4 shorthand and numeric names**: `127.1`, `127.1.`, `0x7f.1`, `0x7f.0x1`, `1.0x1`, `a.0x7f`, `2130706433`, `0177.0.0.1`, `010.0.0.1`, `1.2.3`.
    - **IP literals outside scanner mode**: `1.2.3.4` and `1.2.3.4.` (both accepted in scanner mode, as `1.2.3.4`); `127.0.0.1.`.
    - **Bad labels**: `a..b`, `-a.com`, `a_b.com`, `a.com..`, `xn--a.com`, `XN--A.COM`, `localhost`, `0x7f`.
    - **Local names in agent mode**: `host.docker.internal`.
    - **Wildcards**: bare `*`, `a.*.com`, `*.*.a.com`, `*.com`, `*.co.uk`, `*.com.au`, `*.1.2.3.4`.
    - **Ports and literals**: each bad port above, a port-only `:80`, `[1.2.3.4]`, `fe80::1%eth0` in brackets.
    - **Schemes**: `https://a.com`.
  - **A parametrized test of IPv4 spellings**: at least 20 (decimal, hex, octal, shorthand, with and without a trailing dot, fullwidth digits, the ideographic full stop `。`). Every one is refused in agent and local-access modes.
  - **Positive cases required:**
    - `a.com.` and `ａ.com`, both stored as `a.com`;
    - `*.a.co.uk`;
    - `127.0.0.1.nip.io` and `0x7f.example.com`, both names, which shows the numeric rule looks at the last label only;
    - `db.lan` (local-access mode);
    - `[::ffff:127.0.0.1]:443` (scanner mode, stored canonical);
    - `10.0.0.5:8080` and `1.2.3.4` (scanner mode; an unbracketed IPv4 with a port is fine, and unbracketed IPv6 is the only refused ambiguity).
  - **The module's doc comment records this order**, including why the trailing dot comes off before the numeric checks.
- [ ] **Default host table** (`src/network/defaults.ts`):
  - `buildHosts(ecosystems)`: every build's row (Debian and GitHub, as in DD5), plus the rows of the given ecosystems.
  - `sandboxHosts(ecosystems)`: only the ecosystems' rows (no Debian, no GitHub).
  - `cloneHosts(repo)`: `[repo.host]`.
  - `DEFAULT_HOSTS_VERSION`: a number, bumped by any change to the table (stated in a comment).
  - Both lists are de-duplicated and sorted, and each call returns a fresh array (a test mutates a result and calls again). `cmake`, `autotools`, `make` and `generic` add nothing.
  - Every table entry parses with the grammar above in `"agent"` mode (a test walks the table).
  - **An inline test pins the table to its version.** It asserts a hash of the canonical table next to `DEFAULT_HOSTS_VERSION`, so an edit without a bump fails. It is an inline assertion, not a snapshot file: the operator's rule is that snapshots are never committed.
- [ ] **`MCPE_LOCAL_ACCESS`** (`src/network/local-access.ts`, read in `loadConfig`):
  - **Syntax.** `<repo>=<host>:<port>[,<host>:<port>…][;<repo>=…]`. Whitespace around separators is ignored, and empty segments (a trailing `;`) are skipped.
  - **Splitting.** Segments split on `;`. Each segment splits on its **first** `=` (keys may contain `:`, e.g. `github:owner/repo` or `https://…`). Targets split on `,`.
  - **Keys** are parsed with `parseRepoRef(key, cfg.hosts)` and stored by lower-cased `id`. A key `parseRepoRef` refuses is a `ConfigError` naming the key. A repository named twice is a `ConfigError`. Tests use a plain key, a `github:` key and a URL key.
  - **Targets** are a host name and a required port, through the grammar in `"local-access"` mode, with no wildcard. A single trailing dot is removed, so the alias leg 5 makes is `db.lan`, never `db.lan.`. An IP literal gets a `ConfigError` that says the sandbox reaches local access only by a name and suggests a name such as `host.docker.internal`. A missing port is a `ConfigError`.
  - **Port rules, per repository.** Two targets on one port are a `ConfigError` naming both. A target on port 3128 (the proxy's own, exported as a constant) is a `ConfigError`.
  - **Lookup.** `localAccessFor(cfg, repo: RepoRef)` returns that repository's targets, or `[]`, comparing ids case-insensitively.
  - **Messages** quote at most the offending segment, cut to 80 characters, never the whole variable.
- [ ] **Scanner `hosts`** (`src/scan/scanners-file.ts`):
  - An optional array of **1 to 64** strings. An empty array is invalid, and so is anything other than an array of strings. Each entry goes through the grammar in `"scanner"` mode. Every failure is a `ConfigError` naming the file, the scanner and the field.
  - It is stored on `ScannerSpec` as a **required** `hosts: string[]`, in normalized form (`host` or `host:port`, IPv6 bracketed). Absent becomes `[]`.
  - `"hosts"` is added to the file's allowed keys.
- [ ] **Cross-check in `loadConfig`.** `loadConfig` computes `network` and `scan` as locals, then cross-checks, then builds the literal. With `MCPE_NETWORK=contained`, a scanner with `network: true` and `hosts` empty (that is, absent from the file) is a `ConfigError` naming the scanner and saying it needs `hosts` under containment. With `open`, `hosts` is accepted and ignored.
- [ ] **`Config.network`**: `{ mode: "open" | "contained"; localAccess: Record<string, LocalTarget[]> }`, where `LocalTarget` is `{ host: string; port: number }`. Defaults: `open` and `{}`.
- [ ] **Nothing else changes.**
  - No module outside `src/config.ts`, `src/scan/` and `src/network/` imports the new code.
  - `npm run typecheck` and `npm test` pass; the existing test count does not drop.
  - With no new variables set, `loadConfig({})` equals what it gives today plus `network: { mode: "open", localAccess: {} }`, and every scanner has `hosts: []`.

## Verification Steps
- `npx vitest run test/config.test.ts test/scan-scanners-file.test.ts test/network-hosts.test.ts test/network-defaults.test.ts test/network-local-access.test.ts`: every criterion above has at least one case, and every refusal at least one negative case asserting the message.
- `npm run typecheck`, then `npm test`: all green; record the counts in the flight log.
- `grep -rln "/network/" src`: only `src/config.ts` and files under `src/scan/` and `src/network/`.
- **Trial** (flight 1's practice). For three refusals (a single-label name, `*.co.uk`, a second target on one port), weaken the check in the source, confirm a test fails, and restore the source by editing (never with git). Record the three trials in the flight log.

## Implementation Guidance

1. **`src/network/hosts.ts`** — the grammar.
   - Pure; no DNS, no I/O.
   - Export the parser, the `HostEntry` type, the `HostMode` type, `PROXY_PORT = 3128`, and the wildcard heuristic's list, which leg 3 reuses.
   - Follow the order of checks in the acceptance criteria exactly; it is the point of the design review's fix. Keep each step a small named function, so the tests can say which step refused.
   - Keep the wildcard heuristic's list in one constant, with a comment saying it is not a public-suffix list.
2. **`src/network/defaults.ts`** — the table from DD5, as data.
   - Keep "every build" separate from the ecosystem rows, so `sandboxHosts` can leave it out.
   - Type the rows `Record<Ecosystem, readonly string[]>`, so a new ecosystem is a compile error until it has a row.
3. **`src/network/local-access.ts`** — the parser.
   - It takes `(raw, hosts: Config["hosts"])`, so keys resolve through `parseRepoRef` with the operator's `MCPE_EXTRA_HOSTS`.
   - Also export `localAccessFor`.
4. **`src/config.ts`**.
   - Add `network` to `Config` and parse it in `loadConfig` after `hosts` (local-access keys need them).
   - Add the cross-check after `parseScan`.
   - Keep `parseScan`'s signature.
5. **`src/scan/scanners-file.ts` and `src/scan/types.ts`**: `hosts`, as above.
6. **Tests.**
   - New files for the three modules; cases in `test/config.test.ts` for `MCPE_NETWORK`, `MCPE_LOCAL_ACCESS` and the cross-check; and in `test/scan-scanners-file.test.ts` for `hosts`.
   - Update the `ScannerSpec` literals and whole-object assertions listed under Outputs. Find any others with `grep -rn "timeoutSec: [0-9]*, env\|ScannerSpec" test`. `tsconfig.json` includes `test`, so `npm run typecheck` catches a miss.

## Edge Cases
- **`MCPE_LOCAL_ACCESS` key forms.** A key with a scheme (`https://github.com/a/b`) is accepted, since `parseRepoRef` accepts it, and stored by id. A key on a host not in `MCPE_EXTRA_HOSTS` is refused by `parseRepoRef`; the message names the key.
- **Repository case.** `Acme/Postgres-MCP` and `acme/postgres-mcp` are the same repository: the duplicate check and the lookup are both case-insensitive.
- **Trailing and leading space** in any segment is ignored. A segment with only spaces is skipped.
- **The same host on different ports** for one repository is allowed (`db.lan:6379,db.lan:6380`).
- **The same port for different repositories** is allowed (the proxies are per project).
- **IPv6 in scanner `hosts`** needs brackets when a port follows. An unbracketed IPv6 with a port is ambiguous and refused.
- **`*.example.com` does not match `example.com` itself.** The grammar only records the flag; matching is leg 3's. Leave a doc comment saying so.
- **Names that resolve locally.** Names such as `foo.example` or a public name pointing at `127.0.0.1` pass the grammar. Only leg 3's resolve-time check refuses them. The grammar's local-name refusal (agent mode) is an early message, not the boundary.

## Files Affected
- `src/network/hosts.ts`, `src/network/defaults.ts`, `src/network/local-access.ts`: new.
- `src/config.ts`: `Config.network`, parsing, cross-check.
- `src/scan/scanners-file.ts`, `src/scan/types.ts`: scanner `hosts`.
- `test/network-hosts.test.ts`, `test/network-defaults.test.ts`, `test/network-local-access.test.ts`: new.
- `test/config.test.ts`, `test/scan-scanners-file.test.ts`: new cases and two whole-object assertions.
- `test/installer.test.ts`, `test/docker.test.ts`, `test/scan-policy.test.ts`, `test/scan-run.test.ts`, `test/integration/docker.test.ts`: `ScannerSpec` literals gain `hosts: []` (no behavior change).

## Citation Audit
Checked against `main` at `c55f743` on 2026-11-22:
- `src/config.ts`: `parseHosts`, `parseScan`, `parseNamePrefix`, `loadConfig`. Present as cited.
- `src/scan/scanners-file.ts`: `KEYS` at line 8, `parseScannersFile`. Present.
- `src/scan/types.ts`: `ScannerSpec`. Present.
- `src/forge/repo-ref.ts`: `parseRepoRef`, `build` (id forms). Present.
- `ScannerSpec` literals: `test/installer.test.ts:1922`, `:2150`; `test/docker.test.ts:191`; `test/scan-policy.test.ts:83`; `test/scan-run.test.ts:13`. Present, from a grep. The `test/integration/docker.test.ts` helper is near line 1148, per the design review.
- `test/server.test.ts:2277` was wrongly cited at first as a `Config` literal; it is a project record's `scan` result. Removed after design review 1.
- `node -e` checks on 2026-11-22 confirmed: `domainToASCII("127.1")` gives `"127.0.0.1"` with `net.isIP("127.1") === 0`; `domainToASCII("xn--a.com")` gives `""`; `new URL("http://[0:0:0:0:0:0:0:1]").hostname` gives `"[::1]"`.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
