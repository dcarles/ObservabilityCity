using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>
/// A hub with several of each kind: two gateways, two brokers, two databases and one egress (multi-hub-town). Each is its own building; the traffic stays
/// single: an island has one pier whatever the brokers, its numbers are the sum over all of them (a topic belongs to an island, never to a broker), and the
/// town's totals count every gateway and every consumer.
/// </summary>
public class MultiHubTests
{
    private static string Town => TestPaths.MultiHubTown;

    private static async Task<Snapshot> Run(Action<FakeSource>? arrange = null, int seconds = 3)
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.Zero));
        var registry = RegistryLoader.Load(Town);
        var state = new LatestState();
        var fake = new FakeSource(FakeProfiles.Load(Town), new FakeOptions(), clock) { Calm = true };
        arrange?.Invoke(fake);
        var builder = new SnapshotBuilder(registry, state, clock);
        Snapshot s = null!;
        for (var i = 0; i < seconds; i++)
        {
            clock.Advance(TimeSpan.FromSeconds(1));
            state.Update(await fake.PollAsync(registry, default));
            s = builder.Build();
        }
        return s;
    }

    private static GroupSnapshot Group(Snapshot s, string id) => s.Groups.Single(g => g.Id == id);

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
    };

    /// <summary>The frontend's tests can read this file, so both sides agree on what a hub with several buildings of a kind looks like.</summary>
    [Fact]
    public async Task The_multi_hub_town_snapshot_matches_the_golden_fixture()
    {
        var actual = JsonSerializer.Serialize(await Run(), Json).ReplaceLineEndings("\n");
        var path = Path.Combine(TestPaths.Fixtures, "multi-hub-town.json");
        if (Environment.GetEnvironmentVariable("UPDATE_GOLDEN") == "1" || !File.Exists(path))
            File.WriteAllText(path, actual + "\n");

        Assert.Equal(File.ReadAllText(path).ReplaceLineEndings("\n").TrimEnd(), actual.TrimEnd());
    }

    [Fact]
    public async Task Every_hub_system_is_its_own_building()
    {
        var hub = Group(await Run(), "hub");

        Assert.Equal(
            [("hub.public-gateway", NodeKind.Gateway), ("hub.partner-gateway", NodeKind.Gateway), ("hub.event-broker", NodeKind.Broker), ("hub.task-broker", NodeKind.Broker),
             ("hub.egress", NodeKind.Egress), ("hub.customer-db", NodeKind.Database), ("hub.reference-db", NodeKind.Database)],
            hub.Nodes.Select(n => (n.Id, n.Kind)));
        Assert.All(hub.Nodes, n => Assert.Equal(HealthState.Healthy, n.State));
        Assert.All(hub.Nodes.Where(n => n.Kind == NodeKind.Gateway), n => Assert.True(n.RequestsPerSecond > 0));
    }

    [Fact]
    public async Task The_town_totals_count_every_gateway()
    {
        var s = await Run();
        var gateways = Group(s, "hub").Nodes.Where(n => n.Kind == NodeKind.Gateway).ToList();

        Assert.Equal(2, gateways.Count);
        // the headline p99 is weighted over every request-serving building, both gateways among them
        var serving = s.Groups.SelectMany(g => g.Nodes).Where(n => n.Kind is NodeKind.Api or NodeKind.Gateway).ToList();
        Assert.Equal(serving.Sum(n => n.P99Ms * n.RequestsPerSecond) / serving.Sum(n => n.RequestsPerSecond), s.Totals.P99Ms, 6);
        Assert.Equal(s.Groups.SelectMany(g => g.Nodes).Sum(n => n.RequestsPerSecond), s.Totals.RequestsPerSecond, 6);
    }

    [Fact]
    public async Task One_broken_gateway_is_seen_while_the_other_is_healthy()
    {
        var s = await Run(f => f.Add("hub.partner-gateway", FakeEffectKind.Down, 1));
        var hub = Group(s, "hub");

        Assert.Equal(HealthState.Down, hub.Nodes.Single(n => n.Id == "hub.partner-gateway").State);
        Assert.Equal(HealthState.Healthy, hub.Nodes.Single(n => n.Id == "hub.public-gateway").State);
        Assert.Equal(1, s.Totals.Down);
    }

    [Fact]
    public void Topics_belong_to_islands_and_none_to_the_hub_or_a_broker()
    {
        var registry = RegistryLoader.Load(Town);

        Assert.Equal([("ord.orders.events", "ord"), ("pay.payments.events", "pay"), ("stk.stock.events", "stk")], registry.Topics.Select(t => (t.Name, t.GroupId)).Order());
        Assert.DoesNotContain(registry.Topics, t => t.GroupId == "hub");
    }

    [Fact]
    public async Task Each_island_has_one_pier_and_one_bridge_whatever_the_brokers()
    {
        var registry = RegistryLoader.Load(Town);
        var links = TownLinks.Of(registry);
        var s = await Run();

        foreach (var id in new[] { "ord", "pay", "stk" })
        {
            Assert.True(links[id].HasMessaging);
            Assert.True(links[id].HasBridge);
            var g = Group(s, id);
            Assert.NotNull(g.Flow); // one flow for the island, not one per broker
            Assert.True(g.HasBridge);
        }
        Assert.Null(Group(s, "hub").Flow);
        Assert.Empty(Group(s, "hub").Messaging.Topics);
    }

    [Fact]
    public async Task An_islands_messages_are_the_sum_of_what_it_sends_and_reads_on_every_broker()
    {
        var s = await Run();
        var stk = Group(s, "stk");
        var worker = stk.Nodes.Single(n => n.Id == "stk.stock-worker");

        // the stock worker reads one topic from each other island; its island receives what it reads once, not once per topic or broker
        Assert.Equal(["ord.orders.events", "pay.payments.events"], stk.Messaging.Subscriptions.Select(x => x.Topic).Order());
        Assert.Equal(Math.Round(worker.RequestsPerSecond, 3), stk.Flow!.ReceivedPerSecond!.Value, 3);
        // and sends what the systems of the service that publishes its one topic do, on whichever broker carries it
        Assert.Equal(Math.Round(stk.Nodes.Where(n => n.Service == "stock").Sum(n => n.RequestsPerSecond), 3), stk.Flow.SentPerSecond!.Value, 3);
    }

    [Fact]
    public async Task Dead_letters_add_up_across_islands_and_brokers()
    {
        var s = await Run(f =>
        {
            f.Add("ord.orders-worker", FakeEffectKind.Poison, 1);
            f.Add("stk.stock-worker", FakeEffectKind.Poison, 0.5);
        }, seconds: 5);
        var consumers = new[] { "ord.orders-worker", "pay.payments-worker", "stk.stock-worker" }
            .Select(id => s.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == id)).ToList();

        Assert.True(consumers[0].DeadLetters > 0);
        Assert.True(consumers[2].DeadLetters > 0);
        Assert.Equal(consumers.Sum(n => n.DeadLetters ?? 0), s.Totals.DeadLetters);
        Assert.True(s.Totals.DeadLetters > consumers.Max(n => n.DeadLetters ?? 0));
        // the brokers themselves hold no dead letters: they belong to the island that reads the topic
        Assert.All(Group(s, "hub").Nodes.Where(n => n.Kind == NodeKind.Broker), n => Assert.Null(n.DeadLetters));
    }
}
