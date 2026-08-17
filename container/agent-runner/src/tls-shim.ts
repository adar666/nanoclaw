/**
 * AD-15 TLS-trust shim.
 *
 * The OneCLI gateway's CA cert reaches this container only via
 * `SSL_CERT_FILE` (the env var Node/Deno/curl read for extra trusted CAs).
 * Bun's own `fetch()` does not read `SSL_CERT_FILE` — it reads
 * `NODE_EXTRA_CA_CERTS` instead, a different variable entirely. Without
 * this shim, any Bun `fetch()` call routed through the gateway (e.g.
 * `mcp-tools/calendar.ts`) fails TLS verification against the gateway's
 * MITM proxy cert, even though `curl`-based calls (see `upload-trace.ts`)
 * work fine as-is.
 *
 * Deliberately not the literal `process.env.NODE_EXTRA_CA_CERTS ??=
 * process.env.SSL_CERT_FILE` one-liner: when `SSL_CERT_FILE` is unset,
 * `??=` would still assign — Node coerces an `undefined` RHS assigned to
 * `process.env.X` into the *string* `"undefined"`, which would wrongly
 * point Bun's TLS trust at a file that doesn't exist. The explicit guard
 * below avoids that.
 *
 * Extracted into its own module (rather than inlined at the top of
 * `index.ts`) so it's unit-testable in isolation, per this story's design
 * notes — `index.ts` itself can't be imported in a test without triggering
 * its top-level `main()` call.
 */
export function applyTlsCertShim(env: NodeJS.ProcessEnv = process.env): void {
  if (env.SSL_CERT_FILE && !env.NODE_EXTRA_CA_CERTS) {
    env.NODE_EXTRA_CA_CERTS = env.SSL_CERT_FILE;
  }
}
