# Convex Better Auth React client types

`@convex-dev/better-auth@0.12.5` incorrectly infers its generic React client session
as `never` with Better Auth 1.6.30. Upstream tracking:
https://github.com/get-convex/better-auth/issues/420.

The Bun patch changes only `dist/react/index.d.ts`. It infers a client from the
required `convexClient()` plugin and exposes the three members consumed by the
React provider and auth boundary: `useSession`, `getSession`, and `convex`.
Additional app plugins remain fully typed on the application's original client.
No authentication JavaScript, session behavior, or security checks are changed.

Both auth package versions are pinned in `package.json`. Install with
`bun install --frozen-lockfile`; Bun applies the patch through `patchedDependencies`.
Do not mix a pnpm-created `node_modules` tree with Bun installs.

`src/lib/auth-client.type-test.ts` is checked by `tsc --noEmit`. It verifies the
app client is accepted, clients missing required methods are rejected, and signed-out
sessions are nullable rather than `never`.

Remove this patch when an official adapter release resolves the issue, then rerun
TypeScript and the authentication tests before updating the pinned versions.
