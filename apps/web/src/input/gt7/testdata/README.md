# gt7.inputs.v1 contract snapshot (copied, do not edit)

`v1/` is a verbatim copy of `browserstream/testdata/v1/` from
[arush-sal/gt7-telemetry-collector](https://github.com/arush-sal/gt7-telemetry-collector)
at tag **v0.3.0** (commit `378eb8948ca6b65fa13e274ce6353d712e1d7d87`).

The collector owns this contract. **Do not edit these files**; update them only by
re-copying a newer tagged snapshot, e.g.:

```sh
R=repos/arush-sal/gt7-telemetry-collector T=v0.3.0
gh api "$R/contents/browserstream/testdata/v1/<path>?ref=$T" -q .content | base64 -d > v1/<path>
```

Consumed by `../protocol.test.ts` and `../gt7Client.test.ts` (every valid/invalid fixture and
all transcripts). See `docs/input-protocol.md` and ADR 0011.
