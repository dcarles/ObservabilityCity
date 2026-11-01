using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Azure.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using ObservabilityCity.Host;
using ObservabilityCity.Validate;

namespace ObservabilityCity.Tests;

/// <summary>
/// Phase 2, slice 1: the registry accepts real source kinds with a login, a poll interval and a timeout; each signal is pointed at a source; and a
/// signal with no source is absent. Nothing here reaches Azure: the adapters are test doubles and the logins are only made, never used.
/// </summary>
public class SourcePlumbingTests
{
    // Two sample environments with nothing in common but the pillars: other kinds, other source names, another login, another split of the signals.
    private const string ShapeA = """
        name: Production
        sources:
          metrics: { kind: loganalytics, connection: "workspace-a.example.test", pollSeconds: 60, timeoutSeconds: 20 }
          inventory: { kind: resourcegraph, connection: "scope-a.example.test" }
          platform: { kind: azuremonitor, credential: reader }
        credentials:
          reader: { kind: service-principal, tenantId: tenant-a, clientId: client-a, clientSecretEnv: EXAMPLE_SECRET }
        signals:
          instances: inventory
          cpu: platform
          memory: platform
          utilisation: platform
          throttled: platform
        """;

    private const string ShapeB = """
        name: Production
        sources:
          telemetry: { kind: prometheus, connection: "https://prom.example.test" }
          messaging: { kind: servicebus, connection: "sb-example.servicebus.windows.net" }
        signals:
          requests: telemetry
          errors: telemetry
          latency: telemetry
          cpu: none
        """;

    private static RegistryCopy LiveTownWith(string environment)
    {
        var copy = new RegistryCopy(TestPaths.LiveTown);
        Directory.CreateDirectory(copy.FilePath("environments"));
        copy.Write("environments/prod.yaml", environment);
        return copy;
    }

    private static Registry Prod(RegistryCopy copy) => RegistryLoader.Load(copy.Path).ForEnvironment("prod");

    private static RegistryNode Node(Registry r, string id) => r.AllNodes.First(n => n.Id == id);

    private static string LoadError(string environment)
    {
        using var copy = LiveTownWith(environment);
        return Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message;
    }

    // ---- the files ----

    [Fact]
    public void Real_kinds_load_with_a_login_a_poll_interval_and_a_timeout()
    {
        using var copy = LiveTownWith(ShapeA);

        var env = RegistryLoader.Load(copy.Path).Environments.Single();

        var metrics = env.Sources.Single(s => s.Name == "metrics");
        Assert.Equal("loganalytics", metrics.Kind);
        Assert.Equal(TimeSpan.FromSeconds(60), metrics.PollInterval);
        Assert.Equal(TimeSpan.FromSeconds(20), metrics.Timeout);
        Assert.Equal("reader", env.Sources.Single(s => s.Name == "platform").Credential);
        Assert.Equal(TimeSpan.FromSeconds(RegistrySource.DefaultPollSeconds), env.Sources.Single(s => s.Name == "inventory").PollInterval);
        Assert.Equal(TimeSpan.FromSeconds(RegistrySource.DefaultTimeoutSeconds), env.Sources.Single(s => s.Name == "inventory").Timeout);
        var login = env.Credentials.Single();
        Assert.Equal(("reader", "service-principal", "client-a", "EXAMPLE_SECRET"), (login.Name, login.Kind, login.ClientId, login.ClientSecretEnv));
        Assert.Equal("platform", env.Signals["cpu"]);
    }

    [Fact]
    public void The_loader_checks_only_the_shape_of_a_kind_and_leaves_which_kinds_exist_to_the_adapters_loaded()
    {
        using var copy = LiveTownWith("sources:\n  metrics: { kind: nothing-reads-this }\n");

        Assert.Equal("nothing-reads-this", RegistryLoader.Load(copy.Path).Environments.Single().Sources.Single().Kind);
        Assert.Contains("source 'metrics' has kind 'Not Kebab', which must be lowercase kebab-case", LoadError("sources:\n  metrics: { kind: Not Kebab }\n"));
    }

