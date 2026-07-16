# Releasing @nienhq/docket

**Decision (2026-07-16): no npm publishing for now.** package.json carries
`"private": true` as the guard; distribution is git checkout + `pnpm pack`
(proven by `pnpm verify:pack`). Everything below is kept as the runbook for
if and when that decision is reversed: remove `"private": true` and follow
it.

Runbook for publishing to npm. Publishing is deliberate and manual: no
script in this repo creates tags or publishes on its own.

## Semver policy

0.x throughout the current phase. Per [plan.md](plan.md):

- **minor** (0.1.0 to 0.2.0): any breaking change, and the default bump.
- **patch** (0.1.0 to 0.1.1): fixes only, no API movement.
- 1.0.0 happens when the public API stops moving, not before.

## Prerequisites

- The **@nienhq scope must exist on npm** before the first publish: create
  the `nienhq` org at npmjs.com (or the scoped name will 404 on
  `npm publish`). The publishing account needs membership with publish
  rights.
- Until the CI pipeline (plan task 1.1) is unblocked, publishing happens
  from a maintainer machine: `npm login` with an account in the nienhq
  org. Once CI exists, switch to npm trusted publishing from GitHub
  Actions and add `--provenance` to the publish command; drop local
  tokens at that point.
- Clean working tree on `main`, up to date with origin.
- Node >= 20 (matches `engines`).

## Release steps

1. Move the `[Unreleased]` items in CHANGELOG.md into a new
   `[x.y.z] - YYYY-MM-DD` section and update the link references at the
   bottom.
2. Verify everything:

   ```sh
   pnpm typecheck && pnpm vitest run
   pnpm verify:pack
   ```

   `verify:pack` builds, packs, audits the tarball contents and size,
   installs the tarball into a scratch project, runs an ingest and search
   smoke test against the installed package, and drives the installed
   `docket-mcp` bin over stdio. All steps must print PASS.

3. Bump the version. `pnpm release` runs `verify:pack`, bumps the minor
   version without tagging, and prints the remaining manual commands.
   For a patch release, bump by hand instead:

   ```sh
   npm version patch --no-git-tag-version
   ```

4. Commit, tag, push (the tag is `v` plus the exact package.json version):

   ```sh
   git commit -am v0.2.0
   git tag v0.2.0
   git push --follow-tags
   ```

5. Publish:

   ```sh
   npm publish --access public
   ```

   `--access public` is required for the first publish of a scoped
   package. With CI trusted publishing (once task 1.1 lands), this becomes
   `npm publish --access public --provenance` run by the workflow on tag
   push.

6. Confirm from a clean directory:

   ```sh
   mkdir /tmp/docket-check && cd /tmp/docket-check
   npm init -y && npm pkg set type=module
   npm install @nienhq/docket
   npx docket-mcp --dir . 2>&1 | head -1   # expect the read-only db hint
   ```

7. Add the next `## [Unreleased]` heading to CHANGELOG.md if step 1
   consumed it.

## If a publish goes wrong

- npm allows `npm unpublish <pkg>@<version>` only within 72 hours and it
  is a last resort; prefer publishing a fixed patch version.
- Never reuse a version number: a failed tag can be deleted and re-pushed,
  a published version cannot.
