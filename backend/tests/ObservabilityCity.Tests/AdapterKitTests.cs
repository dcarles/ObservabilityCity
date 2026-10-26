using System.Net;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>The kit for adapter authors: canned HTTP, a fixed login, a private copy of a town, and the contract every adapter has to pass.</summary>
public class AdapterKitTests
{
    // ---- canned HTTP ----

    [Fact]
    public async Task Canned_http_answers_in_order_repeats_the_last_and_remembers_what_it_was_asked()
    {
        var canned = new CannedHttp().Answer("{\"n\":1}").Answer("{\"n\":2}", HttpStatusCode.Accepted);
        using var http = new HttpClient(canned);

        var first = await http.GetStringAsync("https://example.test/a", TestContext.Current.CancellationToken);
        var second = await http.PostAsync("https://example.test/b", new StringContent("{\"q\":\"x\"}"), TestContext.Current.CancellationToken);
        var third = await http.GetAsync("https://example.test/c", TestContext.Current.CancellationToken);

        Assert.Equal("{\"n\":1}", first);
        Assert.Equal(HttpStatusCode.Accepted, second.StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, third.StatusCode); // the last answer repeats
        Assert.Equal(["/a", "/b", "/c"], canned.Sent.Select(s => s.Uri!.AbsolutePath));
        Assert.Equal("x", canned.Sent[1].Json.GetProperty("q").GetString());
        Assert.Equal(HttpMethod.Post, canned.Sent[1].Method);
    }

    [Fact]
    public async Task Canned_http_can_decide_by_the_request_and_says_so_when_it_has_no_answer()
    {
        using var decided = new HttpClient(new CannedHttp().Respond(r => CannedHttp.Reply(r.Uri!.Query)));
        Assert.Equal("?x=1", await decided.GetStringAsync("https://example.test/?x=1", TestContext.Current.CancellationToken));

        using var silent = new HttpClient(new CannedHttp());
        var e = await Assert.ThrowsAsync<InvalidOperationException>(() => silent.GetStringAsync("https://example.test/", TestContext.Current.CancellationToken));
        Assert.Contains("no answer", e.Message);
    }

    [Fact]
    public async Task A_static_login_gives_one_token_and_remembers_the_scopes()
    {
        var login = new StaticLogin("t");

        Assert.Equal("t", await login.GetTokenAsync("https://scope.example.test/.default", TestContext.Current.CancellationToken));
        Assert.Equal(["https://scope.example.test/.default"], login.Scopes);
    }

    // ---- a private copy of a town ----

    [Fact]
    public void A_town_copy_can_be_changed_without_touching_the_original_and_is_deleted_after()
    {
        string path;
        using (var town = new TownFiles(TestPaths.LiveTown))
        {
            path = town.Path;
            town.Write("environments/prod.yaml", "name: Production\nsources:\n  metrics: { kind: prometheus, connection: \"https://prom.example.test\" }\n");

            Assert.Equal("Production", town.Load("prod").ActiveEnvironment!.Name);
            Assert.False(File.Exists(Path.Combine(TestPaths.LiveTown, "environments", "prod.yaml")));
        }

        Assert.False(Directory.Exists(path));
    }

    // ---- the contract: what a good adapter passes ----

    [Fact]
    public void The_azure_module_keeps_the_contract()
    {
        AdapterContract.AssertModule(new AzureAdapters());
    }

    [Fact]
    public async Task The_inventory_source_keeps_the_contract_against_a_recording()
    {
        var folder = Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "scope-town-a");
        var view = RegistryLoader.Load(folder).ForEnvironment("prod");
        var source = new ResourceGraphSourceFactory().Create(new SourceContext("prod", new RegistrySource("inventory", "resourcegraph", "file:inventory.json"), null, view.ActiveEnvironment!.Scope, new ScopeStore(), folder));

