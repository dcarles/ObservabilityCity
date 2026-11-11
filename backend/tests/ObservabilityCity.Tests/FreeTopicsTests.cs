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
/// Topics with names of their own (orders.created, billing.invoice.paid), several for one service, and one no service publishes. The free-topics-town
/// registry lists every topic by its name and has no template; the owner of a topic is the file that lists it, never something read from its name.
/// </summary>
public class FreeTopicsTests
{
    private static async Task<Snapshot> Run(string folder, int seconds = 3)
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.Zero));
        var registry = RegistryLoader.Load(folder);
        var state = new LatestState();
        var fake = new FakeSource(FakeProfiles.Load(folder), new FakeOptions(), clock) { Calm = true };
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

    /// <summary>The frontend's unit tests read this file too, so both sides agree on the piers and boats a town with free topic names gets.</summary>
    [Fact]
    public async Task The_free_topics_town_snapshot_matches_the_golden_fixture()
    {
        var actual = JsonSerializer.Serialize(await Run(TestPaths.FreeTopicsTown), Json).ReplaceLineEndings("\n");
        var path = Path.Combine(TestPaths.Fixtures, "free-topics-town.json");
        if (Environment.GetEnvironmentVariable("UPDATE_GOLDEN") == "1" || !File.Exists(path))
            File.WriteAllText(path, actual + "\n");

        Assert.Equal(File.ReadAllText(path).ReplaceLineEndings("\n").TrimEnd(), actual.TrimEnd());
    }

    [Fact]
    public void Topics_are_owned_by_the_file_that_lists_them()
    {
        var registry = RegistryLoader.Load(TestPaths.FreeTopicsTown);

        Assert.Equal(
            ["billing.audit bil -", "billing.invoice.paid bil billing", "orders.cancelled ord orders", "orders.created ord orders", "platform.broadcast hub -"],
            registry.Topics.Select(t => $"{t.Name} {t.GroupId} {t.Service ?? "-"}").Order(StringComparer.Ordinal));
        Assert.Equal(
            ["billing.audit bil>shp.shipping-worker", "billing.invoice.paid bil>ord.orders-worker", "orders.cancelled ord>bil.billing-worker",
             "orders.created ord>bil.billing-worker", "orders.created ord>shp.shipping-worker", "platform.broadcast hub>shp.shipping-worker"],
            registry.Subscriptions.Select(s => $"{s.Topic} {s.PublisherGroupId}>{s.ConsumerId}").Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task The_snapshot_gives_each_island_its_pier_its_boats_and_its_flow()
    {
        var s = await Run(TestPaths.FreeTopicsTown);
        var links = TownLinks.Of(RegistryLoader.Load(TestPaths.FreeTopicsTown));

        foreach (var id in new[] { "ord", "bil", "shp" }) Assert.True(links[id].HasMessaging, id);
        Assert.Equal([new TopicSnapshot("orders.created", "orders"), new TopicSnapshot("orders.cancelled", "orders")], Group(s, "ord").Messaging.Topics);
        Assert.Contains(new TopicSnapshot("billing.audit", null), Group(s, "bil").Messaging.Topics);
        Assert.Contains(new SubscriptionSnapshot("billing.invoice.paid", "bil", "ord.orders-worker"), Group(s, "ord").Messaging.Subscriptions);
        Assert.Contains(new SubscriptionSnapshot("platform.broadcast", "hub", "shp.shipping-worker"), Group(s, "shp").Messaging.Subscriptions);
        // a consumer has a queue and the fake broker's backlog
        Assert.NotNull(s.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == "shp.shipping-worker").QueueDepth);
        // what the services that publish send, and what the workers that read take in
        Assert.True(Group(s, "ord").Flow?.SentPerSecond > 0);
        Assert.True(Group(s, "shp").Flow?.ReceivedPerSecond > 0);
        Assert.Equal(0, Group(s, "shp").Flow?.SentPerSecond); // it publishes nothing
    }

    /// <summary>
    /// The same town written the old way: one topic per service named by the templates. It has fewer topics (a template cannot give one service two),
    /// but the same piers, the same boat routes from island to island and the same flows.
    /// </summary>
    [Fact]
    public async Task The_town_has_the_same_shape_as_its_twin_named_by_templates()
    {
        using var twin = new RegistryCopy(TestPaths.FreeTopicsTown);
        twin.Replace("town.yaml", "islands: [ord, bil, shp]", "messaging:\n  topicTemplate: \"{pillar}.{service}.events\"\n  hubTopicTemplate: \"platform.{service}\"\nislands: [ord, bil, shp]");
        twin.Replace("hub.yaml", "    - { topic: platform.broadcast }", "    - broadcast");
        twin.Replace("pillars/ord.yaml", "    - { topic: orders.created, service: orders }\n    - { topic: orders.cancelled, service: orders }", "    - orders");
        twin.Replace("pillars/ord.yaml", "topic: billing.invoice.paid,", "topic: bil.billing.events,");
        twin.Replace("pillars/bil.yaml", "    - { topic: billing.invoice.paid, service: billing }", "    - billing");
        twin.Replace("pillars/bil.yaml", "    - { topic: orders.created, consumer: bil.billing-worker }\n    - { topic: orders.cancelled, consumer: bil.billing-worker }", "    - { topic: ord.orders.events, consumer: bil.billing-worker }");
        twin.Replace("pillars/shp.yaml", "topic: orders.created,", "topic: ord.orders.events,");

        var free = await Run(TestPaths.FreeTopicsTown);
        var templated = await Run(twin.Path);

        static object Shape(Snapshot s) => s.Groups.Select(g => new
        {
            g.Id,
            Pier = g.Messaging.Topics.Count + g.Messaging.Subscriptions.Count > 0,
            Routes = string.Join(",", g.Messaging.Subscriptions.Select(x => $"{x.Publisher}>{x.Consumer}").Distinct().Order(StringComparer.Ordinal)),
            Publishes = g.Messaging.Topics.Count > 0,
            Flow = g.Flow is { } f ? $"{f.SentPerSecond}/{f.ReceivedPerSecond}" : "none",
        }).Select(x => x.ToString()).ToList();
        Assert.Equal(Shape(templated), Shape(free));
        Assert.Equal(TownLinks.Of(RegistryLoader.Load(twin.Path)), TownLinks.Of(RegistryLoader.Load(TestPaths.FreeTopicsTown)));
    }

    [Fact]
    public void The_free_topics_town_is_clean()
    {
        var r = RegistryValidator.Validate(TestPaths.FreeTopicsTown);

        Assert.True(r.Findings.Count == 0, string.Join("\n", r.Findings.Select(f => $"{f.File}:{f.Line} [{f.Rule}] {f.Message}")));
    }

    // ── mistakes, each with its file and line ────────────────────────────────

    private static Finding Finds(RegistryCopy copy, string text)
    {
        var r = RegistryValidator.Validate(copy.Path);
        return Assert.Single(r.Findings, f => f.Severity == Severity.Error && f.Message.Contains(text));
    }

    [Fact]
    public void A_topic_name_two_islands_list_is_reported_on_the_second()
    {
        using var copy = new RegistryCopy(TestPaths.FreeTopicsTown);
        copy.Replace("pillars/bil.yaml", "    - { topic: billing.audit }\n", "    - { topic: billing.audit }\n    - { topic: orders.created }\n");

        var hit = Finds(copy, "topic 'orders.created' is listed by 'ord' too");

        Assert.Equal(("pillars/bil.yaml", 13), (hit.File, hit.Line));
        Assert.Contains("unique in the town", Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message);
    }

    [Fact]
    public void A_topic_listed_twice_in_one_file_is_reported()
    {
        using var copy = new RegistryCopy(TestPaths.FreeTopicsTown);
        copy.Replace("pillars/bil.yaml", "    - { topic: billing.audit }\n", "    - { topic: billing.audit }\n    - { topic: billing.audit }\n");

        var hit = Finds(copy, "topic 'billing.audit' is listed twice");

        Assert.Equal(("pillars/bil.yaml", 13), (hit.File, hit.Line));
    }

    [Fact]
    public void A_subscription_to_an_unknown_topic_gets_a_did_you_mean_on_its_line()
    {
        using var copy = new RegistryCopy(TestPaths.FreeTopicsTown);
        copy.Replace("pillars/shp.yaml", "topic: billing.audit,", "topic: billing.audti,");

        var hit = Finds(copy, "subscribes to topic 'billing.audti', which no pillar publishes");

        Assert.Contains("Did you mean 'billing.audit'", hit.Message);
        Assert.Equal(("pillars/shp.yaml", 11), (hit.File, hit.Line));
    }

    [Fact]
    public void A_topic_published_by_a_service_the_island_does_not_have_is_reported()
    {
        using var copy = new RegistryCopy(TestPaths.FreeTopicsTown);
        copy.Replace("pillars/ord.yaml", "{ topic: orders.cancelled, service: orders }", "{ topic: orders.cancelled, service: ordres }");

        var hit = Finds(copy, "topic 'orders.cancelled' is published by 'ordres', which is not a service of this pillar");

        Assert.Contains("Did you mean 'orders'", hit.Message);
        Assert.Equal(("pillars/ord.yaml", 12), (hit.File, hit.Line));
        // the island is skipped, and the subscriptions to its topics are its problem, not their readers'
        Assert.DoesNotContain(RegistryValidator.Validate(copy.Path).Findings, f => f.Message.Contains("no pillar publishes"));
    }

    [Fact]
    public void A_topic_name_the_template_also_makes_is_reported()
    {
        using var copy = new RegistryCopy(TestPaths.FreeTopicsTown);
        copy.Replace("town.yaml", "islands: [ord, bil, shp]", "messaging:\n  topicTemplate: \"{service}.events\"\nislands: [ord, bil, shp]");
        copy.Replace("pillars/bil.yaml", "    - { topic: billing.audit }\n", "    - { topic: billing.audit }\n    - billing\n");
        copy.Replace("pillars/shp.yaml", "messaging:\n", "messaging:\n  topics:\n    - { topic: billing.events }\n");

        var hit = Finds(copy, "topic 'billing.events' is also the name the template in town.yaml makes for the service 'billing' of 'bil'");

        Assert.Equal(("pillars/shp.yaml", 10), (hit.File, hit.Line));
    }

    [Fact]
    public void A_template_name_that_another_island_lists_by_name_is_reported_on_the_template_entry()
    {
        using var copy = new RegistryCopy(TestPaths.FreeTopicsTown);
        copy.Replace("town.yaml", "islands: [ord, bil, shp]", "messaging:\n  topicTemplate: \"{service}.events\"\nislands: [ord, bil, shp]");
        copy.Replace("pillars/ord.yaml", "    - { topic: orders.cancelled, service: orders }\n", "    - { topic: orders.cancelled, service: orders }\n    - { topic: shipping.events }\n");
        copy.Replace("pillars/shp.yaml", "messaging:\n", "messaging:\n  topics: [shipping]\n");

        var hit = Finds(copy, "the topic of 'shipping' is called 'shipping.events' by the template in town.yaml, but 'ord' lists a topic of that name already");

        Assert.Equal(("pillars/shp.yaml", 9), (hit.File, hit.Line));
    }

    [Theory]
    [InlineData("{ topic: billing.audit }", "{ service: billing }", "a topic block needs a name")]
    [InlineData("{ topic: billing.audit }", "{ topic: \"billing audit\" }", "is not a name a broker takes")]
    [InlineData("{ topic: billing.audit }", "{ topic: \"billing.{service}\" }", "is not a name a broker takes")]
    public void A_bad_topic_block_names_the_file_and_the_problem(string from, string to, string expected)
    {
        using var copy = new RegistryCopy(TestPaths.FreeTopicsTown);
        copy.Replace("pillars/bil.yaml", from, to);

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));

        Assert.Contains("bil.yaml (line 12)", e.Message);
        Assert.Contains(expected, e.Message);
    }

    [Fact]
    public void A_misspelt_key_in_a_topic_block_is_an_error()
    {
        using var copy = new RegistryCopy(TestPaths.FreeTopicsTown);
        copy.Replace("pillars/bil.yaml", "{ topic: billing.audit }", "{ topic: billing.audit, servce: billing }");

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));

        Assert.Contains("unknown key 'servce'", e.Message);
        Assert.Contains("Did you mean 'service'", e.Message);
    }

    // ── templates ───────────────────────────────────────────────────────────

    [Fact]
    public void A_template_without_the_service_is_fine_when_every_topic_has_its_own_name()
    {
        using var copy = new RegistryCopy(TestPaths.FreeTopicsTown);
        copy.Replace("town.yaml", "islands: [ord, bil, shp]", "messaging:\n  topicTemplate: \"events\"\n  hubTopicTemplate: \"shared\"\nislands: [ord, bil, shp]");

        Assert.Equal(5, RegistryLoader.Load(copy.Path).Topics.Count);
    }

    [Fact]
    public void A_template_without_the_service_is_refused_once_a_file_lists_a_topic_by_its_service()
    {
        using var copy = new RegistryCopy(TestPaths.FreeTopicsTown);
        copy.Replace("town.yaml", "islands: [ord, bil, shp]", "messaging:\n  topicTemplate: \"events\"\nislands: [ord, bil, shp]");
        copy.Replace("pillars/bil.yaml", "    - { topic: billing.audit }\n", "    - { topic: billing.audit }\n    - billing\n");

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path));

        Assert.Contains("messaging.topicTemplate must contain {service}", e.Message);
        Assert.Contains("pillars/bil.yaml lists topic 'billing'", e.Message);
    }

    [Fact]
    public void Both_forms_can_stand_in_one_file()
    {
        using var copy = new RegistryCopy(TestPaths.FreeTopicsTown);
        copy.Replace("town.yaml", "islands: [ord, bil, shp]", "messaging:\n  topicTemplate: \"{pillar}-{service}-outbox\"\nislands: [ord, bil, shp]");
        copy.Replace("pillars/bil.yaml", "    - { topic: billing.audit }\n", "    - { topic: billing.audit }\n    - billing\n");

        var registry = RegistryLoader.Load(copy.Path);

        Assert.Equal(["bil-billing-outbox", "billing.audit", "billing.invoice.paid"], registry.Topics.Where(t => t.GroupId == "bil").Select(t => t.Name).Order(StringComparer.Ordinal));
    }

    [Theory]
    [InlineData("{pillar}-{service}-outbox", "wrk", "wrk-batch-outbox", true)]
    [InlineData("{pillar}-{service}-outbox", "wrk", "ful-orders-outbox", false)]
    [InlineData("events.{pillar}.{service}", "ord", "events.ord.orders", true)]
    [InlineData("events.{pillar}.{service}", "ord", "events.ordx.orders", false)]
    [InlineData("{service}", "ord", "ord-orders", false)] // without {pillar} no name says its owner
    public void A_name_the_template_makes_for_a_pillar_is_recognised(string template, string pillar, string name, bool expected)
    {
        Assert.Equal(expected, new MessagingConvention(template, "{service}").CouldBeTopicOf(pillar, name));
    }

    // ── a resilient load ────────────────────────────────────────────────────

    [Theory]
    [InlineData("role: worker", "role: workr")] // the file reads, but a system is wrong
    [InlineData("color: \"#e0a23a\"", "colr: \"#e0a23a\"")] // the file does not read at all
    public void A_subscription_to_a_topic_of_a_skipped_pillar_is_dropped_quietly(string from, string to)
    {
        using var copy = new RegistryCopy(TestPaths.FreeTopicsTown);
        copy.Replace("pillars/bil.yaml", from, to);

        var registry = RegistryLoader.LoadResilient(copy.Path);

        Assert.NotNull(registry.Groups.Single(g => g.Id == "bil").ConfigError);
        Assert.DoesNotContain(registry.Topics, t => t.GroupId == "bil");
        Assert.DoesNotContain(registry.Subscriptions, s => s.Topic.StartsWith("billing.", StringComparison.Ordinal));
        Assert.DoesNotContain(registry.Problems, p => p.Contains("billing.invoice.paid") || p.Contains("billing.audit"));
        // the readers' other subscriptions stay
        Assert.Contains(registry.Subscriptions, s => s.Topic == "orders.created" && s.ConsumerId == "shp.shipping-worker");
    }
}
