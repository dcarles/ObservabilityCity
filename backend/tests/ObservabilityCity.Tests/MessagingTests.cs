using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using ObservabilityCity.Validate;

namespace ObservabilityCity.Tests;

/// <summary>
/// Messaging and the link rule. A pier and boats exist only for an island with messaging; a bridge only for one with an API or a call link
/// over its coast; a building only for a role the island really has. The links-town registry has one island for each case.
/// </summary>
public class MessagingTests
{
    private sealed class Rig
    {
        public readonly FakeTimeProvider Clock = new(new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.Zero));
        public readonly Registry Registry;
        public readonly LatestState State = new();
        public readonly FakeSource Fake;
        public readonly SnapshotBuilder Builder;

        public Rig(string? folder = null)
        {
            folder ??= TestPaths.LinksTown;
            Registry = RegistryLoader.Load(folder);
            Fake = new FakeSource(FakeProfiles.Load(folder), new FakeOptions(), Clock) { Calm = true };
            Builder = new SnapshotBuilder(Registry, State, Clock);
        }

        public async Task<Snapshot> Run(int seconds = 3)
        {
            Snapshot s = null!;
            for (var i = 0; i < seconds; i++)
            {
                Clock.Advance(TimeSpan.FromSeconds(1));
                State.Update(await Fake.PollAsync(Registry, default));
                s = Builder.Build();
            }
            return s;
        }
    }

    private static GroupSnapshot Group(Snapshot s, string id) => s.Groups.Single(g => g.Id == id);
    private static NodeSnapshot Node(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == id);
    private static bool HasMessaging(GroupSnapshot g) => g.Messaging.Topics.Count + g.Messaging.Subscriptions.Count > 0;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
    };

    /// <summary>The frontend's unit tests read this file too, so both sides agree on which connectors each island gets.</summary>
    [Fact]
    public async Task The_links_town_snapshot_matches_the_golden_fixture()
    {
        var actual = JsonSerializer.Serialize(await new Rig().Run(), Json).ReplaceLineEndings("\n");
        var path = Path.Combine(TestPaths.Fixtures, "links-town.json");
        if (Environment.GetEnvironmentVariable("UPDATE_GOLDEN") == "1" || !File.Exists(path))
            File.WriteAllText(path, actual + "\n");

        Assert.Equal(File.ReadAllText(path).ReplaceLineEndings("\n").TrimEnd(), actual.TrimEnd());
    }

    // ── the link rule ───────────────────────────────────────────────────────

    [Fact]
    public void An_island_with_an_API_and_messaging_has_a_bridge_and_a_pier()
    {
        var links = TownLinks.Of(RegistryLoader.Load(TestPaths.LinksTown));

        Assert.Equal(new GroupLinks(true, true, false, true, false), links["ful"]);
    }

    [Fact]
    public void A_worker_only_island_has_a_pier_and_no_bridge()
    {
        var links = TownLinks.Of(RegistryLoader.Load(TestPaths.LinksTown));

        Assert.False(links["wrk"].HasApi);
        Assert.False(links["wrk"].HasBridge);
        Assert.True(links["wrk"].HasMessaging);
        Assert.False(links["wrk"].Standalone);
    }

    [Fact]
    public void An_island_without_messaging_has_a_bridge_and_no_pier()
    {
        var links = TownLinks.Of(RegistryLoader.Load(TestPaths.LinksTown));

        Assert.True(links["nom"].HasBridge);
        Assert.False(links["nom"].HasMessaging);
    }

    [Fact]
    public void A_call_to_a_shared_hub_database_is_enough_for_a_bridge()
    {
        var registry = RegistryLoader.Load(TestPaths.LinksTown);
        var links = TownLinks.Of(registry);

        Assert.False(links["hbk"].HasApi);
        Assert.True(links["hbk"].HasBridge);
        Assert.False(links["hbk"].HasMessaging);
        Assert.Contains("hub.customer-db", registry.AllNodes.Single(n => n.Id == "hbk.sync-cron").Calls);
    }

    [Fact]
    public void An_island_nothing_connects_stands_alone_and_the_registry_says_so()
    {
        var registry = RegistryLoader.Load(TestPaths.LinksTown);

        Assert.True(TownLinks.Of(registry)["sta"].Standalone);
        var warning = Assert.Single(registry.Warnings);
        Assert.Contains("Island 'sta' stands alone", warning);
    }

    [Fact]
    public void The_sample_town_has_no_standalone_island_and_the_warning_is_not_an_error()
    {
        Assert.Empty(RegistryLoader.Load(TestPaths.Registry).Warnings);
        // links-town loads strictly even though it has a warning
        Assert.Single(RegistryLoader.Load(TestPaths.LinksTown).Warnings);
        Assert.Empty(RegistryLoader.LoadResilient(TestPaths.LinksTown).Problems);
    }

    [Fact]
    public void The_validator_reports_a_standalone_island_as_a_warning_on_its_file()
    {
        // links-town lists the warning under expectedWarnings, so take that out to see the warning itself
        using var copy = new RegistryCopy(TestPaths.LinksTown);
        copy.Write("town.yaml", copy.Read("town.yaml").Split("# the island")[0]);
        var result = RegistryValidator.Validate(copy.Path);

        var hit = Assert.Single(result.Findings, f => f.Rule == "standalone");
        Assert.Equal(Severity.Warning, hit.Severity);
        Assert.Equal("pillars/sta.yaml", hit.File);
        Assert.Equal(0, result.Errors);
    }

    [Fact]
    public void A_gateway_call_leaving_the_island_gives_a_worker_only_island_a_bridge()
    {
        using var copy = new RegistryCopy(TestPaths.LinksTown);
        copy.Replace("pillars/wrk.yaml", "role: worker, calls: [wrk.batch-db] }", "role: worker, calls: [wrk.batch-db], gatewayCalls: [ful.orders-api] }");

        Assert.True(TownLinks.Of(RegistryLoader.Load(copy.Path))["wrk"].HasBridge);
    }

    [Fact]
    public void A_call_into_an_island_gives_it_a_bridge_too()
    {
        using var copy = new RegistryCopy(TestPaths.LinksTown);
        copy.Replace("pillars/nom.yaml", "calls: [nom.catalog-cache] }", "calls: [nom.catalog-cache, sta.idle-cron] }");

        var links = TownLinks.Of(RegistryLoader.Load(copy.Path));

        Assert.True(links["sta"].HasBridge);
        Assert.False(links["sta"].Standalone);
    }

    [Fact]
    public void A_call_to_a_third_party_connects_an_island_without_a_hub_bridge()
    {
        using var copy = new RegistryCopy(TestPaths.LinksTown);
        File.WriteAllText(copy.FilePath("third-parties.yaml"), "vendors:\n  - { id: ext.mailer, name: Mailer, calledBy: [sta.idle-cron] }\n");
        File.AppendAllText(copy.FilePath("fake.yaml"), "ext.mailer:  { rps: 5, p99Ms: 500, errorRate: 0.001 }\n");

        var registry = RegistryLoader.Load(copy.Path);
        var sta = TownLinks.Of(registry)["sta"];

        Assert.True(sta.CallsVendor);
        Assert.False(sta.HasBridge);
        Assert.False(sta.Standalone);
        Assert.Empty(registry.Warnings);
    }

    [Fact]
    public async Task The_snapshot_tells_the_renderer_which_connectors_to_build()
    {
        var s = await new Rig().Run();

        Assert.Equal(
            new[] { ("ful", true, true), ("wrk", false, true), ("nom", true, false), ("hbk", true, false), ("leg", true, true), ("sta", false, false) },
            new[] { "ful", "wrk", "nom", "hbk", "leg", "sta" }.Select(id => (id, Group(s, id).HasBridge, HasMessaging(Group(s, id)))));
        Assert.Contains(s.Notices, n => n.Contains("Island 'sta' stands alone"));
    }

    [Fact]
    public async Task Buildings_exist_only_for_roles_the_island_has()
    {
        var s = await new Rig().Run();

        // no worker, no database: just an API and a cache
        Assert.Equal([NodeKind.Api, NodeKind.Cache], Group(s, "nom").Nodes.Select(n => n.Kind).Order());
        // a worker and its database, but no API
        Assert.DoesNotContain(Group(s, "wrk").Nodes, n => n.Kind == NodeKind.Api);
        Assert.Contains(Group(s, "wrk").Nodes, n => n.Kind == NodeKind.Worker);
        Assert.DoesNotContain(Group(s, "hbk").Nodes, n => n.Kind is NodeKind.Worker or NodeKind.Database);
    }

    // ── topics and subscriptions ────────────────────────────────────────────

    [Fact]
    public void Topics_are_named_after_the_pillar_and_the_service()
    {
        var registry = RegistryLoader.Load(TestPaths.LinksTown);

        Assert.Equal(["ful-orders-outbox", "hub-egress", "wrk-batch-outbox"], registry.Topics.Select(t => t.Name).Order());
        Assert.Equal("orders", registry.Topics.Single(t => t.Name == "ful-orders-outbox").Service);
    }

    [Fact]
    public async Task Pillars_subscribe_directly_to_each_others_outboxes_and_the_egress_route_is_flagged_legacy()
    {
        var s = await new Rig().Run();

        var wrk = Group(s, "wrk").Messaging.Subscriptions.Single();
        Assert.Equal(new SubscriptionSnapshot("ful-orders-outbox", "ful", "wrk.batch-worker", false), wrk);
        var leg = Group(s, "leg").Messaging.Subscriptions.Single();
        Assert.Equal(new SubscriptionSnapshot("hub-egress", "hub", "leg.feed-worker", true), leg);
        Assert.Equal(["hub-egress"], Group(s, "hub").Messaging.Topics.Select(t => t.Name));
    }

    [Fact]
    public void The_sample_town_publishes_and_consumes_across_pillars_and_has_one_worker_only_and_one_messaging_free_pillar()
    {
        var registry = RegistryLoader.Load(TestPaths.Registry);
        var links = TownLinks.Of(registry);

        Assert.True(registry.Subscriptions.Count(s => s.PublisherGroupId != s.ConsumerGroupId) > 10);
        Assert.Contains(registry.Subscriptions, s => s is { Legacy: true, Topic: "hub-egress", ConsumerGroupId: "lost-found" });
        Assert.False(links["rcn"].HasBridge);
        Assert.True(links["rcn"].HasMessaging);
        Assert.True(links["reg"].HasBridge);
        Assert.False(links["reg"].HasMessaging);
        // every worker in the sample town consumes something
        Assert.All(registry.AllNodes.Where(n => n.Kind == NodeKind.Worker), w => Assert.Contains(w.Id, registry.ConsumerIds));
    }

    [Fact]
    public async Task Only_a_worker_with_a_subscription_has_a_queue_and_a_dead_letter_queue()
    {
        using var copy = new RegistryCopy(TestPaths.LinksTown);
        copy.Replace("pillars/ful.yaml", "    - { topic: wrk-batch-outbox, consumer: ful.orders-worker }\n", "");
        var rig = new Rig(copy.Path);

        var s = await rig.Run();

        Assert.Null(Node(s, "ful.orders-worker").QueueDepth);
        Assert.Null(Node(s, "ful.orders-worker").DeadLetters);
        Assert.NotNull(Node(s, "wrk.batch-worker").QueueDepth);
        Assert.NotNull(Node(s, "leg.feed-worker").DeadLetters);
    }

    [Fact]
    public async Task A_backlog_and_dead_letters_show_on_the_consumer_and_add_up_in_the_town_total()
    {
        var rig = new Rig();
        await rig.Run();
        Assert.Equal(0, (await rig.Run(1)).Totals.DeadLetters);

        rig.Fake.Add("wrk.batch-worker", FakeEffectKind.Backlog, 1);
        rig.Fake.Add("wrk.batch-worker", FakeEffectKind.Poison, 1);
        rig.Fake.Add("leg.feed-worker", FakeEffectKind.Poison, 1);
        var s = await rig.Run(30);

        var wrk = Node(s, "wrk.batch-worker");
        Assert.True(wrk.OldestMessageSeconds >= wrk.BacklogAmber, $"oldest {wrk.OldestMessageSeconds}");
        Assert.True(wrk.DeadLetters > 20);
        Assert.Equal(HealthState.Degraded, wrk.State);
        Assert.Equal(Node(s, "wrk.batch-worker").DeadLetters + Node(s, "leg.feed-worker").DeadLetters, s.Totals.DeadLetters);

        rig.Fake.Reset();
        Assert.Equal(0, (await rig.Run(2)).Totals.DeadLetters);
    }

    [Fact]
    public async Task A_stale_consumer_does_not_count_toward_the_dead_letter_total()
    {
        var rig = new Rig();
        await rig.Run();
        rig.Fake.Add("leg.feed-worker", FakeEffectKind.Poison, 1);
        var s = await rig.Run(10);
        Assert.True(s.Totals.DeadLetters > 0);

        rig.Fake.Add("leg.feed-worker", FakeEffectKind.Stale, 1);
        s = await rig.Run(40);

        Assert.Equal(HealthState.Stale, Node(s, "leg.feed-worker").State);
        Assert.Equal(0, s.Totals.DeadLetters);
    }

    // ── bad messaging blocks ────────────────────────────────────────────────

    [Theory]
    [InlineData("topic: wrk-batch-outbox,", "topic: wrk-batch-outbxo,", "which no pillar publishes")]
    [InlineData("topic: wrk-batch-outbox,", "topic: hub-egress,", "reads 'hub-egress' from the hub")]
    [InlineData("consumer: ful.orders-worker", "consumer: ful.orders-db", "only workers do")]
    [InlineData("consumer: ful.orders-worker", "consumer: ful.orders-wroker", "is not a system of this pillar")]
    [InlineData("consumer: ful.orders-worker", "consumer: wrk.batch-worker", "is not a system of this pillar")]
    [InlineData("topics: [orders]", "topics: [ordres]", "is not a service of this pillar")]
    [InlineData("topics: [orders]", "topics: [orders, orders]", "listed twice")]
    public void A_bad_messaging_block_names_the_file_and_the_problem(string from, string to, string expected)
    {
        using var copy = new RegistryCopy(TestPaths.LinksTown);
        copy.Replace("pillars/ful.yaml", from, to);

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));

        Assert.Contains("ful.yaml", e.Message);
        Assert.Contains(expected, e.Message);
    }

    [Fact]
    public void A_misspelt_topic_gets_a_did_you_mean()
    {
        using var copy = new RegistryCopy(TestPaths.LinksTown);
        copy.Replace("pillars/ful.yaml", "topic: wrk-batch-outbox,", "topic: wrk-batch-outbxo,");

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));

        Assert.Contains("Did you mean 'wrk-batch-outbox'", e.Message);
    }

    [Fact]
    public void Legacy_is_only_for_the_hubs_egress_topic()
    {
        using var copy = new RegistryCopy(TestPaths.LinksTown);
        copy.Replace("pillars/ful.yaml", "topic: wrk-batch-outbox, consumer: ful.orders-worker", "topic: wrk-batch-outbox, consumer: ful.orders-worker, legacy: true");

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));

        Assert.Contains("marked legacy, but only the hub's egress topic is", e.Message);
    }

    [Fact]
    public void Subscribing_twice_to_one_topic_is_refused()
    {
        using var copy = new RegistryCopy(TestPaths.LinksTown);
        copy.Replace("pillars/ful.yaml", "    - { topic: wrk-batch-outbox, consumer: ful.orders-worker }\n", "    - { topic: wrk-batch-outbox, consumer: ful.orders-worker }\n    - { topic: wrk-batch-outbox, consumer: ful.orders-worker }\n");

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));

        Assert.Contains("subscribes to 'wrk-batch-outbox' twice", e.Message);
    }

    [Fact]
    public void The_hub_cannot_subscribe()
    {
        using var copy = new RegistryCopy(TestPaths.LinksTown);
        copy.Replace("hub.yaml", "  topics: [egress]", "  topics: [egress]\n  subscriptions:\n    - { topic: ful-orders-outbox, consumer: hub.egress }");

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));

        Assert.Contains("hub.yaml: the hub has no workers", e.Message);
    }

    [Fact]
    public void A_subscription_to_a_pillar_that_was_skipped_is_dropped_quietly_in_a_resilient_load()
    {
        using var copy = new RegistryCopy(TestPaths.LinksTown);
        copy.Replace("pillars/wrk.yaml", "role: worker", "role: workr");

        var registry = RegistryLoader.LoadResilient(copy.Path);

        Assert.DoesNotContain(registry.Subscriptions, s => s.Topic == "wrk-batch-outbox");
        Assert.DoesNotContain(registry.Topics, t => t.GroupId == "wrk");
        Assert.DoesNotContain(registry.Problems, p => p.Contains("wrk-batch-outbox"));
        Assert.Equal("wrk", registry.Groups.Single(g => g.Id == "wrk").Id);
        Assert.NotNull(registry.Groups.Single(g => g.Id == "wrk").ConfigError);
    }

    [Fact]
    public void A_skipped_pillar_is_not_reported_as_standalone()
    {
        using var copy = new RegistryCopy(TestPaths.LinksTown);
        copy.Replace("pillars/wrk.yaml", "role: worker", "role: workr");

        var registry = RegistryLoader.LoadResilient(copy.Path);

        Assert.DoesNotContain(registry.Warnings, w => w.Contains("'wrk'"));
    }
}
