using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>
/// Phase 3, slice 5: a consumer's drawer links to its dead letters in the team's queue explorer, when the environment says where that is
/// (<c>entities.deadLetterLink</c>). The program knows no tool: two towns write different addresses over different words and get their own links.
/// </summary>
public class DeadLetterLinkTests
{
    private static string Town(string name) => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", $"messaging-town-{name}");

    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");

    private static async Task<Snapshot> TownSnapshot(string folder)
    {
        var registry = RegistryLoader.Load(folder).ForEnvironment("prod");
        var set = new AdapterCatalog([new AzureAdapters()]).Build(registry.ActiveEnvironment!, folder);
        Assert.Empty(set.Problems);
        var state = new LatestState();
        foreach (var source in set.Sources) state.Update(source.Name, await source.PollAsync(registry, CancellationToken.None));
        return new SnapshotBuilder(registry, state, new FakeTimeProvider(T0)) { Environment = "prod" }.Build();
    }

    private static NodeSnapshot Node(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).First(n => n.Id == id);

    [Fact]
    public async Task A_consumer_lists_each_queue_it_reads_with_a_link_to_that_queues_dead_letters()
    {
        var queues = Node(await TownSnapshot(Town("a")), "aa.orders-worker").Queues!;

        Assert.Equal(["q-al-led-to-ord", "q-al-ord-feed", "q-al-ord-in"], queues.Select(q => q.Name));
        var inbox = queues.Single(q => q.Name == "q-al-ord-in");
        Assert.Equal(("Open in queue explorer", "https://support.example.test/queues/q-al-ord-in?team=al&service=ord"), (inbox.Link!.Name, inbox.Link.Url)); // the scope codes, not the ids
        Assert.Equal(2, inbox.DeadLetters);
        Assert.Equal(150, queues.Single(q => q.Name == "q-al-led-to-ord").Backlog);
    }

    [Fact]
    public async Task Another_town_names_other_queues_another_tool_and_other_words()
    {
        var queues = Node(await TownSnapshot(Town("b")), "aa.orders-worker").Queues!;

        Assert.Equal(["bus.aa.orders.feed", "bus.aa.orders.in", "bus.bb.aa.orders.out"], queues.Select(q => q.Name));
        var link = queues.Single(q => q.Name == "bus.aa.orders.in").Link!;
        Assert.Equal(("Parked messages", "https://parked.example.test/prod/aa.orders-worker/bus.aa.orders.in"), (link.Name, link.Url));
    }

    [Theory]
    [InlineData("a", "aa.orders-api")]   // an API reads no queue
    [InlineData("a", "aa.orders-db")]
    [InlineData("b", "aa.orders-api")]
    public async Task A_system_that_reads_no_queue_lists_none(string town, string id)
    {
        Assert.Null(Node(await TownSnapshot(Town(town)), id).Queues);
    }

    [Fact]
    public async Task An_environment_that_names_no_tool_lists_the_queues_without_links()
    {
        var folder = Copy("a", yaml => System.Text.RegularExpressions.Regex.Replace(yaml, @"\s*deadLetterLink:[^\n]*\n", "\n"));
        try
        {
            var queues = Node(await TownSnapshot(folder), "aa.orders-worker").Queues!;
            Assert.Equal(3, queues.Count);
            Assert.All(queues, q => Assert.Null(q.Link));
        }
        finally { Directory.Delete(folder, true); }
    }

    [Fact]
    public async Task A_queue_name_cannot_change_the_shape_of_the_address()
    {
        var registry = RegistryLoader.Load(Town("b")).ForEnvironment("prod");
        var node = registry.AllNodes.First(n => n.Id == "aa.orders-worker");

        var link = DeadLetterLinks.For(registry, node, "a/b?c=d e#f")!;

        Assert.Equal("https://parked.example.test/prod/aa.orders-worker/a%2Fb%3Fc%3Dd%20e%23f", link.Url);
        await Task.CompletedTask;
    }

    [Fact]
    public async Task An_address_that_needs_a_word_the_system_has_none_of_gives_no_link_rather_than_a_broken_one()
    {
        // town B's systems have no service codes and no pillar code: {pillar} falls back to the id and {service} to the service name, so make it need something truly missing
        var folder = Copy("b", yaml => yaml.Replace("https://parked.example.test/{environment}/{system}/{queue}", "https://parked.example.test/{pillar}/{service}/{queue}"));
        try
        {
            var queues = Node(await TownSnapshot(folder), "aa.orders-worker").Queues!;
            Assert.Equal("https://parked.example.test/aa/orders/bus.aa.orders.in", queues.Single(q => q.Name == "bus.aa.orders.in").Link!.Url); // the service name stands in for a code that is not there
        }
        finally { Directory.Delete(folder, true); }
    }

    [Theory]
    [InlineData("https://x.example.test/{queues}", "{queues} is not a variable of the url")]
    [InlineData("ftp://x.example.test/{system}", "url must start with http:// or https://")]
    [InlineData("", "url must start with http:// or https://")]
    public void An_address_that_cannot_work_is_refused_and_says_what_is_wrong(string url, string expected)
    {
        var folder = Copy("a", yaml => yaml.Replace("https://support.example.test/queues/{queue}?team={pillar}&service={service}", url));
        try
        {
            var error = Assert.Throws<RegistryException>(() => RegistryLoader.Load(folder));
            Assert.Contains(expected, error.Message);
        }
        finally { Directory.Delete(folder, true); }
    }

    private static string Copy(string name, Func<string, string> env)
    {
        var target = Path.Combine(Path.GetTempPath(), "oc-dlq-" + Guid.NewGuid().ToString("N"));
        CopyDirectory(Town(name), target);
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
}
