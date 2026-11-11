using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// A broker that spans regions (one namespace in each) says in which region a queue's dead letters are, and each region opens its own queue explorer
/// (<c>entities.deadLetterLinks</c>). The totals stay the sum of the regions. A broker in one region says nothing about regions.
/// </summary>
public class DeadLetterRegionTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "messaging-town-a");
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");

    private const string NorthTool = "deadLetterLinks:\n        - { region: northeurope, name: Support North, url: \"https://north.example.test/queues/{queue}\" }\n        - { region: westeurope, name: Support West, url: \"https://west.example.test/queues/{queue}\" }\n      ";

    /// <summary>A copy of the town whose two namespaces are in a north and a west region (or both in one), with the environment file changed by <paramref name="env"/>.</summary>
    private static string Copy(string northRegion, string westRegion, Func<string, string> env)
    {
        var target = Path.Combine(Path.GetTempPath(), "oc-region-" + Guid.NewGuid().ToString("N"));
        CopyDirectory(TownA, target);
        var inventory = Path.Combine(target, "inventory.json");
        File.WriteAllText(inventory, File.ReadAllText(inventory)
            .Replace("\"name\": \"sb-acme-northeurope1x\",", $"\"name\": \"sb-acme-northeurope1x\", \"region\": \"{northRegion}\",")
            .Replace("\"name\": \"sb-acme-westeurope9z\",", $"\"name\": \"sb-acme-westeurope9z\", \"region\": \"{westRegion}\","));
        var file = Path.Combine(target, "environments", "prod.yaml");
        File.WriteAllText(file, env(File.ReadAllText(file)));
        return target;
    }

    private static void CopyDirectory(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)));
        foreach (var d in Directory.GetDirectories(from)) CopyDirectory(d, Path.Combine(to, Path.GetFileName(d)));
    }

    private static string Answer(double north, double west, string namespaceMarker) => $$"""
        { "value": [ { "name": { "value": "DeadletteredMessages" }, "timeseries": [
            { "metadatavalues": [ { "name": { "value": "entityname" }, "value": "q-al-ord-in" } ], "data": [ { "maximum": {{(namespaceMarker == "north" ? north : west)}} } ] } ] } ] }
        """;

    private static async Task<Snapshot> Poll(string folder, double north, double west)
    {
        var registry = RegistryLoader.Load(folder, TestAdapters.Azure).ForEnvironment("prod");
        var env = registry.ActiveEnvironment!;
        var set = new AdapterCatalog([new AzureAdapters()]).Build(env, folder);
        Assert.Empty(set.Problems);
        await set.Sources.Single(s => s.Name == "inventory").PollAsync(registry, CancellationToken.None);
        var http = new CannedHttp().Respond(r => Uri.UnescapeDataString(r.Uri!.Query).Contains("metricnames=DeadletteredMessages")
            ? CannedHttp.Reply(Answer(north, west, r.Uri!.AbsolutePath.Contains("westeurope") ? "west" : "north")) : CannedHttp.Reply("""{ "value": [] }"""));
        var definition = env.Sources.Single(s => s.Name == "messaging") with { Connection = null };
        var source = new ServiceBusSourceFactory(new HttpClient(http), new FakeTimeProvider(T0)).Create(new SourceContext("prod", definition, null, env.Scope, set.Scope, folder));
        var state = new LatestState();
        state.Update("messaging", await source.PollAsync(registry, CancellationToken.None));
        return new SnapshotBuilder(registry, state, new FakeTimeProvider(T0)) { Environment = "prod" }.Build();
    }

    private static QueueSnapshot Inbox(Snapshot s) => s.Groups.SelectMany(g => g.Nodes).First(n => n.Id == "aa.orders-worker").Queues!.Single(q => q.Name == "q-al-ord-in");

    private static string WithLinks(string yaml) => yaml.Replace("deadLetterLink:", NorthTool + "deadLetterLink:");

    [Fact]
    public async Task Dead_letters_in_one_region_name_that_region_and_open_its_own_tool_while_the_total_is_the_sum()
    {
        var folder = Copy("northeurope", "westeurope", WithLinks);
        try
        {
            var queue = Inbox(await Poll(folder, north: 0, west: 8));

            Assert.Equal(8, queue.DeadLetters);
            var west = Assert.Single(queue.DeadLetterRegions!);
            Assert.Equal(("westeurope", 8.0), (west.Region, west.Count));
            Assert.Equal(("Support West", "https://west.example.test/queues/q-al-ord-in"), (west.Link!.Name, west.Link.Url));
        }
        finally { Directory.Delete(folder, true); }
    }

    [Fact]
    public async Task Dead_letters_in_both_regions_list_both_each_with_its_own_tool_and_the_total_adds_them_up()
    {
        var folder = Copy("northeurope", "westeurope", WithLinks);
        try
        {
            var queue = Inbox(await Poll(folder, north: 3, west: 8));

            Assert.Equal(11, queue.DeadLetters);
            Assert.Equal([("northeurope", 3.0, "https://north.example.test/queues/q-al-ord-in"), ("westeurope", 8.0, "https://west.example.test/queues/q-al-ord-in")],
                queue.DeadLetterRegions!.Select(r => (r.Region, r.Count, r.Link!.Url)));
        }
        finally { Directory.Delete(folder, true); }
    }

    [Fact]
    public async Task A_region_with_no_tool_of_its_own_falls_back_to_the_one_tool_for_all()
    {
        var folder = Copy("northeurope", "westeurope", yaml => yaml.Replace("deadLetterLink:", "deadLetterLinks:\n        - { region: WESTEUROPE, name: Support West, url: \"https://west.example.test/queues/{queue}\" }\n      deadLetterLink:"));
        try
        {
            var queue = Inbox(await Poll(folder, north: 3, west: 8));

            Assert.Equal("https://west.example.test/queues/q-al-ord-in", queue.DeadLetterRegions!.Single(r => r.Region == "westeurope").Link!.Url); // matched ignoring case
            Assert.StartsWith("https://support.example.test/queues/q-al-ord-in", queue.DeadLetterRegions!.Single(r => r.Region == "northeurope").Link!.Url);
        }
        finally { Directory.Delete(folder, true); }
    }

    [Fact]
    public async Task A_broker_in_one_region_says_nothing_about_regions()
    {
        var folder = Copy("northeurope", "northeurope", yaml => WithLinks(yaml).Replace("(?<region>[a-z]+)", "[a-z]+")); // the names no longer say the region: the inventory does, and says the same for both
        try
        {
            var queue = Inbox(await Poll(folder, north: 3, west: 8));

            Assert.Equal(11, queue.DeadLetters);
            Assert.Null(queue.DeadLetterRegions);
            Assert.StartsWith("https://support.example.test/", queue.Link!.Url); // the one tool for all, as before
        }
        finally { Directory.Delete(folder, true); }
    }

    [Fact]
    public async Task A_replayed_region_leaves_the_list_while_the_other_stays()
    {
        var folder = Copy("northeurope", "westeurope", WithLinks);
        try
        {
            var queue = Inbox(await Poll(folder, north: 5, west: 0));

            Assert.Equal(5, queue.DeadLetters);
            Assert.Equal("northeurope", Assert.Single(queue.DeadLetterRegions!).Region);
        }
        finally { Directory.Delete(folder, true); }
    }

    [Theory]
    [InlineData("{ region: northeurope, name: A, url: \"https://a.example.test/{queue}\" }\n        - { region: NorthEurope, name: B, url: \"https://b.example.test/{queue}\" }", "region 'NorthEurope' is given twice")]
    [InlineData("{ name: A, url: \"https://a.example.test/{queue}\" }", "region is empty")]
    [InlineData("{ region: northeurope, name: A, url: \"ftp://a.example.test/{queue}\" }", "url must start with http:// or https://")]
    [InlineData("{ region: northeurope, name: A, url: \"https://a.example.test/{nope}\" }", "{nope} is not a variable of the url")]
    [InlineData("{ region: northeurope, name: \"\", url: \"https://a.example.test/{queue}\" }", "name is empty")]
    public void A_regional_address_that_cannot_work_is_refused_and_says_what_is_wrong(string entry, string expected)
    {
        var folder = Copy("northeurope", "westeurope", yaml => yaml.Replace("deadLetterLink:", $"deadLetterLinks:\n        - {entry}\n      deadLetterLink:"));
        try
        {
            var error = Assert.Throws<RegistryException>(() => RegistryLoader.Load(folder, TestAdapters.Azure));
            Assert.Contains(expected, error.Message);
        }
        finally { Directory.Delete(folder, true); }
    }
}