        await AdapterContract.AssertPollAsync(source, RegistryLoader.Load(folder));
    }

    // ---- the contract: what it refuses ----

    private sealed class Module(string name, Action<IAdapterRegistry> register) : IAdapterModule
    {
        public string Name => name;
        public void Register(IAdapterRegistry registry) => register(registry);
    }

    private sealed class Factory(string kind) : IMetricSourceFactory
    {
        public string Kind => kind;
        public IMetricSource Create(SourceContext context) => throw new NotSupportedException();
    }

    [Fact]
    public void A_module_with_a_bad_name_a_bad_kind_and_two_factories_for_one_kind_is_refused_with_every_reason()
    {
        var problems = AdapterContract.CheckModule(new Module("My Module", r => { r.AddSource(new Factory("Bad_Kind")); r.AddSource(new Factory("twice")); r.AddSource(new Factory("twice")); }));

        Assert.Contains(problems, p => p.Contains("'My Module'") && p.Contains("kebab-case"));
        Assert.Contains(problems, p => p.Contains("'Bad_Kind'"));
        Assert.Contains(problems, p => p.Contains("two factories") && p.Contains("'twice'"));
    }

    [Fact]
    public void A_module_that_adds_nothing_or_throws_when_registering_is_refused()
    {
        Assert.Contains(AdapterContract.CheckModule(new Module("empty", _ => { })), p => p.Contains("adds nothing"));
        Assert.Contains(AdapterContract.CheckModule(new Module("eager", _ => throw new HttpRequestException("reached out"))), p => p.Contains("Register threw") && p.Contains("reached out"));
    }

    [Fact]
    public void An_assert_lists_every_problem_in_one_exception()
    {
        var e = Assert.Throws<ContractViolation>(() => AdapterContract.AssertModule(new Module("Bad Name", _ => { })));

        Assert.Equal(2, e.Problems.Count);
        Assert.Contains("2 rule(s)", e.Message);
    }

    private sealed class Source(Func<TownRegistry, CancellationToken, Task<IReadOnlyDictionary<string, NodeReading>>> poll, TimeSpan? interval = null, TimeSpan? timeout = null) : IMetricSource
    {
        public string Name => "test";
        public TimeSpan PollInterval => interval ?? TimeSpan.FromSeconds(30);
        public TimeSpan Timeout => timeout ?? TimeSpan.FromSeconds(10);
        public Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct) => poll(registry, ct);
    }

    private static NodeReading Reading(Func<NodeReading, NodeReading>? change = null)
    {
        var good = new NodeReading(DateTimeOffset.UtcNow, true, 3, 3, 0.4, 12, 0.01, 120, Cpu: 0.4);
        return change is null ? good : change(good);
    }

    private static Task<IReadOnlyDictionary<string, NodeReading>> Readings(params (string Id, NodeReading Reading)[] items) =>
        Task.FromResult<IReadOnlyDictionary<string, NodeReading>>(items.ToDictionary(i => i.Id, i => i.Reading));

    private static readonly TownRegistry Town = RegistryLoader.Load(TestPaths.LiveTown);

    [Fact]
    public async Task A_source_that_answers_for_known_systems_with_sane_numbers_passes()
    {
        var problems = await AdapterContract.CheckPollAsync(new Source((_, _) => Readings(("aa.orders-api", Reading()))), Town);

        Assert.Empty(problems);
    }

    [Fact]
    public async Task A_source_is_refused_for_inventing_systems_and_for_numbers_that_mean_nothing()
    {
        var bad = Reading(r => r with { At = default, InstancesHealthy = 5, ErrorRate = 2, RequestsPerSecond = -1, Cpu = 1.5, DeadLetters = -3 });

        var problems = await AdapterContract.CheckPollAsync(new Source((_, _) => Readings(("nowhere.thing", Reading()), ("aa.orders-api", bad))), Town);

        Assert.Contains(problems, p => p.Contains("'nowhere.thing'") && p.Contains("does not have"));
        Assert.Contains(problems, p => p.StartsWith("aa.orders-api: At is not set"));
        Assert.Contains(problems, p => p.Contains("InstancesHealthy is 5 of 3"));
        Assert.Contains(problems, p => p.Contains("ErrorRate is 2"));
        Assert.Contains(problems, p => p.Contains("RequestsPerSecond is -1"));
        Assert.Contains(problems, p => p.Contains("Cpu is 1.5"));
        Assert.Contains(problems, p => p.Contains("DeadLetters is -3"));
    }

    [Fact]
    public async Task A_source_with_no_interval_or_timeout_is_refused()
    {
        var problems = await AdapterContract.CheckPollAsync(new Source((_, _) => Readings(), TimeSpan.Zero, TimeSpan.Zero), Town);

        Assert.Contains(problems, p => p.Contains("PollInterval"));
        Assert.Contains(problems, p => p.Contains("Timeout"));
    }

    [Fact]
    public async Task A_source_that_ignores_cancellation_is_refused_and_one_that_throws_is_named()
    {
        var hangs = new Source(async (_, _) => { await Task.Delay(TimeSpan.FromSeconds(30)); return new Dictionary<string, NodeReading>(); });
        var throws = new Source((_, _) => throw new InvalidOperationException("no good"));

        Assert.Contains(await AdapterContract.CheckPollAsync(hangs, Town, TimeSpan.FromMilliseconds(300)), p => p.Contains("honour the cancellation token"));
        Assert.Contains(await AdapterContract.CheckPollAsync(throws, Town), p => p.Contains("the poll threw InvalidOperationException: no good"));
    }
}
