# Write an adapter

An adapter connects the town to one system that knows something about your services: a metrics store, a cloud inventory, an incident tool. The core knows none of them by name. It knows request rate, error rate, latency, instances, CPU, memory, capacity used, throttling and queue depth, and an adapter fills those from whatever it reads.

This guide is for someone adding an adapter, in a fork or upstream. The working example is [templates/adapter](../templates/adapter), and the checks every adapter has to pass are in the kit at `backend/src/ObservabilityCity.AdapterKit`.

## The shape

```
environment file            adapter module                       core
sources:                    IAdapterModule  (what it adds)       AdapterCatalog   knows the module's kinds and logins
  telemetry:                  IMetricSourceFactory  (kind)  ->   builds one IMetricSource per environment source
    kind: example-http        IMetricSource  (polls)         ->  SourcePoller    calls PollAsync on its interval, with its timeout
    connection: ...         ICredentialKind  (a login)           LatestState     keeps the last readings; age makes them stale
                                                                 SnapshotBuilder applies the health rules, the browser draws
```

- A **module** is a class that implements `IAdapterModule`. Its `Register` only records what the module has: source kinds (`AddSource` with a factory, or `AddSourceKind` for a kind it knows but cannot read yet) and logins (`AddCredentialKind`). It signs nobody in and reaches nothing, so a town starts before `az login`.
- A **factory** makes the source for each environment source of its kind. It gets a `SourceContext`: the environment id, the source as the file defines it (`connection`, `pollSeconds`, `timeoutSeconds`), the login it is to use, the environment's `scope:` rules and the `ScopeStore`, and the folder of the town's files. If the definition cannot work, throw `InvalidOperationException` with a sentence that says what to change; the host reports it at start-up and carries on without that source.
- A **source** implements `IMetricSource`: a name, a `PollInterval`, a `Timeout` (take both from the definition) and `PollAsync(registry, ct)`, which answers for every system it can in one batched call. The poller runs one loop per source, cancels a poll that takes longer than `Timeout`, and logs one that throws.
- A **login** implements `ICredentialKind`: `Check` says what is wrong with an entry in words, `Create` makes the login. Making one signs nobody in; the token is asked for when first needed.

Incident tools implement `IIncidentSource` (answers from what it already knows, refreshing on its own timer) and log stores `ILogSource` (read on demand when an inspector opens, never polled).

## The rules a source keeps

1. **Answer only for systems the registry has, and leave out the rest.** A system with no reading shows as having no data. Never invent one, and never fill a zero to look healthy.
2. **A signal nobody configured is absent, not grey.** That is decided by the environment file (`signals:`), not by you: report what you read and leave a number `null` when the source does not know it (`Cpu`, `Memory`, `Utilisation`, `Throttled`, `QueueDepth`...). Null means "I do not know"; zero means "it is zero".
3. **Throw when you cannot read.** A failed poll leaves the last readings in place and they age into the stale state, which the town shows as grey. Swallowing the error and returning an empty or fresh-looking answer hides a broken source.
4. **Pass the cancellation token to every call.** The timeout is enforced by cancelling it.
5. **Rates and shares mean what the snapshot builder assumes.** `ErrorRate`, `Cpu`, `Memory`, `Utilisation` and `Throttled` are shares between 0 and 1; request rate, latency and counts are not negative; `InstancesHealthy` is at most `InstancesTotal`; `At` is when the number was true (set it, or it ages as if from year one).
6. **Health comes from unsampled data.** Do not derive error rate from sampled traces.
7. **No convention is in the adapter.** A tag key, a name pattern, a metric name, a query: all of them are settings or templates in the environment file, with the adapter shipping only generic defaults. A company with other conventions must be able to use your adapter by changing its config. If something has to be company code, it is a separate adapter in the company's `extensions/`.
8. **No secret, tenant id, subscription id, hostname or company name in the repository.** A secret is read from an environment variable the config names. Examples and tests use `example.test` names.

## Where an adapter finds out where a system lives

An adapter that reads per-service data (a workspace, a resource group, a role name) asks the `ScopeStore` of its environment, which the inventory source fills:

```csharp
var scope = context.Scope!.Resolve(registry.ForEnvironment(context.EnvironmentId));
var system = scope.System("aa.orders-api");   // SubscriptionId, Workspace, TelemetryRole, ServiceCode, Resources
```

Before the inventory is read it holds only what the rules say on their own (a named subscription, the workspace, a system's telemetry role); the rest appears after the first read. Handle both. See "Scope" in [connect-your-company.md](connect-your-company.md).

## Build it

1. Copy `templates/adapter` to `extensions/<company>.<name>/` (same depth, so the project reference to the core resolves). Rename the project, namespace, module and kind. **The built assembly's file name must contain `Adapters`**, or the host does not look at it.
2. Replace `PollAsync` with the calls to your system. Everything else (interval, timeout, stale state, login) is the core's.
3. `dotnet build backend/ObservabilityCity.slnx` builds it and copies it to `adapters/<name>/` beside the host; the host loads whatever it finds there. `dotnet build -p:ExcludeAdapters=true` builds without any.
4. Add the environment settings and a section to the runbook (below).

Upstream, a generic adapter is a project `backend/src/ObservabilityCity.Adapters.<Name>` and is picked up the same way.

## Test it

Tests use recorded answers, never a live service. The kit has what an author needs and depends on no test framework:

| Kit | Use |
| --- | --- |
| `CannedHttp` | An `HttpMessageHandler` that answers in the order you give (the last repeats, or decide by request) and remembers each request: method, address, headers, body, body as JSON |
| `StaticLogin` | A login that gives one token and records the scopes it was asked for |
| `TownFiles` | A private copy of a registry folder: `Write` a file, `Load` an environment, disposed when done |
| `AdapterContract.AssertModule` | A module has a kebab-case name, registers cleanly without reaching anything, adds a kind or login, and registers no kind twice |
| `AdapterContract.AssertPollAsync` | A source has an interval and a timeout, answers only for known systems with numbers in range, and ends a poll it is told to stop |
| `AdapterContract.CheckReadings` | The same checks on a set of readings you made yourself |

Write at least: the contract (module and source), the readings your canned answers must produce, a source that cannot be read (it throws), a definition that cannot start (the message), and **the same adapter run against a second, differently shaped config** to prove no convention is in it. `backend/tests/ObservabilityCity.Tests/TemplateAdapterTests.cs` and `ScopeResolutionTests.cs` are the examples. Keep recorded answers in `shared-test-data/` upstream or beside the extension in a fork.

Anything the adapter makes visible in the town needs a UI test too (a Vitest unit test of the model, a Playwright test through a fixture-backed source). A change that is backend-only says so in the pull request.

## The runbook section

Each adapter gets a section in `docs/connect-your-company.md` (in a fork, in the fork's copy) with the same four parts: the permission the login needs, the `connection` value, the `pollSeconds` and `timeoutSeconds` that suit it, and what `validate --sources` reports for it. If it needs a probe for that check, add an `ISourceProbe` in `backend/tools/ObservabilityCity.Validate` (see `SourceProbes.cs`).
