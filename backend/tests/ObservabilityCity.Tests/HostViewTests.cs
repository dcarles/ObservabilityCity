using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using ObservabilityCity.Contracts;
using ObservabilityCity.Host;

namespace ObservabilityCity.Tests;

/// <summary>
/// Slice 5 through the running server: the island filter on the REST snapshot and on the live stream (in the address and changed while connected),
/// and the inspector's two endpoints. Mini town: aa, bb, cc.
/// </summary>
public class HostViewTests : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    private readonly WebApplicationFactory<Program> _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
    {
        b.UseSetting("Registry:Path", TestPaths.MiniTown);
        b.UseSetting("Registry:WatchSeconds", "0");
        b.UseSetting("Snapshot:IntervalSeconds", "0.2");
        b.UseSetting("Fake:PollInterval", "00:00:00.2");
    });

    private HttpClient Client => _factory.CreateClient();

    public void Dispose() => _factory.Dispose();

    private async Task<T> Get<T>(string url)
    {
        var client = Client;
        for (var i = 0; i < 100; i++)
        {
            var r = await client.GetAsync(url);
            if (r.IsSuccessStatusCode)
            {
                var value = (await r.Content.ReadFromJsonAsync<T>(Json))!;
                // the first snapshots can predate the first readings
                if (value is not Snapshot s || s.Groups.SelectMany(g => g.Nodes).All(n => n.State != HealthState.Stale)) return value;
            }
            else if (r.StatusCode != HttpStatusCode.ServiceUnavailable) throw new InvalidOperationException($"{url}: {(int)r.StatusCode} {await r.Content.ReadAsStringAsync()}");
            await Task.Delay(100);
        }
        throw new TimeoutException(url);
    }

    [Fact]
    public async Task The_snapshot_endpoint_filters_by_islands()
    {
        var whole = await Get<Snapshot>("/api/snapshot/latest");
        var aa = await Get<Snapshot>("/api/snapshot/latest?islands=aa");
        var two = await Get<Snapshot>("/api/snapshot/latest?islands=cc,aa");
        var repeated = await Get<Snapshot>("/api/snapshot/latest?islands=aa&islands=cc");

        Assert.Equal(["hub", "aa", "bb", "cc"], whole.Groups.Select(g => g.Id));
        Assert.Equal(["hub", "aa"], aa.Groups.Select(g => g.Id));
        Assert.Equal(["aa"], aa.View.Islands);
        Assert.Equal(["hub", "aa", "cc"], two.Groups.Select(g => g.Id));
        Assert.Equal(["hub", "aa", "cc"], repeated.Groups.Select(g => g.Id));
        Assert.True(aa.Totals.RequestsPerSecond < whole.Totals.RequestsPerSecond);
    }

    [Fact]
    public async Task An_unknown_island_is_reported_and_an_empty_filter_means_everything()
    {
        var typo = await Get<Snapshot>("/api/snapshot/latest?islands=nope");
        var empty = await Get<Snapshot>("/api/snapshot/latest?islands=");

        Assert.Equal(["hub"], typo.Groups.Select(g => g.Id));
        Assert.Equal(["nope"], typo.View.Unknown);
        Assert.Equal(4, empty.Groups.Count);
    }

    [Fact]
    public async Task A_system_has_its_links_and_settings()
    {
        var d = await Get<SystemDetail>("/api/systems/aa.orders-api");

        Assert.Equal("Alpha", d.IslandName);
        Assert.Equal("pillars/aa.yaml", d.File);
        Assert.Contains(d.Calls, l => l.Id == "ext.bureau" && l.Kind == LinkKind.Vendor);
        Assert.Equal(SettingLayer.App, d.Config.Single(c => c.Key == "slaP99Ms").Layer);
    }

    [Fact]
    public async Task An_unknown_system_or_environment_is_not_found()
    {
        var client = Client;

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/systems/aa.nothing", TestContext.Current.CancellationToken)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/systems/aa.nothing/logs", TestContext.Current.CancellationToken)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/systems/aa.orders-api?env=prd", TestContext.Current.CancellationToken)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/systems/aa.orders-api/logs?env=prd", TestContext.Current.CancellationToken)).StatusCode);
    }

    [Fact]
    public async Task A_systems_logs_come_in_sections_newest_first()
    {
        await Get<Snapshot>("/api/snapshot/latest"); // the source has produced readings

        var logs = await Get<SystemLogs>("/api/systems/aa.orders-api/logs");

        Assert.True(logs.Configured);
        Assert.Equal(["failed", "slow", "logs", "exceptions"], logs.Sections.Select(s => s.Id));
        Assert.All(logs.Sections, s => Assert.Equal(s.Groups.OrderByDescending(g => g.At).Select(g => g.At), s.Groups.Select(g => g.At)));
    }

    // ── the live stream ───────────────────────────────────────────────────────

    private HubConnection Connect(string query = "") => new HubConnectionBuilder()
        .WithUrl(new Uri(_factory.Server.BaseAddress, $"/hubs/town{query}"), o =>
        {
            o.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
            o.Transports = Microsoft.AspNetCore.Http.Connections.HttpTransportType.LongPolling;
        })
        .AddJsonProtocol(o => { o.PayloadSerializerOptions.Converters.Add(new JsonStringEnumConverter()); o.PayloadSerializerOptions.PropertyNameCaseInsensitive = true; })
        .Build();


    /// <summary>Waits until a condition holds, up to a deadline, instead of sleeping for a fixed time and hoping.</summary>
    private static async Task WaitUntil(Func<bool> done, string what, int seconds = 15)
    {
        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (!done())
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException($"Gave up waiting until {what}");
            await Task.Delay(20);
        }
    }

    private static async Task<Snapshot> Next(System.Collections.Concurrent.ConcurrentQueue<Snapshot> seen, Func<Snapshot, bool> match)
    {
        for (var i = 0; i < 100; i++)
        {
            while (seen.TryDequeue(out var s)) if (match(s)) return s;
            await Task.Delay(100);
        }
        throw new TimeoutException("No snapshot matched");
    }

    [Fact]
    public async Task A_viewer_that_asks_for_islands_in_its_address_gets_only_those()
    {
        await Get<Snapshot>("/api/snapshot/latest");
        var seen = new System.Collections.Concurrent.ConcurrentQueue<Snapshot>();
        await using var viewer = Connect("?islands=bb");
        viewer.On<Snapshot>(TownHub.SnapshotMethod, seen.Enqueue);

        await viewer.StartAsync(TestContext.Current.CancellationToken);
        var first = await Next(seen, _ => true);
        await WaitUntil(() => seen.Count >= 3, "the viewer had been sent a few ticks"); // and it keeps getting them on every tick

        Assert.Equal(["hub", "bb"], first.Groups.Select(g => g.Id));
        Assert.Equal(["bb"], first.View.Islands);
        Assert.All(seen, s => Assert.Equal(["hub", "bb"], s.Groups.Select(g => g.Id)));
        Assert.True(seen.Count >= 2);
    }

    [Fact]
    public async Task Two_viewers_with_different_filters_each_get_their_own_town()
    {
        await Get<Snapshot>("/api/snapshot/latest");
        var a = new System.Collections.Concurrent.ConcurrentQueue<Snapshot>();
        var b = new System.Collections.Concurrent.ConcurrentQueue<Snapshot>();
        var all = new System.Collections.Concurrent.ConcurrentQueue<Snapshot>();
        await using var one = Connect("?islands=aa");
        await using var two = Connect("?islands=cc,bb");
        await using var three = Connect();
        one.On<Snapshot>(TownHub.SnapshotMethod, a.Enqueue);
        two.On<Snapshot>(TownHub.SnapshotMethod, b.Enqueue);
        three.On<Snapshot>(TownHub.SnapshotMethod, all.Enqueue);

        await one.StartAsync(TestContext.Current.CancellationToken);
        await two.StartAsync(TestContext.Current.CancellationToken);
        await three.StartAsync(TestContext.Current.CancellationToken);
        await WaitUntil(() => a.Count >= 2 && b.Count >= 2 && all.Count >= 2, "each viewer had been sent a few ticks");

        Assert.NotEmpty(a); Assert.NotEmpty(b); Assert.NotEmpty(all);
        Assert.All(a, s => Assert.Equal(["hub", "aa"], s.Groups.Select(g => g.Id)));
        Assert.All(b, s => Assert.Equal(["hub", "bb", "cc"], s.Groups.Select(g => g.Id)));
        Assert.All(all, s => Assert.Equal(4, s.Groups.Count));
    }

    [Fact]
    public async Task A_viewer_can_change_its_islands_while_connected_and_gets_the_new_town_at_once()
    {
        await Get<Snapshot>("/api/snapshot/latest");
        var seen = new System.Collections.Concurrent.ConcurrentQueue<Snapshot>();
        await using var viewer = Connect();
        viewer.On<Snapshot>(TownHub.SnapshotMethod, seen.Enqueue);
        await viewer.StartAsync(TestContext.Current.CancellationToken);
        Assert.Equal(4, (await Next(seen, _ => true)).Groups.Count);

        await viewer.InvokeAsync("SetIslands", new[] { "cc" }, TestContext.Current.CancellationToken);
        var filtered = await Next(seen, s => s.Groups.Count == 2);
        Assert.Equal(["hub", "cc"], filtered.Groups.Select(g => g.Id));
        seen.Clear();
        await WaitUntil(() => seen.Count >= 2, "the filtered town had been sent a few ticks");

        Assert.All(seen, s => Assert.Equal(["hub", "cc"], s.Groups.Select(g => g.Id))); // and no more of the whole town

        await viewer.InvokeAsync("SetIslands", new[] { "aa", "bb" }, TestContext.Current.CancellationToken);
        Assert.Equal(["hub", "aa", "bb"], (await Next(seen, s => s.Groups.Count == 3)).Groups.Select(g => g.Id));

        await viewer.InvokeAsync("SetIslands", Array.Empty<string>(), TestContext.Current.CancellationToken);
        Assert.Equal(4, (await Next(seen, s => s.Groups.Count == 4)).Groups.Count);
    }

    [Fact]
    public async Task A_viewer_that_leaves_stops_costing_a_filtered_build()
    {
        await Get<Snapshot>("/api/snapshot/latest");
        var views = (IslandViews)_factory.Services.GetService(typeof(IslandViews))!;
        await using (var viewer = Connect("?islands=aa"))
        {
            await viewer.StartAsync(TestContext.Current.CancellationToken);
            // the server registers the view a moment after the socket opens
            await WaitUntil(() => views.InUse("mini-town/demo").Count > 0, "the server had counted the viewer");
            Assert.Single(views.InUse("mini-town/demo"));
        }

        await WaitUntil(() => views.InUse("mini-town/demo").Count == 0, "the server had counted the viewer out");
        Assert.Empty(views.InUse("mini-town/demo"));
    }

    [Fact]
    public void An_island_filter_is_cleaned_up_before_use_blanks_and_repeats_go_and_the_order_is_fixed()
    {
        Assert.Equal(["aa", "bb", "cc"], ObservabilityCity.Host.IslandViews.Parse(["cc, bb", " aa ", "aa", ",,", "  "]));
        Assert.Empty(ObservabilityCity.Host.IslandViews.Parse(null));
        Assert.Empty(ObservabilityCity.Host.IslandViews.Parse([",", " "]));
        // a thousand names are still just a list: nothing is built for the ones the town does not have
        var many = ObservabilityCity.Host.IslandViews.Parse([string.Join(',', Enumerable.Range(0, 1000).Select(i => $"x{i}"))]);
        Assert.Equal(1000, many.Count);
    }

    [Fact]
    public async Task An_island_the_town_does_not_have_is_named_in_the_answer_and_left_out_and_the_rest_is_still_drawn()
    {
        await Get<Snapshot>("/api/snapshot/latest");

        var filtered = await Get<Snapshot>("/api/snapshot/latest?islands=aa,nowhere,aa");

        Assert.Equal(["hub", "aa"], filtered.Groups.Select(g => g.Id));
        Assert.Equal(["nowhere"], filtered.View.Unknown);
        Assert.Equal(["aa"], filtered.View.Islands);

        // only unknown names: the hub alone (a rule in the plan's "Rules and why"), and the unknown names are still reported
        var none = await Get<Snapshot>("/api/snapshot/latest?islands=nowhere");
        Assert.Equal(["hub"], none.Groups.Select(g => g.Id));
        Assert.Equal(["nowhere"], none.View.Unknown);
    }

    [Fact]
    public async Task Dismissing_a_health_report_the_town_does_not_list_is_answered_not_found_whatever_the_body_says()
    {
        await Get<Snapshot>("/api/snapshot/latest");
        var client = Client;

        var unknown = await client.PostAsJsonAsync("/api/health-events/dismiss", new { id = "/subscriptions/x/none" }, TestContext.Current.CancellationToken);
        var empty = await client.PostAsJsonAsync("/api/health-events/dismiss", new { }, TestContext.Current.CancellationToken);
        var wrongEnvironment = await client.PostAsJsonAsync("/api/health-events/dismiss?env=nowhere", new { id = "x" }, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        Assert.Contains("No such health report", await unknown.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        Assert.Equal(HttpStatusCode.NotFound, empty.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, wrongEnvironment.StatusCode);
    }
}
