# Write an adapter

An adapter connects the town to one system that knows something about your services: a metrics store, a cloud inventory, an incident tool. The core knows none of them by name. It knows request rate, error rate, latency, instances, CPU, memory, capacity used, throttling and queue depth, and an adapter fills those from whatever it reads. The repo ships an Azure adapter (`backend/src/ObservabilityCity.Adapters.Azure`) today; adapters for other clouds and tools plug in the same way.

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

- A **module** is a class that implements `IAdapterModule`. Its `Register` only records what the module has: source kinds (`AddSource` with a factory, and `AddSourceKind` to say what a kind can do or for a kind it knows but cannot read yet) and logins (`AddCredentialKind`). It signs nobody in and reaches nothing, so a town starts before anyone signs in.
- A **factory** makes the source for each environment source of its kind. It gets a `SourceContext`: the environment id, the source as the file defines it (`connection`, `pollSeconds`, `timeoutSeconds`, and its own settings, see "Own your settings"), the login it is to use, the environment's `scope:` rules and the `ScopeStore`, and the folder of the town's files. If the definition cannot work, throw `InvalidOperationException` with a sentence that says what to change; the host reports it at start-up and carries on without that source.
- A **source** implements `IMetricSource`: a name, a `PollInterval`, a `Timeout` (take both from the definition) and `PollAsync(registry, ct)`, which answers for every system it can in one batched call. The poller runs one loop per source, cancels a poll that takes longer than `Timeout`, and logs one that throws.
- A **login** implements `ICredentialKind`: `Check` says what is wrong with an entry in words, `Create` makes the login. Making one signs nobody in; the token is asked for when first needed.

Incident tools implement `IIncidentSource` (answers from what it already knows, refreshing on its own timer) and log stores `ILogSource` (read on demand when an inspector opens, never polled).

## Say what a kind can do

Some jobs in the town need a source that can do more than fill signals. The core never asks what a kind is called. It asks the adapter, so each kind says what its sources can do in `SourceKindInfo.Capabilities` when the module registers it:

| Capability | What it serves | The environment file names it in | The source implements |
| --- | --- | --- | --- |
| `Logs` | The Logs tab's query | `logs.source` | `ILogRowSource` |
| `Links` | The link discovery and link traffic queries | `links.source` | `IDependencySource` |
| `Inventory` | The inventory that fills the `ScopeStore` | `scope.inventory` (or nothing: any such source) | nothing more: it fills the `ScopeStore` in its `SourceContext` |
| `HealthEvents` | The cloud's own health reports | nothing: no signal reads it, so it is never named as unused | `IHealthEventSource` |

```csharp
public void Register(IAdapterRegistry registry)
{
    registry.AddSourceKind(new SourceKindInfo("metricstore") { Capabilities = SourceCapabilities.Logs | SourceCapabilities.Links });
    registry.AddSource(new MetricStoreSourceFactory());
}
```

A kind that only fills signals declares nothing (`SourceCapabilities.None`, the default). The registry check (`validate`) refuses a file whose `logs.source`, `links.source` or `scope.inventory` names a source whose kind cannot do that job, and lists the kinds that can. A kind no loaded module knows is reported once as unknown, and nothing is guessed about what it can do. The Azure adapter declares `Inventory` for `resourcegraph`, `Logs` and `Links` for `loganalytics`, and `HealthEvents` for `resourcehealth`.

## Own your settings

A source block in an environment file has the core's keys: `kind`, `connection`, `credential`, `pollSeconds`, `timeoutSeconds`, `lateAfterSeconds`, `query` and `window`. Every other key belongs to the adapter of the source's kind. The core keeps those keys as they were written, with their lines, and hands them to the adapter, which checks them and turns them into the settings its source reads. A kind that declares no settings takes no other key: one is an error, as a misspelt key is anywhere else. A kind no loaded module knows is reported once, and its keys are not checked.

Declare a settings reader with the kind:

```csharp
registry.AddSourceKind(new SourceKindInfo("metricstore") { Settings = new MetricStoreSettings() });
```

The usual way to write one is `SourceSettingsReader<TFile, TSettings>`. `TFile` is a plain class with one property for each key (camelCase in the file), read as strictly as the core's own files: an unknown key or a value of the wrong shape is reported with its line. `Check` adds the checks the shape cannot say (a value that must be one of a few, a rule that must exist in `scope`), each placed on the line of the key it names. `Convert` makes the `TSettings` the source reads:

```csharp
public sealed class MetricStoreSettings : SourceSettingsReader<MetricStoreFile, MetricStoreQueries>
{
    protected override void Check(MetricStoreFile file, SourceSettingsContext context, SettingsReport report)
    {
        if (file.Queries is null) report.Add($"source '{context.SourceName}' needs queries: rate, errors and latency");
        else if (string.IsNullOrWhiteSpace(file.Queries.Rate)) report.Add($"source '{context.SourceName}' queries.rate is empty", "queries", "rate");
    }

    protected override MetricStoreQueries Convert(MetricStoreFile file) => new(file.Queries?.Rate ?? "", file.Queries?.Errors, file.Queries?.Latency);
}
```

The source reads them with `reader.For(context.Source)`: the settings the loader made, or read now for a town loaded without the module. A message starts with `source '<name>'`; the file's name and the line are added for you. The validator, the loader and the server all run the same reader, so a mistake shows in `validate`, in a strict load and at start-up alike.

To give editors completion for your keys, override `Schema` with a JSON schema fragment: an object with `properties` (your keys) and, if you need them, `$defs` (referred to as `#/$defs/name`). `dotnet run --project backend/src/ObservabilityCity.Host -- --write-schema` merges the fragments of the loaded modules into each town's `schema/environment.schema.json`, for the kinds that use them. Leave the core's keys to the core. The Azure adapter is the full example: `backend/src/ObservabilityCity.Adapters.Azure/Settings/`.

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
var system = scope.System("aa.orders-api");   // SubscriptionId (the account), Workspace (the telemetry store), TelemetryRole, ServiceCode, Resources
```

Before the inventory is read it holds only what the rules say on their own (a named account, the telemetry store, a system's telemetry role); the rest appears after the first read. Handle both.

The source that reads the inventory is any source whose kind declares `Inventory` (see "Say what a kind can do"); with the Azure adapter it is `resourcegraph`.

Current limit: the account and telemetry store keys of `scope` (`subscription`, `pillars`, `workspace`, `workspaceId`, `queries`) are Azure adapter settings the core still holds (marked **Azure adapter setting** in [config-reference.md](config-reference.md)). See "Scope" in [connect-your-company.md](connect-your-company.md).

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
| `TownFiles` | A private copy of a registry folder: `Write` a file, `Load` an environment (pass your module, so it reads its settings as the host does), disposed when done |
| `AdapterContract.AssertModule` | A module has a kebab-case name, registers cleanly without reaching anything, adds a kind or login, and registers no kind twice |
| `AdapterContract.AssertPollAsync` | A source has an interval and a timeout, answers only for known systems with numbers in range, and ends a poll it is told to stop |
| `AdapterContract.CheckReadings` | The same checks on a set of readings you made yourself |
| `AdapterContract.AssertCapabilities` | A source implements the interface for each capability its kind declares, and declares each one it implements (`CapabilitiesOf` reads what a module declares for a kind) |
| `AdapterContract.ReadSettings` | Reads one source block, written as YAML, with the module's settings reader: the settings its source gets and the mistakes, each with its line (`SettingsOf` gives the reader a module declares for a kind; `AssertModule` checks its schema fragment) |

Write at least: the contract (module, source and capabilities), your settings (a good block and each mistake, with its line), the readings your canned answers must produce, a source that cannot be read (it throws), a definition that cannot start (the message), and **the same adapter run against a second, differently shaped config** to prove no convention is in it. `backend/tests/ObservabilityCity.Tests/TemplateAdapterTests.cs` and `ScopeResolutionTests.cs` are the examples. Keep recorded answers in `shared-test-data/` upstream or beside the extension in a fork.

Anything the adapter makes visible in the town needs a UI test too (a Vitest unit test of the model, a Playwright test through a fixture-backed source). A change that is backend-only says so in the pull request.

## The runbook section

Each adapter gets a section in `docs/connect-your-company.md` (in a fork, in the fork's copy) with the same four parts: the permission the login needs, the `connection` value, the `pollSeconds` and `timeoutSeconds` that suit it, and what `validate --sources` reports for it. If it needs a probe for that check, add an `ISourceProbe` in `backend/tools/ObservabilityCity.Validate` (see `SourceProbes.cs`).
