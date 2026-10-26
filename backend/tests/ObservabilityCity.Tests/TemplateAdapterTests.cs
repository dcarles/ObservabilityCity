using System.Net;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;
using Template.Adapters;

namespace ObservabilityCity.Tests;

/// <summary>
/// The adapter template, tested the way an author tests a real adapter: the contract, then the adapter's own behaviour against canned answers. It is here
/// so the template is built and run with every change to the core and cannot rot. Copy this file with the template.
/// </summary>
public class TemplateAdapterTests
{
    private const string Environment = """
        name: Production
        sources:
          telemetry: { kind: example-http, connection: "https://metrics.example.test/readings", pollSeconds: 15, timeoutSeconds: 5 }
        signals: { requests: telemetry, errors: telemetry, latency: telemetry, instances: telemetry, cpu: telemetry }
        """;

    private const string Answer = """
        { "systems": {
            "aa.orders-api":    { "requestsPerSecond": 12, "errorRate": 0.01, "p99Ms": 120, "instances": 3, "instancesHealthy": 2, "cpu": 0.4 },
            "aa.orders-worker": { "requestsPerSecond": 0,  "errorRate": 0,    "p99Ms": 0,   "instances": 1, "instancesHealthy": 1 },
            "somewhere.else":   { "requestsPerSecond": 1,  "errorRate": 0,    "p99Ms": 1,   "instances": 1, "instancesHealthy": 1 } } }
        """;

    private static TownFiles Town()
    {
        var town = new TownFiles(TestPaths.LiveTown);
        town.Write("environments/prod.yaml", Environment);
        return town;
    }

    private static IMetricSource SourceOver(TownFiles town, CannedHttp http) =>
        new ExampleHttpSourceFactory(new HttpClient(http), new Microsoft.Extensions.Time.Testing.FakeTimeProvider(DateTimeOffset.Parse("2026-01-01T00:00:00Z")))
            .Create(new SourceContext("prod", town.Load("prod").ActiveEnvironment!.Sources.Single(), null));

    [Fact]
    public void The_module_keeps_the_contract_and_adds_its_kind()
    {
        AdapterContract.AssertModule(new TemplateAdapters());
        var catalog = new AdapterCatalog([new TemplateAdapters()]);

        Assert.Contains("example-http", catalog.SourceKindNames);
        using var town = Town();
        Assert.Empty(catalog.Check(RegistryLoader.Load(town.Path).Environments.Single()));
    }

    [Fact]
    public async Task The_source_keeps_the_contract()
    {
        using var town = Town();

        await AdapterContract.AssertPollAsync(SourceOver(town, CannedHttp.Always(Answer)), RegistryLoader.Load(town.Path));
    }

    [Fact]
    public async Task The_source_reads_the_address_it_was_given_and_turns_the_answer_into_readings()
    {
        using var town = Town();
        var http = CannedHttp.Always(Answer);
        var source = SourceOver(town, http);

        var readings = await source.PollAsync(RegistryLoader.Load(town.Path), TestContext.Current.CancellationToken);

        Assert.Equal("https://metrics.example.test/readings", http.Sent.Single().Uri!.ToString());
        Assert.Equal(TimeSpan.FromSeconds(15), source.PollInterval);
        Assert.Equal(TimeSpan.FromSeconds(5), source.Timeout);
        var api = readings["aa.orders-api"];
        Assert.Equal((12, 0.01, 120, 3, 2, 0.4), (api.RequestsPerSecond, api.ErrorRate, api.P99Ms, api.InstancesTotal, api.InstancesHealthy, api.Cpu));
        Assert.True(api.Up);
        Assert.Null(readings["aa.orders-worker"].Cpu); // a source that does not know leaves it null, never zero
    }

    [Fact]
    public async Task A_system_the_answer_does_not_mention_has_no_reading_and_one_the_registry_does_not_have_is_left_out()
    {
        using var town = Town();

        var readings = await SourceOver(town, CannedHttp.Always(Answer)).PollAsync(RegistryLoader.Load(town.Path), TestContext.Current.CancellationToken);

        Assert.DoesNotContain("aa.orders-db", readings.Keys);
        Assert.DoesNotContain("somewhere.else", readings.Keys);
    }

    [Fact]
    public async Task A_source_that_cannot_be_read_throws_so_the_readings_go_stale_instead_of_looking_fresh()
    {
        using var town = Town();
        var source = SourceOver(town, CannedHttp.Always("{}", HttpStatusCode.ServiceUnavailable));

        await Assert.ThrowsAsync<HttpRequestException>(() => source.PollAsync(RegistryLoader.Load(town.Path), TestContext.Current.CancellationToken));
    }

    [Fact]
    public void A_connection_that_is_not_an_address_keeps_the_source_from_starting_and_says_why()
    {
        using var town = Town();
        town.Write("environments/prod.yaml", Environment.Replace("https://metrics.example.test/readings", "not an address"));

        var set = new AdapterCatalog([new TemplateAdapters()]).Build(RegistryLoader.Load(town.Path).Environments.Single());

        Assert.Empty(set.Sources);
        Assert.Contains(set.Problems, p => p.Contains("connection must be the address to read"));
    }

    [Fact]
    public void The_catalog_builds_the_source_from_the_environment_file()
    {
        using var town = Town();

        var set = new AdapterCatalog([new TemplateAdapters()]).Build(RegistryLoader.Load(town.Path).Environments.Single());

        Assert.Empty(set.Problems);
        Assert.IsType<ExampleHttpSource>(set.Sources.Single());
    }
}
