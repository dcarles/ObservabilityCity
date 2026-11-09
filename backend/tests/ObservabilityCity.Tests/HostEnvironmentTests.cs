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
/// The running server with several environments. Each has its own source and its own stream of snapshots: steering one moves only that one,
/// and a viewer receives the environment in its address and no other.
/// </summary>
public class HostEnvironmentTests : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    private readonly WebApplicationFactory<Program> _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
    {
        b.UseSetting("Registry:Path", TestPaths.TenantsTown);
        b.UseSetting("Registry:WatchSeconds", "0");
        b.UseSetting("Snapshot:IntervalSeconds", "0.2");
        b.UseSetting("Fake:PollInterval", "00:00:00.2");
    });

    private HttpClient Client => _factory.CreateClient();

    public void Dispose() => _factory.Dispose();

    private async Task<Snapshot> Latest(string? env = null)
    {
        var client = Client;
        for (var i = 0; i < 100; i++)
        {
            var r = await client.GetAsync(env is null ? "/api/snapshot/latest" : $"/api/snapshot/latest?env={env}");
            if (r.IsSuccessStatusCode)
            {
                var s = (await r.Content.ReadFromJsonAsync<Snapshot>(Json))!;
                // the first snapshots can predate the first readings; wait for a town of data
                if (s.Groups.SelectMany(g => g.Nodes).All(n => n.State != HealthState.Stale)) return s;
            }
            await Task.Delay(100);
        }
        throw new TimeoutException($"No snapshot for {env ?? "the default environment"}");
    }

    [Fact]
    public async Task The_server_lists_its_environments_in_order_with_the_default_marked()
    {
        var list = await Client.GetFromJsonAsync<EnvironmentInfo[]>("/api/environments", Json, TestContext.Current.CancellationToken);

        Assert.NotNull(list);
        Assert.Equal(["dev", "staging", "prod"], list.Select(e => e.Id));
        Assert.Equal(["Development", "Staging", "Production"], list.Select(e => e.Name));
        Assert.Equal(["prod"], list.Where(e => e.IsDefault).Select(e => e.Id));
    }

    [Fact]
    public async Task Asking_for_no_environment_gives_the_default_and_each_name_gives_its_own_town()
    {
        var fallback = await Latest();
        var dev = await Latest("dev");
        var staging = await Latest("staging");

        Assert.Equal("prod", fallback.Environment);
        Assert.Equal(["dev", "staging", "prod"], fallback.Environments.Select(e => e.Id));
        Assert.Equal("dev", dev.Environment);
        Assert.DoesNotContain(dev.Groups, g => g.Id == "bb"); // not deployed in dev
        Assert.Contains(fallback.Groups, g => g.Id == "bb");
        Assert.Equal(["acme", "borealis", "qa", "smoke", "ghost-co"], staging.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == "aa.orders-db").Tenants!.Select(u => u.Id));
    }

    [Fact]
    public async Task An_unknown_environment_is_not_found_and_the_answer_lists_the_real_ones()
    {
        var r = await Client.GetAsync("/api/snapshot/latest?env=prd", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
        var body = await r.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        Assert.Contains("No environment 'prd'", body);
        Assert.Contains("\"prod\"", body);
        Assert.Equal(HttpStatusCode.NotFound, (await Client.GetAsync("/api/fake?env=prd", TestContext.Current.CancellationToken)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await Client.PostAsync("/api/fake/reset?env=prd", null, TestContext.Current.CancellationToken)).StatusCode);
    }

    [Fact]
    public async Task Steering_one_environment_leaves_the_others_alone()
    {
        var client = Client;
        await client.PostAsJsonAsync("/api/fake/calm?env=staging", new { on = true }, TestContext.Current.CancellationToken);
        await client.PostAsJsonAsync("/api/fake/calm?env=prod", new { on = true }, TestContext.Current.CancellationToken);
        var r = await client.PostAsJsonAsync("/api/fake/effects?env=staging", new { target = "aa.orders-db#acme", kind = "Saturate", intensity = 1.0 }, TestContext.Current.CancellationToken);
        Assert.True(r.IsSuccessStatusCode, await r.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));

        var staging = await WaitFor("staging", s => Unit(s, "acme").Throttled > 0);
        var prod = await Latest("prod");

        Assert.True(Unit(staging, "acme").Throttled > 0);
        Assert.Equal(0, Unit(prod, "acme").Throttled);
        Assert.Single((await client.GetFromJsonAsync<JsonElement>("/api/fake?env=staging", Json, TestContext.Current.CancellationToken)).GetProperty("effects").EnumerateArray());
        Assert.Empty((await client.GetFromJsonAsync<JsonElement>("/api/fake?env=prod", Json, TestContext.Current.CancellationToken)).GetProperty("effects").EnumerateArray());
        Assert.Empty((await client.GetFromJsonAsync<JsonElement>("/api/fake", Json, TestContext.Current.CancellationToken)).GetProperty("effects").EnumerateArray()); // none given: the default, prod
    }

    [Fact]
    public async Task A_tenant_effect_on_anything_but_saturation_is_refused()
    {
        var r = await Client.PostAsJsonAsync("/api/fake/effects", new { target = "aa.orders-db#acme", kind = "Errors", intensity = 1.0 }, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Contains("only DB saturated can be aimed at one tenant", await r.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
    }

    private static TenantUnitSnapshot Unit(Snapshot s, string tenant) =>
        s.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == "aa.orders-db").Tenants!.Single(u => u.Id == tenant);

    private async Task<Snapshot> WaitFor(string env, Func<Snapshot, bool> done)
    {
        for (var i = 0; i < 100; i++)
        {
            var s = await Latest(env);
            if (done(s)) return s;
            await Task.Delay(100);
        }
        throw new TimeoutException("The snapshot never showed it");
    }

    // ── the live stream ───────────────────────────────────────────────────────

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

    private HubConnection Connect(string? env) => new HubConnectionBuilder()
        .WithUrl(new Uri(_factory.Server.BaseAddress, env is null ? "/hubs/town" : $"/hubs/town?env={env}"), o =>
        {
            o.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
            o.Transports = Microsoft.AspNetCore.Http.Connections.HttpTransportType.LongPolling;
        })
        .AddJsonProtocol(o => { o.PayloadSerializerOptions.Converters.Add(new JsonStringEnumConverter()); o.PayloadSerializerOptions.PropertyNameCaseInsensitive = true; })
        .Build();

    [Fact]
    public async Task A_viewer_receives_the_environment_in_its_address_and_no_other()
    {
        await Latest("dev"); // make sure the streams are running
        var seen = new System.Collections.Concurrent.ConcurrentBag<(string Viewer, string Environment)>();
        await using var staging = Connect("staging");
        await using var fallback = Connect(null);
        staging.On<Snapshot>(TownHub.SnapshotMethod, s => seen.Add(("staging", s.Environment)));
        fallback.On<Snapshot>(TownHub.SnapshotMethod, s => seen.Add(("default", s.Environment)));

        await staging.StartAsync(TestContext.Current.CancellationToken);
        await fallback.StartAsync(TestContext.Current.CancellationToken);
        await WaitUntil(() => seen.Count(x => x.Viewer == "staging") >= 2 && seen.Count(x => x.Viewer == "default") >= 2, "both viewers had been sent a few ticks");

        Assert.Contains(seen, x => x.Viewer == "staging");
        Assert.Contains(seen, x => x.Viewer == "default");
        Assert.All(seen.Where(x => x.Viewer == "staging"), x => Assert.Equal("staging", x.Environment));
        Assert.All(seen.Where(x => x.Viewer == "default"), x => Assert.Equal("prod", x.Environment));
    }

    [Fact]
    public async Task A_viewer_naming_an_unknown_environment_is_told_so_and_gets_no_town()
    {
        var snapshots = 0;
        var told = new TaskCompletionSource<JsonElement>();
        await using var viewer = Connect("prd");
        viewer.On<Snapshot>(TownHub.SnapshotMethod, _ => Interlocked.Increment(ref snapshots));
        viewer.On<JsonElement>(TownHub.UnknownMethod, e => told.TrySetResult(e));

        await viewer.StartAsync(TestContext.Current.CancellationToken);
        var message = await told.Task.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        // nothing arrives for a wrong name, so wait for a viewer of a right one to be sent a few ticks: by then the wrong one would have been too
        var proof = 0;
        await using var watcher = Connect("staging");
        watcher.On<Snapshot>(TownHub.SnapshotMethod, _ => Interlocked.Increment(ref proof));
        await watcher.StartAsync(TestContext.Current.CancellationToken);
        await WaitUntil(() => Volatile.Read(ref proof) >= 3, "another viewer had been sent a few ticks");

        Assert.Equal("prd", message.GetProperty("requested").GetString());
        Assert.Contains("prod", message.GetProperty("environments").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal(0, snapshots); // never the default's town under another name
    }

    [Fact]
    public async Task A_connected_viewer_counts_as_looking_at_its_environment_only_until_it_leaves()
    {
        await Latest("dev");
        var towns = _factory.Services.GetRequiredService<TownSet>();
        var staging = towns.All.SelectMany(t => t.Environments.All).First(e => e.Id == "staging");
        var prod = towns.All.SelectMany(t => t.Environments.All).First(e => e.Id == "prod");
        var before = (staging.Demand.Viewers, prod.Demand.Viewers);

        var viewer = Connect("staging");
        await viewer.StartAsync(TestContext.Current.CancellationToken);
        await WaitUntil(() => staging.Demand.Viewers == before.Item1 + 1, "the server had counted the viewer");
        Assert.Equal(before.Item1 + 1, staging.Demand.Viewers);
        Assert.Equal(before.Item2, prod.Demand.Viewers); // the other environments are not looked at

        await viewer.StopAsync(TestContext.Current.CancellationToken);
        await viewer.DisposeAsync();
        await WaitUntil(() => staging.Demand.Viewers == before.Item1, "the server had counted the viewer out");
        Assert.Equal(before.Item1, staging.Demand.Viewers);
    }
}
