using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// What a pillar sends to the others and receives from them comes from the broker entities the environment's <c>flows</c> patterns pick out, as the rate of their
/// throughput metric over the source's window. The program knows no entity name: two towns with differently shaped patterns give the same flows.
/// </summary>
public class PillarFlowTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "messaging-town-a");
    private static string TownB => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "messaging-town-b");
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(10);

    private static TownRegistry Prod(string folder) => RegistryLoader.Load(folder).ForEnvironment("prod");

    private static readonly IReadOnlyList<EntityFlow> ShapeA = [new(@"^(?<pillar>[a-z]+)-out$", "sent"), new(@"^(?<pillar>[a-z]+)-in$", "received")];
    private static readonly IReadOnlyList<EntityFlow> ShapeB = [new(@"^out\.(?<pillar>[a-z]+)$", "sent"), new(@"^in\.(?<pillar>[a-z]+)\.all$", "received")];

    [Fact]
    public void Two_differently_shaped_patterns_give_the_same_flows()
    {
        // town A names a pillar by its code (al, be); town B by its id (aa, bb)
        var a = ServiceBusSource.PillarFlows(Prod(TownA), ShapeA, new Dictionary<string, double> { ["al-out"] = 6000, ["be-in"] = 1200 }, Window);
        var b = ServiceBusSource.PillarFlows(Prod(TownB), ShapeB, new Dictionary<string, double> { ["out.aa"] = 6000, ["in.bb.all"] = 1200 }, Window);

        Assert.Equal(new PillarFlowReading(10, null, 600), a["aa"]);
        Assert.Equal(new PillarFlowReading(null, 2, 600), a["bb"]);
        Assert.Equal(a.Select(kv => (kv.Key, kv.Value)), b.Select(kv => (kv.Key, kv.Value)));
    }

    [Fact]
    public void Entities_of_one_pillar_add_up_and_an_unknown_pillar_or_a_plain_entity_is_left_out()
    {
        var arrived = new Dictionary<string, double> { ["al-out"] = 600, ["AL-out"] = 0, ["zz-out"] = 999, ["q-al-ord-in"] = 300, ["al-in"] = 0 };

        var flows = ServiceBusSource.PillarFlows(Prod(TownA), ShapeA, arrived, Window);

        Assert.Equal(new PillarFlowReading(1, 0, 600), flows["aa"]); // a measured 0 is kept: nothing moved, which is not the same as unmeasured
        Assert.Single(flows);
    }

    [Fact]
    public void Without_flows_in_the_config_nothing_is_reported()
    {
        Assert.Empty(ServiceBusSource.PillarFlows(Prod(TownA), null, new Dictionary<string, double> { ["al-out"] = 600 }, Window));
        Assert.Empty(ServiceBusSource.PillarFlows(Prod(TownA), [], new Dictionary<string, double> { ["al-out"] = 600 }, Window));
    }

    [Fact]
    public void The_hub_is_never_given_a_flow_and_a_second_pillar_code_names_the_pillar_by_id_too()
    {
        var flows = ServiceBusSource.PillarFlows(Prod(TownA), ShapeA, new Dictionary<string, double> { ["aa-out"] = 60, ["hub-out"] = 60 }, Window);

        Assert.Equal(["aa"], flows.Keys);
    }

    private static string WithFlows(string flows)
    {
        var copy = new RegistryCopy(TownA);
        var file = copy.FilePath(Path.Combine("environments", "prod.yaml"));
        File.WriteAllText(file, File.ReadAllText(file).Replace("      throughput: { metric: IncomingMessages, aggregation: total }\n", "      throughput: { metric: IncomingMessages, aggregation: total }\n" + flows));
        _copies.Add(copy);
        return copy.Path;
    }

    private static readonly List<RegistryCopy> _copies = [];

    [Fact]
    public void Flows_are_read_from_the_environment_file()
    {
        var path = WithFlows("      flows:\n        - { match: '^(?<pillar>[a-z]+)-out$', direction: sent }\n        - { match: '^(?<pillar>[a-z]+)-in$', direction: Received }\n");

        var flows = RegistryLoader.Load(path).ForEnvironment("prod").ActiveEnvironment!.Sources.Single(s => s.Name == "messaging").Entities!.Flows!;

        Assert.Equal(["sent", "received"], flows.Select(f => f.Direction));
    }

    [Theory]
    [InlineData("      flows:\n        - { match: '^(?<pillar>[a-z]+)-out$', direction: sentt }\n", "direction 'sentt'. Use sent or received")]
    [InlineData("      flows:\n        - { match: '^[a-z]+-out$', direction: sent }\n", "no group named 'pillar'")]
    [InlineData("      flows:\n        - { match: '^(?<pillar>[a-z+-out$', direction: sent }\n", "not a valid regular expression")]
    public void A_flow_with_a_wrong_direction_or_no_pillar_group_is_a_config_error(string flows, string message)
    {
        var path = WithFlows(flows);

        var ex = Assert.Throws<RegistryException>(() => RegistryLoader.Load(path));

        Assert.Contains(message, ex.Message);
    }

    [Fact]
    public void Flows_without_a_throughput_metric_are_a_config_error()
    {
        var copy = new RegistryCopy(TownA);
        var file = copy.FilePath(Path.Combine("environments", "prod.yaml"));
        File.WriteAllText(file, File.ReadAllText(file).Replace("      throughput: { metric: IncomingMessages, aggregation: total }\n", "      flows:\n        - { match: '^(?<pillar>[a-z]+)-out$', direction: sent }\n"));
        _copies.Add(copy);

        var ex = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));

        Assert.Contains("flows need a throughput metric", ex.Message);
    }

    [Fact]
    public void The_snapshot_gives_each_pillar_its_flow_and_leaves_it_out_when_the_reading_is_old_or_absent()
    {
        var registry = Prod(TownA);
        var state = new LatestState();
        state.Update("messaging", new Dictionary<string, NodeReading>
        {
            [NodeReading.FlowKey("aa")] = new(T0, true, 0, 0, 0, 0, 0, 0, Flow: new PillarFlowReading(10, 0, 600)),
            [NodeReading.FlowKey("bb")] = new(T0 - TimeSpan.FromHours(1), true, 0, 0, 0, 0, 0, 0, Flow: new PillarFlowReading(5, 5, 600)),
        });
        var snapshot = new SnapshotBuilder(registry, state, new FakeTimeProvider(T0)) { Environment = "prod", SourceIntervals = new Dictionary<string, TimeSpan> { ["messaging"] = TimeSpan.FromSeconds(60) } }.Build();

        Assert.Equal(new PillarFlowSnapshot(10, 0, 600), snapshot.Groups.Single(g => g.Id == "aa").Flow);
        Assert.Null(snapshot.Groups.Single(g => g.Id == "bb").Flow); // an hour old
        Assert.All(snapshot.Groups.Where(g => g.IsHub), g => Assert.Null(g.Flow));
        Assert.DoesNotContain(snapshot.Groups.SelectMany(g => g.Nodes), n => n.Id.StartsWith("flow:")); // a pillar's flow is not a building
    }
}