    [Theory]
    [InlineData("sources:\n  metrics: { kind: prometheus, pollSeconds: 0 }\n", "source 'metrics' has pollSeconds 0; it must be above 0")]
    [InlineData("sources:\n  metrics: { kind: prometheus, timeoutSeconds: -5 }\n", "source 'metrics' has timeoutSeconds -5; it must be above 0")]
    [InlineData("sources:\n  metrics: { kind: loganalytics, credential: reader }\n", "source 'metrics' uses credential 'reader', which this file does not define")]
    [InlineData("sources:\n  metrics: { kind: prometheus }\nsignals:\n  cpuu: metrics\n", "unknown signal 'cpuu'. Use requests, errors, latency, instances, cpu, memory, utilisation, throttled, backlog, deadLetters, jobs. Did you mean 'cpu'?")]
    [InlineData("sources:\n  metrics: { kind: prometheus }\nsignals:\n  cpu: metrcs\n", "signal 'cpu' comes from source 'metrcs', which this file does not define. Did you mean 'metrics'?")]
    public void Mistakes_in_sources_credentials_and_signals_are_named_with_the_file(string environment, string expected)
    {
        Assert.Contains("environments/prod.yaml: " + expected, LoadError(environment));
    }

    [Fact]
    public void A_secret_cannot_be_written_in_the_file()
    {
        // only the name of the variable that holds it has a place
        Assert.Contains("unknown key 'clientSecret'", LoadError("credentials:\n  reader: { kind: service-principal, tenantId: t, clientId: c, clientSecret: hunter2 }\n"));
    }

    [Fact]
    public void A_pillar_and_a_system_can_point_a_signal_somewhere_else_and_a_bad_one_is_named()
    {
        using var copy = LiveTownWith(ShapeB);
        copy.Replace("pillars/aa.yaml", "color: \"#5aa9ff\"", "color: \"#5aa9ff\"\nsignals: { cpuu: telemetry }");

        var message = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message;

        Assert.Contains("aa.yaml: the pillar has signals.cpuu, which is not a signal. Use requests, errors, latency, instances, cpu, memory, utilisation, throttled, backlog, deadLetters, jobs. Did you mean 'cpu'?", message);
    }

    // ---- which source answers for a signal ----

    [Fact]
    public void A_signal_comes_from_the_system_then_the_pillar_then_the_environment_then_the_default_source()
    {
        using var copy = LiveTownWith(ShapeB + "\n  memory: telemetry\n");
        copy.Replace("pillars/aa.yaml", "color: \"#5aa9ff\"", "color: \"#5aa9ff\"\nsignals: { memory: messaging, instances: telemetry }");
        copy.Replace("pillars/aa.yaml", "{ id: aa.orders-worker, service: orders, name: Orders worker, role: worker, calls: [aa.orders-db] }",
            "{ id: aa.orders-worker, service: orders, name: Orders worker, role: worker, calls: [aa.orders-db], signals: { instances: none } }");
        var r = Prod(copy);
        var api = Node(r, "aa.orders-api");
        var worker = Node(r, "aa.orders-worker");
        var other = Node(r, "bb.ledger-api");

        Assert.Equal("telemetry", r.SourceFor(api, Signals.Requests));   // the environment names it
        Assert.Equal("messaging", r.SourceFor(api, Signals.Memory));     // the pillar beats the environment
        Assert.Equal("telemetry", r.SourceFor(other, Signals.Memory));   // another pillar keeps the environment's
        Assert.Equal("telemetry", r.SourceFor(api, Signals.Instances));  // the pillar's
        Assert.Null(r.SourceFor(worker, Signals.Instances));             // the system beats the pillar: none
        Assert.Equal("messaging", r.SourceFor(api, Signals.Backlog));    // nobody names it: the source called messaging
        Assert.Null(r.SourceFor(api, Signals.Cpu));                      // none
    }

    [Fact]
    public void A_live_signal_with_no_source_is_absent_and_a_demo_town_is_never_without_one()
    {
        using var copy = LiveTownWith(ShapeB);
        var live = Prod(copy);
        var api = Node(live, "aa.orders-api");

        Assert.Equal(["instances", "cpu", "memory", "utilisation", "throttled"], live.AbsentSignals(api));

        var demo = RegistryLoader.Load(TestPaths.MiniTown);
        Assert.All(demo.AllNodes, n => Assert.Empty(demo.AbsentSignals(n)));
    }

