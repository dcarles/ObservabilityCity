using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>
/// A queue's row links to the queue's own page in the cloud portal, when the environment names a template (<c>entities.queueLink</c>): one link for each namespace that
/// holds the queue, made from that namespace's resource id. The program knows no portal; the template says where the address goes.
/// </summary>
public class QueueLinkTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "messaging-town-a");
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");

    private const string Template = "https://portal.example.test/#@{directory}/resource{namespaceResourceId}/queues/{queue}/overview"; // as the town's environment file has it

    /// <summary>A copy of the town whose two namespaces are in a north and a west region, with the environment file changed by <paramref name="env"/>.</summary>
    private static string Copy(Func<string, string> env)
    {
        var target = Path.Combine(Path.GetTempPath(), "oc-qlink-" + Guid.NewGuid().ToString("N"));
        CopyDirectory(TownA, target);
        var inventory = Path.Combine(target, "inventory.json");
        File.WriteAllText(inventory, File.ReadAllText(inventory)
            .Replace("\"name\": \"sb-acme-northeurope1x\",", "\"name\": \"sb-acme-northeurope1x\", \"region\": \"northeurope\",")
            .Replace("\"name\": \"sb-acme-westeurope9z\",", "\"name\": \"sb-acme-westeurope9z\", \"region\": \"westeurope\","));
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

    private static string WithoutLink(string yaml) => string.Join("\n", yaml.ReplaceLineEndings("\n").Split('\n').Where(l => !l.TrimStart().StartsWith("queueLink:")));

    private static async Task<QueueSnapshot> Inbox(string folder)
    {
        var registry = RegistryLoader.Load(folder, TestAdapters.Azure).ForEnvironment("prod");
        var env = registry.ActiveEnvironment!;
        var set = new AdapterCatalog([new AzureAdapters()]).Build(env, folder);
        Assert.Empty(set.Problems);
        await set.Sources.Single(s => s.Name == "inventory").PollAsync(registry, CancellationToken.None);
        var http = new CannedHttp().Respond(r => Uri.UnescapeDataString(r.Uri!.Query).Contains("metricnames=DeadletteredMessages")
            ? CannedHttp.Reply("""{ "value": [ { "name": { "value": "DeadletteredMessages" }, "timeseries": [ { "metadatavalues": [ { "name": { "value": "entityname" }, "value": "q-al-ord-in" } ], "data": [ { "maximum": 1 } ] } ] } ] }""")
            : CannedHttp.Reply("""{ "value": [] }"""));
        var definition = env.Sources.Single(s => s.Name == "messaging") with { Connection = null };
        var source = new ServiceBusSourceFactory(new HttpClient(http), new FakeTimeProvider(T0)).Create(new SourceContext("prod", definition, null, env.Scope, set.Scope, folder));
        var state = new LatestState();
        state.Update("messaging", await source.PollAsync(registry, CancellationToken.None));
        var snapshot = new SnapshotBuilder(registry, state, new FakeTimeProvider(T0)) { Environment = "prod" }.Build();
        return snapshot.Groups.SelectMany(g => g.Nodes).First(n => n.Id == "aa.orders-worker").Queues!.Single(q => q.Name == "q-al-ord-in");
    }

    [Fact]
    public async Task A_queue_in_the_namespaces_of_two_regions_gets_one_link_for_each_made_from_that_namespaces_id()
    {
        var folder = Copy(yaml => yaml);
        try
        {
            var queue = await Inbox(folder);

            Assert.Equal(
                [("Azure queue", "northeurope", "https://portal.example.test/#@example.test/resource/subscriptions/00000000-0000-0000-0000-0000000000a9/resourceGroups/rg/providers/microsoft.servicebus/namespaces/sb-acme-northeurope1x/queues/q-al-ord-in/overview"),
                 ("Azure queue", "westeurope", "https://portal.example.test/#@example.test/resource/subscriptions/00000000-0000-0000-0000-0000000000a9/resourceGroups/rg/providers/microsoft.servicebus/namespaces/sb-acme-westeurope9z/queues/q-al-ord-in/overview")],
                queue.QueueLinks!.Select(l => (l.Name, l.Label!, l.Url)));
        }
        finally { Directory.Delete(folder, true); }
    }

    [Fact]
    public async Task An_environment_that_names_no_template_gives_no_links_and_keeps_the_support_tool_link()
    {
        var folder = Copy(WithoutLink);
        try
        {
            var queue = await Inbox(folder);

            Assert.Null(queue.QueueLinks);
            Assert.NotNull(queue.Link);
        }
        finally { Directory.Delete(folder, true); }
    }

    [Theory]
    [InlineData("https://x.example.test/{queues}", "{queues} is not a variable of the url")]
    [InlineData("ftp://x.example.test/{queue}", "url must start with http:// or https://")]
    [InlineData("", "url must start with http:// or https://")]
    public void An_address_that_cannot_work_is_refused_and_says_what_is_wrong(string url, string expected)
    {
        var folder = Copy(yaml => yaml.Replace(Template, url));
        try
        {
            var error = Assert.Throws<RegistryException>(() => RegistryLoader.Load(folder, TestAdapters.Azure));
            Assert.Contains(expected, error.Message);
        }
        finally { Directory.Delete(folder, true); }
    }
}
