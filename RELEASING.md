# Releasing nfxmap to npm

Every package of [packages/](packages/) is released together, under one version: `nfxmap` and its transports and
integrations (`nfxmap-nats`, `nfxmap-rabbitmq`, `nfxmap-kafka`, `nfxmap-grpc`, `nfxmap-sqs`, `nfxmap-azure-servicebus`,
`nfxmap-typeorm`, `nfxmap-mongodb`, `nfxmap-graphql`, `nfxmap-opentelemetry`). The workspaces `interop`, `samples/*`
and `benchmarks` are private and never published.

A tag `v<version>` runs [.github/workflows/release.yml](.github/workflows/release.yml):

1. it sets that version in every package, and makes each one ask for `nfxmap@^<version>`;
2. it typechecks, runs the tests that need no broker, and builds;
3. it packs each package, checks what the tarball holds, installs them all in a new project and loads each one with
   `require` and `import` ([scripts/check-packages.mjs](scripts/check-packages.mjs));
4. it publishes them, `nfxmap` first, with [provenance](https://docs.npmjs.com/generating-provenance-statements) when
   the repository is public: npm refuses provenance from a private repository.

A version with a label (`v0.2.0-rc.1`) goes to the dist-tag `next`, so `npm install nfxmap` still gets the latest
release; any other goes to `latest`. A package already published at that version is skipped, so the workflow can be
re-run after a failure. A re-run uses the workflow of the tagged commit: after a fix to the workflow, move the tag to a
commit that has it (`git tag -f v0.1.0 origin/main && git push -f origin v0.1.0`) rather than re-running. A version
published on npm can never be published again, even after it is unpublished.

## Once

1. Have an account on <https://www.npmjs.com> with two-factor authentication on. The names `nfxmap` and `nfxmap-*` are
   free; the first release makes the account their owner.
2. On npmjs.com, your avatar > **Access Tokens** > **Generate New Token** > **Granular Access Token**:
   - **Packages and scopes**: *Read and write*, on *All packages* (the packages do not exist before the first
     release; once they do, the token can be narrowed to them);
   - tick **Bypass two-factor authentication**, so the workflow can publish without a one-time password;
   - an expiration: npm limits a token that can write to 90 days, so a new one is needed after that.
3. On GitHub, quyvu01/nfxmap > Settings > Secrets and variables > Actions > **New repository secret**: `NPM_TOKEN`, the
   token.

## Each release

Tag a commit of `main` whose [build](.github/workflows/build.yml) is green, as the release does not run the tests that
need the brokers, nor the interop tests:

```sh
git checkout main && git pull
git tag v0.1.0
git push origin v0.1.0
```

The packages are on npm once the release workflow is green: `npm view nfxmap versions`. The versions in the
`package.json` files stay at the last release; the workflow writes the tag's version into its own checkout only.

## Locally

```sh
npm run build
node scripts/check-packages.mjs                 # the tarballs, as they would be published
node scripts/set-version.mjs 0.1.0              # the version of every package (changes the package.json files)
npm publish -w packages/nfxmap --dry-run        # what one package would publish
```
