# Source adapter template

A working adapter to copy. It reads one JSON document over HTTP and turns it into readings, so you see every part an adapter has without a real system in the way. The full guide is [docs/write-an-adapter.md](../../docs/write-an-adapter.md).

## Use it

1. Copy this folder to `extensions/<company>.<name>/` in your fork (the same depth, so the project reference to the core still resolves).
2. Rename it: the project file, the namespace, `TemplateAdapters` and the `example-http` kind. **The assembly's file name must contain `Adapters`** (for example `Acme.Adapters.Metrics`), or the host will not look at it.
3. Replace `ExampleHttpSource.PollAsync` with the calls to your system. Keep the rules in the comment above it.
4. Write its tests with the kit (`backend/src/ObservabilityCity.AdapterKit`): canned HTTP answers, the contract checks every adapter has to pass, and a town to run it against. `backend/tests/ObservabilityCity.Tests/TemplateAdapterTests.cs` is the example.
5. `dotnet build backend/ObservabilityCity.slnx` builds your extension and copies it to `adapters/<name>/` beside the host. Add a section to `docs/connect-your-company.md` in your fork: the permission it needs, the `connection`, a poll interval and timeout that suit it, and what `--sources` reports.

Nothing in `backend/` or `frontend/` changes. The upstream build does not include this folder.

## What it reads

```json
{ "systems": { "aa.orders-api": { "requestsPerSecond": 12, "errorRate": 0.01, "p99Ms": 120, "instances": 3, "instancesHealthy": 3, "cpu": 0.4 } } }
```

and is set up in an environment file as

```yaml
sources:
  telemetry: { kind: example-http, connection: "https://metrics.example.test/readings", pollSeconds: 30, timeoutSeconds: 10 }
signals: { requests: telemetry, errors: telemetry, latency: telemetry, instances: telemetry, cpu: telemetry }
```
