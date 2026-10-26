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

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/systems/aa.nothing")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/systems/aa.nothing/logs")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/systems/aa.orders-api?env=prd")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/systems/aa.orders-api/logs?env=prd")).StatusCode);
    }

    [Fact]
    public async Task A_systems_logs_come_newest_first_and_respect_the_limit()
    {
        await Get<Snapshot>("/api/snapshot/latest"); // the source has produced readings

        var logs = await Get<LogLine[]>("/api/systems/aa.orders-api/logs?limit=7");

        Assert.Equal(7, logs.Length);
        Assert.Equal(logs.OrderByDescending(l => l.At).Select(l => l.At), logs.Select(l => l.At));
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

        await viewer.StartAsync();
        var first = await Next(seen, _ => true);
        await Task.Delay(700); // and it keeps getting them on every tick

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

        await one.StartAsync();
        await two.StartAsync();
        await three.StartAsync();
        await Task.Delay(1000);

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
        await viewer.StartAsync();
        Assert.Equal(4, (await Next(seen, _ => true)).Groups.Count);

        await viewer.InvokeAsync("SetIslands", new[] { "cc" });
        var filtered = await Next(seen, s => s.Groups.Count == 2);
        Assert.Equal(["hub", "cc"], filtered.Groups.Select(g => g.Id));
        seen.Clear();
        await Task.Delay(700);
        Assert.NotEmpty(seen);
        Assert.All(seen, s => Assert.Equal(["hub", "cc"], s.Groups.Select(g => g.Id))); // and no more of the whole town

        await viewer.InvokeAsync("SetIslands", new[] { "aa", "bb" });
        Assert.Equal(["hub", "aa", "bb"], (await Next(seen, s => s.Groups.Count == 3)).Groups.Select(g => g.Id));

        await viewer.InvokeAsync("SetIslands", Array.Empty<string>());
        Assert.Equal(4, (await Next(seen, s => s.Groups.Count == 4)).Groups.Count);
    }

    [Fact]
    public async Task A_viewer_that_leaves_stops_costing_a_filtered_build()
    {
        await Get<Snapshot>("/api/snapshot/latest");
        var views = (IslandViews)_factory.Services.GetService(typeof(IslandViews))!;
        await using (var viewer = Connect("?islands=aa"))
        {
            await viewer.StartAsync();
            Assert.Single(views.InUse("mini-town/demo"));
        }

        for (var i = 0; i < 50 && views.InUse("mini-town/demo").Count > 0; i++) await Task.Delay(100);
        Assert.Empty(views.InUse("mini-town/demo"));
    }
}