    [Fact]
    public void A_live_town_with_no_environments_has_every_signal_absent()
    {
        var r = RegistryLoader.Load(TestPaths.LiveTown);

        Assert.All(r.AllNodes, n => Assert.Equal(Signals.All, r.AbsentSignals(n)));
    }

    [Fact]
    public void A_signal_pointed_at_a_source_the_environment_lacks_is_absent_there_and_a_warning_says_why()
    {
        using var copy = LiveTownWith(ShapeB);
        copy.Replace("pillars/aa.yaml", "color: \"#5aa9ff\"", "color: \"#5aa9ff\"\nsignals: { instances: inventory }");
        var r = Prod(copy);

        Assert.Null(r.SourceFor(Node(r, "aa.orders-api"), Signals.Instances));
        Assert.Contains(r.Warnings, w => w.Contains("aa.yaml: aa.orders-api takes instances from source 'inventory', which environment 'prod' does not define, so instances is absent there."));
    }

    [Fact]
    public void A_source_nothing_reads_is_a_warning()
    {
        using var copy = LiveTownWith(ShapeB);
        copy.Replace("environments/prod.yaml", "sources:\n", "sources:\n  spare: { kind: azuremonitor }\n");

        Assert.Contains(Prod(copy).Warnings, w => w.Contains("Environment 'prod' defines source 'spare', but no signal uses it."));
    }

    // ---- the snapshot ----

