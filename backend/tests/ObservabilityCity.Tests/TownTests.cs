using Microsoft.AspNetCore.Hosting;
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

/// <summary>The server runs more than one town: the sample ones in the repo's config folder, or the folders it is told about.</summary>
public class TownTests : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    private static WebApplicationFactory<Program> Host(Action<IWebHostBuilder> configure) => new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
    {
        b.UseSetting("Registry:WatchSeconds", "0");
        b.UseSetting("Snapshot:IntervalSeconds", "0.2");
        b.UseSetting("Fake:PollInterval", "00:00:00.2");
        configure(b);
    });

    private readonly List<IDisposable> _owned = [];
    public void Dispose() => _owned.ForEach(o => o.Dispose());

    /// <summary>The small town as the default, the direct-topology one beside it.</summary>
    private HttpClient TwoSmallTowns()
    {
        var factory = Host(b =>
        {
            b.UseSetting("Registry:Path", TestPaths.MiniTown);
            b.UseSetting("Registry:Towns:0", TestPaths.DirectTown);
        });
        _owned.Add(factory);
        return factory.CreateClient();
    }

    private static async Task<Snapshot> Latest(HttpClient client, string query)
    {
        for (var i = 0; i < 100; i++)
        {
            var r = await client.GetAsync($"/api/snapshot/latest{query}");
            if (r.IsSuccessStatusCode)
            {
                var s = (await r.Content.ReadFromJsonAsync<Snapshot>(Json))!;
                if (s.Groups.SelectMany(g => g.Nodes).All(n => n.State != HealthState.Stale)) return s;
            }
            await Task.Delay(100);
        }
        throw new TimeoutException($"No snapshot for {query}");
    }

    [Fact]
    public async Task A_server_told_one_folder_runs_one_town()
    {
        var factory = Host(b => b.UseSetting("Registry:Path", TestPaths.MiniTown));
        _owned.Add(factory);

        var towns = await factory.CreateClient().GetFromJsonAsync<TownSummary[]>("/api/towns", Json, TestContext.Current.CancellationToken);

        var only = Assert.Single(towns!);
        Assert.Equal(new TownSummary("mini-town", "Mini Town", true), only);
    }

    [Fact]
    public async Task Folders_named_in_the_settings_become_towns_and_the_first_is_the_default()
    {
        var client = TwoSmallTowns();

        var towns = await client.GetFromJsonAsync<TownSummary[]>("/api/towns", Json, TestContext.Current.CancellationToken);

        Assert.Equal(["mini-town", "direct-town"], towns!.Select(t => t.Id));
        Assert.Equal(["mini-town"], towns!.Where(t => t.IsDefault).Select(t => t.Id));
    }

    [Fact]
    public async Task The_sample_config_folder_holds_two_towns_with_Galactic_Credit_first()
    {
        var factory = Host(_ => { });
        _owned.Add(factory);

        var towns = await factory.CreateClient().GetFromJsonAsync<TownSummary[]>("/api/towns", Json, TestContext.Current.CancellationToken);

        Assert.Equal("galactic-credit", towns![0].Id);
        Assert.True(towns[0].IsDefault);
        Assert.Contains(towns, t => t is { Id: "droid-shop", Name: "Droid Shop", IsDefault: false });
    }

    [Fact]
    public async Task An_address_without_a_town_gets_the_default_and_one_with_a_town_gets_that_town()
    {
        var client = TwoSmallTowns();

        var plain = await Latest(client, "");
        var direct = await Latest(client, "?town=direct-town");

        Assert.Equal("mini-town", plain.TownId);
        Assert.Equal("hub-and-spoke", plain.Topology);
        Assert.Equal("direct-town", direct.TownId);
        Assert.Equal("direct", direct.Topology);
    }

    [Fact]
    public async Task A_town_the_server_does_not_have_is_not_found_and_never_falls_back_to_another()
    {
        var client = TwoSmallTowns();

        foreach (var url in new[] { "/api/snapshot/latest?town=nope", "/api/environments?town=nope", "/api/fake?town=nope", "/api/systems/aa.orders-api?town=nope" })
        {
            var r = await client.GetAsync(url, TestContext.Current.CancellationToken);
            Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
            Assert.Contains("No town 'nope'", await r.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        }
    }

    [Fact]
    public async Task Steering_one_town_leaves_the_other_alone()
    {
        var client = TwoSmallTowns();
        await Latest(client, "");
        await Latest(client, "?town=direct-town");

        // both towns have a system with this id in this pillar; only the one steered may change
        var post = await client.PostAsJsonAsync("/api/fake/effects?town=direct-town", new { target = "aa.orders-api", kind = "Down", intensity = 1 }, TestContext.Current.CancellationToken);
        post.EnsureSuccessStatusCode();
        await Task.Delay(1500, TestContext.Current.CancellationToken);
        var steered = await Latest(client, "?town=direct-town");
        var other = await Latest(client, "");

        Assert.Equal(HealthState.Down, steered.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == "aa.orders-api").State);
        Assert.NotEqual(HealthState.Down, other.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == "aa.orders-api").State);
        Assert.Empty((await client.GetFromJsonAsync<System.Text.Json.Nodes.JsonNode>("/api/fake", Json, TestContext.Current.CancellationToken))!["effects"]!.AsArray());
    }

    [Fact]
    public async Task A_viewer_connects_to_the_town_in_its_address_and_gets_no_snapshots_of_a_town_that_does_not_exist()
    {
        var factory = Host(b =>
        {
            b.UseSetting("Registry:Path", TestPaths.MiniTown);
            b.UseSetting("Registry:Towns:0", TestPaths.DirectTown);
        });
        _owned.Add(factory);
        var handler = factory.Server.CreateHandler();
        HubConnection Connect(string query) => new HubConnectionBuilder()
            .WithUrl($"http://localhost/hubs/town{query}", o => { o.HttpMessageHandlerFactory = _ => handler; o.Transports = Microsoft.AspNetCore.Http.Connections.HttpTransportType.LongPolling; })
            .AddJsonProtocol(o => o.PayloadSerializerOptions.Converters.Add(new JsonStringEnumConverter()))
            .Build();

        var good = new TaskCompletionSource<Snapshot>();
        var bad = new TaskCompletionSource<JsonElement>();
        var strayed = false;
        await using var direct = Connect("?town=direct-town");
        direct.On<Snapshot>(TownHub.SnapshotMethod, s => good.TrySetResult(s));
        await using var nowhere = Connect("?town=nope");
        nowhere.On<Snapshot>(TownHub.SnapshotMethod, _ => strayed = true);
        nowhere.On<JsonElement>(TownHub.UnknownMethod, e => bad.TrySetResult(e));
        await direct.StartAsync(TestContext.Current.CancellationToken);
        await nowhere.StartAsync(TestContext.Current.CancellationToken);

        var snapshot = await good.Task.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        var unknown = await bad.Task.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        await Task.Delay(700, TestContext.Current.CancellationToken);

        Assert.Equal("direct-town", snapshot.TownId);
        Assert.Equal("nope", unknown.GetProperty("requestedTown").GetString());
        Assert.Contains("direct-town", unknown.GetProperty("towns").EnumerateArray().Select(t => t.GetString()));
        Assert.False(strayed);
    }
}