    private static Snapshot Build(Registry registry, Func<DateTimeOffset, NodeReading>? reading = null, string? id = null)
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 10, 26, 12, 0, 0, TimeSpan.Zero));
        var state = new LatestState();
        if (reading is not null) state.Update(new Dictionary<string, NodeReading> { [id!] = reading(clock.GetUtcNow()) });
        return new SnapshotBuilder(registry, state, clock).Build();
    }

    private static NodeSnapshot Find(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == id);

    [Fact]
    public void A_system_with_no_source_at_all_is_listed_as_absent_in_everything_and_counts_for_nothing()
    {
        var snapshot = Build(RegistryLoader.Load(TestPaths.LiveTown));

        var node = Find(snapshot, "aa.orders-api");
        Assert.Equal(Signals.All, node.Absent);
        Assert.Equal(0, snapshot.Totals.RequestsPerSecond);
        Assert.Equal(0, snapshot.Totals.Down + snapshot.Totals.Degraded);
    }

    [Fact]
    public void A_signal_nobody_asked_for_is_left_out_of_health_and_out_of_the_numbers()
    {
        using var copy = LiveTownWith(ShapeB);
        var registry = Prod(copy);
        NodeReading Read(DateTimeOffset at) => new(at, true, 3, 3, 0.4, 12, 0.9, 5000, Cpu: 0.99, Memory: 0.99, QueueDepth: 40, OldestMessageSeconds: 5, DeadLetters: 7);

        // errors and latency are asked for, so 90% errors and 5 s turn the building amber; the 99% cpu nobody asked for does not
        var troubled = Find(Build(registry, Read, "aa.orders-api"), "aa.orders-api");
        Assert.Equal(HealthState.Degraded, troubled.State);
        Assert.Equal(0.9, troubled.ErrorRate);
        Assert.Equal(["instances", "cpu", "memory", "utilisation", "throttled"], troubled.Absent);
        Assert.Equal(0, troubled.InstancesTotal);
        Assert.Null(troubled.Cpu);
        Assert.Null(troubled.Memory);

        // the same reading with errors and latency not asked for is a healthy building, whatever the source measured
        using var quiet = LiveTownWith(ShapeB.Replace("  errors: telemetry\n  latency: telemetry\n", "  errors: none\n  latency: none\n"));
        var calm = Find(Build(Prod(quiet), Read, "aa.orders-api"), "aa.orders-api");
        Assert.Equal(HealthState.Healthy, calm.State);
        Assert.Equal(0, calm.ErrorRate);
        Assert.Equal(0, calm.P99Ms);
        Assert.Contains("errors", calm.Absent);
        Assert.Contains("latency", calm.Absent);
    }

    [Fact]
    public void A_queue_signal_is_present_only_when_a_messaging_source_is_configured()
    {
        using var withBus = LiveTownWith(ShapeB);
        using var without = LiveTownWith(ShapeB.Replace("  messaging: { kind: servicebus, connection: \"sb-example.servicebus.windows.net\" }\n", ""));
        NodeReading Read(DateTimeOffset at) => new(at, true, 1, 1, 0, 1, 0, 10, QueueDepth: 40, OldestMessageSeconds: 5, DeadLetters: 7);

        var present = Find(Build(Prod(withBus), Read, "aa.orders-worker"), "aa.orders-worker");
        var absent = Find(Build(Prod(without), Read, "aa.orders-worker"), "aa.orders-worker");

        Assert.Equal((40.0, 7.0), (present.QueueDepth, present.DeadLetters));
        Assert.DoesNotContain("backlog", present.Absent);
        Assert.Null(absent.QueueDepth);
        Assert.Null(absent.DeadLetters);
        Assert.Contains("deadLetters", absent.Absent);
    }

    // ---- starting the sources ----

    private sealed class Recorded(SourceContext context) : IMetricSource
    {
        public SourceContext Context { get; } = context;
        public string Name => Context.Source.Name;
        public TimeSpan PollInterval => Context.Source.PollInterval;
        public TimeSpan Timeout => Context.Source.Timeout;
        public Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(Registry registry, CancellationToken ct) =>
            Task.FromResult<IReadOnlyDictionary<string, NodeReading>>(new Dictionary<string, NodeReading>());
    }

    private sealed class RecordingFactory(string kind) : IMetricSourceFactory
    {
        public string Kind { get; } = kind;
        public IMetricSource Create(SourceContext context) => new Recorded(context);
    }

    /// <summary>Records the logins asked for instead of making Azure ones.</summary>
    private sealed class Logins
    {
        public List<RegistryCredential> Made { get; } = [];
        public IEnumerable<ICredentialKind> Kinds => new[] { "azure-cli", "service-principal" }.Select(k => (ICredentialKind)new RecordedLogin(k, Made));
    }

    private sealed class RecordedLogin(string kind, List<RegistryCredential> made) : ICredentialKind
    {
        public string Kind { get; } = kind;
        public IEnumerable<string> Check(RegistryCredential credential) => [];
        public ICredentialSource Create(RegistryCredential credential) { made.Add(credential); return new TokenCredentialSource(new AzureCliCredential()); }
    }

    /// <summary>A module of test doubles: the given source factories, and the kinds below that sign in.</summary>
    private sealed class TestModule(IEnumerable<IMetricSourceFactory> factories, IEnumerable<ICredentialKind> logins) : IAdapterModule
    {
        private static readonly string[] SignIn = ["loganalytics", "resourcegraph", "azuremonitor", "servicebus"];
        public string Name => "test";

        public void Register(IAdapterRegistry registry)
        {
            foreach (var f in factories)
            {
                registry.AddSourceKind(new SourceKindInfo(f.Kind, SignIn.Contains(f.Kind) ? "azure-cli" : null));
                registry.AddSource(f);
            }
            foreach (var l in logins) registry.AddCredentialKind(l);
        }
    }

    private static AdapterCatalog Catalog(Logins logins, params string[] kinds) => new([new TestModule(kinds.Select(k => new RecordingFactory(k)), logins.Kinds)]);

    [Fact]
    public void Each_defined_source_is_started_by_the_adapter_for_its_kind_with_its_own_settings()
    {
        using var copy = LiveTownWith(ShapeA);
        var logins = new Logins();

        var set = Catalog(logins, "loganalytics", "resourcegraph", "azuremonitor").Build(RegistryLoader.Load(copy.Path).Environments.Single());

        Assert.Empty(set.Problems);
        var started = set.Sources.Cast<Recorded>().ToDictionary(s => s.Name);
        Assert.Equal([TimeSpan.FromSeconds(60)], [started["metrics"].PollInterval]);
        Assert.Equal([TimeSpan.FromSeconds(20)], [started["metrics"].Timeout]);
        Assert.Equal("reader", logins.Made.Single(l => l.Kind == "service-principal").Name);
        // the two sources without a login of their own share the Azure CLI one
        Assert.Equal(2, logins.Made.Count);
        Assert.Contains(logins.Made, l => l is { Name: "default", Kind: "azure-cli" });
        Assert.NotNull(started["inventory"].Context.Credential);
    }

    [Fact]
    public void A_source_that_does_not_sign_in_to_azure_gets_no_login()
    {
        using var copy = LiveTownWith(ShapeB);
        var logins = new Logins();

        var set = Catalog(logins, "prometheus", "servicebus").Build(RegistryLoader.Load(copy.Path).Environments.Single());

        var prometheus = set.Sources.Cast<Recorded>().Single(s => s.Name == "telemetry");
        Assert.Null(prometheus.Context.Credential);
        Assert.Equal(["default"], logins.Made.Select(l => l.Name)); // only the Service Bus one signs in
    }

    [Fact]
    public void A_kind_with_no_adapter_yet_is_reported_and_the_rest_still_start()
    {
        using var copy = LiveTownWith(ShapeA);

        var set = Catalog(new Logins(), "loganalytics").Build(RegistryLoader.Load(copy.Path).Environments.Single());

        Assert.Equal(["metrics"], set.Sources.Select(s => s.Name));
        Assert.Contains("source 'inventory' is a resourcegraph source, and no loaded adapter reads resourcegraph yet, so its signals have no data.", string.Join("\n", set.Problems));
        Assert.Equal(2, set.Problems.Count);
    }

    [Fact]
    public void A_fake_source_in_a_live_environment_is_reported_and_not_started()
    {
        using var copy = LiveTownWith("sources:\n  metrics: { kind: fake }\n");

        var set = Catalog(new Logins(), "fake").Build(RegistryLoader.Load(copy.Path).Environments.Single());

        Assert.Empty(set.Sources);
        Assert.Contains("source 'metrics' is fake, which only a demo town runs.", set.Problems.Single());
    }

    [Fact]
    public void An_adapter_that_cannot_start_does_not_stop_the_others()
    {
        using var copy = LiveTownWith(ShapeA);
        var failing = new FailingFactory("loganalytics");
        var catalog = new AdapterCatalog([new TestModule([failing, new RecordingFactory("resourcegraph"), new RecordingFactory("azuremonitor")], new Logins().Kinds)]);

        var set = catalog.Build(RegistryLoader.Load(copy.Path).Environments.Single());

        Assert.Equal(["inventory", "platform"], set.Sources.Select(s => s.Name).Order());
        Assert.Contains("source 'metrics' could not start: no workspace", set.Problems.Single());
    }

    private sealed class FailingFactory(string kind) : IMetricSourceFactory
    {
        public string Kind { get; } = kind;
        public IMetricSource Create(SourceContext context) => throw new InvalidOperationException("no workspace");
    }

    [Fact]
    public async Task The_poller_gives_up_on_a_poll_after_the_source_s_own_timeout()
    {
        var stuck = new Stuck(TimeSpan.FromMilliseconds(60));
        var poller = new SourcePoller([stuck], new RegistryHolder(RegistryLoader.Load(TestPaths.LiveTown)), new LatestState(), NullLogger<SourcePoller>.Instance);

        await poller.StartAsync(TestContext.Current.CancellationToken);
        var gaveUp = await Task.WhenAny(stuck.Cancelled.Task, Task.Delay(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken));
        await poller.StopAsync(TestContext.Current.CancellationToken);

        Assert.Same(stuck.Cancelled.Task, gaveUp);
    }

    [Fact]
    public async Task The_poller_keeps_what_a_progressive_source_published_even_when_the_poll_then_fails_and_saves_it_for_the_next_start()
    {
        var folder = Path.Combine(Path.GetTempPath(), "oc-poller-" + Guid.NewGuid().ToString("N"));
        try
        {
            var state = new LatestState();
            var source = new PublishThenFail();
            var poller = new SourcePoller([source], new RegistryHolder(RegistryLoader.Load(TestPaths.LiveTown)), state, NullLogger<SourcePoller>.Instance, new ReadingCache(folder));

            await poller.StartAsync(TestContext.Current.CancellationToken);
            await Task.WhenAny(source.Done.Task, Task.Delay(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken));
            await Task.Delay(200, TestContext.Current.CancellationToken);
            await poller.StopAsync(TestContext.Current.CancellationToken);

            Assert.Equal(["a.one"], state.Of("progressive").Keys);
            Assert.Equal(["a.one"], new ReadingCache(folder).Load("progressive").Keys);
        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }

    private sealed class PublishThenFail : IProgressiveMetricSource
    {
        public TaskCompletionSource Done { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public string Name => "progressive";
        public TimeSpan PollInterval => TimeSpan.FromMinutes(10);
        public Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(Registry registry, CancellationToken ct) => throw new InvalidOperationException("the poller must use the progressive call");

        public Task PollAsync(Registry registry, Action<IReadOnlyDictionary<string, NodeReading>> publish, CancellationToken ct)
        {
            publish(new Dictionary<string, NodeReading> { ["a.one"] = new(DateTimeOffset.UtcNow, true, 0, 0, 0, 0, 0, 0, Cpu: 0.2) });
            Done.TrySetResult();
            throw new HttpRequestException("one of the reads failed");
        }
    }

    private sealed class Stuck(TimeSpan timeout) : IMetricSource
    {
        public TaskCompletionSource Cancelled { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public string Name => "stuck";
        public TimeSpan PollInterval => TimeSpan.FromMinutes(10);
        public TimeSpan Timeout => timeout;

        public async Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(Registry registry, CancellationToken ct)
        {
            try { await Task.Delay(System.Threading.Timeout.InfiniteTimeSpan, ct); }
            catch (OperationCanceledException) { Cancelled.TrySetResult(); throw; }
            return new Dictionary<string, NodeReading>();
        }
    }

    [Fact]
    public void A_source_that_says_nothing_about_its_timeout_gets_ten_seconds()
    {
        Assert.Equal(TimeSpan.FromSeconds(10), ((IMetricSource)new Stub()).Timeout);
    }

    private sealed class Stub : IMetricSource
    {
        public string Name => "stub";
        public TimeSpan PollInterval => TimeSpan.FromSeconds(1);
        public Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(Registry registry, CancellationToken ct) => throw new NotSupportedException();
    }

    // ---- the running server ----

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    private static async Task<Snapshot> ServedBy(string registry)
    {
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("Registry:Path", registry);
            b.UseSetting("Registry:WatchSeconds", "0");
            b.UseSetting("Snapshot:IntervalSeconds", "0.2");
        });
        var client = factory.CreateClient();
        for (var i = 0; i < 100; i++)
        {
            var r = await client.GetAsync("/api/snapshot/latest");
            if (r.IsSuccessStatusCode) return (await r.Content.ReadFromJsonAsync<Snapshot>(Json))!;
            await Task.Delay(100);
        }
        throw new TimeoutException("No snapshot");
    }

    [Fact]
    public async Task A_live_server_with_no_sources_serves_every_signal_as_absent()
    {
        var snapshot = await ServedBy(TestPaths.LiveTown);

        Assert.All(snapshot.Groups.SelectMany(g => g.Nodes), n => Assert.Equal(Signals.All, n.Absent));
    }

    [Fact]
    public async Task A_live_server_tells_a_source_with_no_data_from_a_signal_with_no_source()
    {
        // telemetry is configured but no adapter for prometheus exists yet: no fresh data (grey). instances is configured nowhere: absent
        using var copy = LiveTownWith(ShapeB);

        var node = (await ServedBy(copy.Path)).Groups.SelectMany(g => g.Nodes).Single(n => n.Id == "aa.orders-api");

        Assert.Equal(HealthState.Stale, node.State);
        Assert.Equal(["instances", "cpu", "memory", "utilisation", "throttled"], node.Absent);
    }

    // ---- the connectivity check ----

    [Fact]
    public async Task The_connectivity_check_reports_every_defined_source_and_a_kind_without_a_probe_yet_is_not_a_failure()
    {
        using var copy = LiveTownWith(ShapeA);

        var result = await SourceCheck.RunAsync(copy.Path, [], TimeSpan.FromSeconds(1), TestContext.Current.CancellationToken, AzureOnly().SourceKindNames);

        Assert.Equal(["inventory", "metrics", "platform"], result.Findings.Where(f => f.Result.Status == ProbeStatus.NoProbeYet).Select(f => f.Signal).Order());
        Assert.Contains(result.Findings, f => f.Signal == "incidents" && f.Result.Status == ProbeStatus.NotConfigured);
        Assert.Equal(0, SourceCheck.ExitCode([result], strict: true));
    }

    // ---- the logins ----

    private static AzureLogin[] Azure(Func<string, string?> env) => [new AzureCliLogin(), new AzureDefaultLogin(), new AzureManagedIdentityLogin(), new AzureServicePrincipalLogin(env)];

    [Theory]
    [InlineData("azure-cli", typeof(AzureCliCredential))]
    [InlineData("default", typeof(DefaultAzureCredential))]
    [InlineData("managed-identity", typeof(ManagedIdentityCredential))]
    public void Each_kind_of_login_makes_its_azure_credential_without_signing_anyone_in(string kind, Type expected)
    {
        var made = ((AzureLogin)Azure(_ => null).Single(l => l.Kind == kind)).Credential(new RegistryCredential("c", kind, "tenant-x", null, null));

        Assert.IsType(expected, made);
    }

    [Fact]
    public void A_service_principal_reads_its_secret_from_the_environment_variable_it_names()
    {
        string? asked = null;
        var factory = new AzureServicePrincipalLogin(name => { asked = name; return "s3cret"; });

        var made = factory.Credential(new RegistryCredential("reader", "service-principal", "tenant-a", "client-a", "EXAMPLE_SECRET"));

        Assert.IsType<ClientSecretCredential>(made);
        Assert.Equal("EXAMPLE_SECRET", asked);
    }

    [Fact]
    public void A_service_principal_whose_variable_is_not_set_says_which_one_is_missing()
    {
        var factory = new AzureServicePrincipalLogin(_ => null);

        var e = Assert.Throws<InvalidOperationException>(() => factory.Credential(new RegistryCredential("reader", "service-principal", "t", "c", "EXAMPLE_SECRET")));

        Assert.Contains("credential 'reader' reads its secret from the environment variable EXAMPLE_SECRET, which is not set", e.Message);
    }

    [Fact]
    public void A_login_that_cannot_be_made_leaves_out_only_the_sources_that_use_it()
    {
        using var copy = LiveTownWith(ShapeA);
        var catalog = new AdapterCatalog([new TestModule(new[] { "loganalytics", "resourcegraph", "azuremonitor" }.Select(k => new RecordingFactory(k)), Azure(_ => null))]); // EXAMPLE_SECRET is not set

        var set = catalog.Build(RegistryLoader.Load(copy.Path).Environments.Single());

        Assert.Equal(["inventory", "metrics"], set.Sources.Select(s => s.Name).Order());
        Assert.Contains("source 'platform' could not start: credential 'reader' reads its secret from the environment variable EXAMPLE_SECRET, which is not set", set.Problems.Single());
    }

    // ---- the proof: two differently shaped configs through the same code ----

    [Fact]
    public void The_same_code_resolves_two_differently_shaped_configs_to_what_each_says()
    {
        using var a = LiveTownWith(ShapeA);
        using var b = LiveTownWith(ShapeB);
        var ra = Prod(a);
        var rb = Prod(b);
        var node = "aa.orders-api";

        string?[] Sources(Registry r) => Signals.All.Select(s => r.SourceFor(Node(r, node), s)).ToArray();
        string?[] Expect(params string?[] sources) => sources;

        // requests errors latency instances cpu memory utilisation throttled backlog deadLetters
        Assert.Equal(Expect("metrics", "metrics", "metrics", "inventory", "platform", "platform", "platform", "platform", null, null), Sources(ra));
        Assert.Equal(Expect("telemetry", "telemetry", "telemetry", null, null, null, null, null, "messaging", "messaging"), Sources(rb));
        // and each one's snapshot hides exactly what its config leaves without a source
        Assert.Equal(["backlog", "deadLetters"], Find(Build(ra), node).Absent);
        Assert.Equal(["instances", "cpu", "memory", "utilisation", "throttled"], Find(Build(rb), node).Absent);
    }

    // ---- the adapters a build has ----

    private static AdapterCatalog AzureOnly() => new([new AzureAdapters()]);

    private static IReadOnlyList<string> Check(string environment)
    {
        using var copy = LiveTownWith(environment);
        return AzureOnly().Check(RegistryLoader.Load(copy.Path).Environments.Single());
    }

    [Theory]
    [InlineData("sources:\n  metrics: { kind: loganalytic }\n", "source 'metrics' has kind 'loganalytic', which is not a kind of source this build knows. Use fake, prometheus, grafana-irm, resourcegraph, loganalytics, azuremonitor, servicebus, functionjobs. Did you mean 'loganalytics'?")]
    [InlineData("sources:\n  metrics: { kind: prometheus, credential: reader }\ncredentials:\n  reader: { kind: azure-cli }\n", "source 'metrics' names a credential, but a prometheus source does not sign in")]
    [InlineData("credentials:\n  reader: { kind: azure-clu }\n", "credential 'reader' has kind 'azure-clu'. Use azure-cli, default, managed-identity, service-principal. Did you mean 'azure-cli'?")]
    [InlineData("credentials:\n  reader: { kind: service-principal, tenantId: t }\n", "credential 'reader' is a service-principal, which needs clientId and clientSecretEnv")]
    [InlineData("credentials:\n  reader: { kind: azure-cli, clientSecretEnv: X }\n", "credential 'reader' has clientSecretEnv, which only a service-principal uses")]
    public void The_modules_loaded_say_what_is_wrong_with_a_kind_of_source_or_login(string environment, string expected)
    {
        Assert.Contains(Check(environment), p => p.StartsWith($"environments/prod.yaml: {expected}"));
    }

    [Fact]
    public void A_good_environment_passes_the_check_of_the_modules_it_needs_and_both_shapes_do()
    {
        Assert.Empty(Check(ShapeA));
        Assert.Empty(Check(ShapeB));
    }

    [Fact]
    public void A_build_without_a_module_does_not_know_its_kinds_and_logins()
    {
        using var copy = LiveTownWith(ShapeA);
        var nothing = new AdapterCatalog([]);

        var problems = nothing.Check(RegistryLoader.Load(copy.Path).Environments.Single());

        Assert.Equal(["fake", "prometheus", "grafana-irm"], nothing.SourceKindNames);
        Assert.Empty(nothing.CredentialKindNames);
        Assert.Contains(problems, p => p.Contains("source 'metrics' has kind 'loganalytics', which is not a kind of source this build knows"));
        Assert.Contains(problems, p => p.Contains("credential 'reader' has kind 'service-principal'. Use ."));
    }

    [Fact]
    public void Modules_are_loaded_from_their_own_folders_under_adapters_and_share_the_cores_types()
    {
        var loaded = AdapterLoader.LoadFrom(Path.Combine(AppContext.BaseDirectory, "adapters"));

        Assert.Empty(loaded.Problems);
        var module = Assert.Single(loaded.Modules);
        Assert.Equal("azure", module.Name);
        Assert.NotSame(typeof(AzureAdapters), module.GetType()); // its own load context, not the one the tests were loaded into
        var catalog = new AdapterCatalog(loaded.Modules);
        Assert.Contains("loganalytics", catalog.SourceKindNames);
        Assert.Equal(["azure-cli", "default", "managed-identity", "service-principal"], catalog.CredentialKindNames.Order());
    }

    [Fact]
    public void A_folder_with_no_adapters_loads_nothing_and_a_broken_one_is_reported_not_fatal()
    {
        var root = Directory.CreateTempSubdirectory().FullName;
        try
        {
            Assert.Empty(AdapterLoader.LoadFrom(Path.Combine(root, "missing")).Modules);

            var broken = Directory.CreateDirectory(Path.Combine(root, "broken")).FullName;
            File.WriteAllText(Path.Combine(broken, "Some.Adapters.dll"), "not an assembly");
            Directory.CreateDirectory(Path.Combine(root, "empty"));
            var loaded = AdapterLoader.LoadFrom(root);

            Assert.Empty(loaded.Modules);
            Assert.Contains(loaded.Problems, p => p.Contains("broken"));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public void The_host_does_not_reference_azure_it_loads_it()
    {
        var referenced = typeof(TownRuntime).Assembly.GetReferencedAssemblies().Select(a => a.Name).ToList();

        Assert.DoesNotContain("ObservabilityCity.Adapters.Azure", referenced);
        Assert.DoesNotContain("Azure.Identity", referenced);
        Assert.True(File.Exists(Path.Combine(AppContext.BaseDirectory, "adapters", "azure", "ObservabilityCity.Adapters.Azure.dll")), "the build copies the azure adapter into adapters/azure");
    }
}
