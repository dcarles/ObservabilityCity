using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc.Testing;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using ObservabilityCity.Host;
using ObservabilityCity.Validate;

namespace ObservabilityCity.Tests;

/// <summary>demo or live: set in town.yaml, missing means live. Only a demo town has a fake source, the steering endpoints, and (on the page) Break things and the story bar.</summary>
public class TownModeTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    // ---- reading it ----

    [Fact]
    public void A_town_that_does_not_say_is_live()
    {
        var registry = RegistryLoader.Load(TestPaths.LiveTown);

        Assert.Equal("live", registry.Town.Mode);
        Assert.False(registry.Town.IsDemo);
    }

    [Fact]
    public void A_town_that_says_demo_is_a_demo()
    {
        var registry = RegistryLoader.Load(TestPaths.MiniTown);

        Assert.Equal("demo", registry.Town.Mode);
        Assert.True(registry.Town.IsDemo);
    }

    [Theory]
    [InlineData("config/galactic-credit")]
    [InlineData("shared-test-data/registries/mini-town")]
    [InlineData("shared-test-data/registries/links-town")]
    [InlineData("shared-test-data/registries/direct-town")]
    [InlineData("shared-test-data/registries/tenants-town")]
    [InlineData("shared-test-data/registries/stress-23")]
    [InlineData("shared-test-data/registries/wide-town")]
    [InlineData("shared-test-data/registries/stress-35")]
    public void Every_demo_town_in_the_repo_says_so(string folder)
    {
        Assert.True(RegistryLoader.Load(Path.Combine(TestPaths.RepoRoot, folder)).Town.IsDemo);
    }

    [Fact]
    public void A_mode_that_is_not_known_stops_the_load_and_suggests_the_right_one()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("town.yaml", "mode: demo", "mode: dmo");

        var e = Assert.Throws<RegistryException>(() => RegistryLoader.Load(f.Path));

        Assert.Contains("town.yaml: mode 'dmo' is not known. Use demo or live", e.Message);
        Assert.Contains("demo", e.Message[(e.Message.IndexOf("Use", StringComparison.Ordinal))..]);
    }

    [Fact]
    public async Task The_snapshot_says_which_mode_the_server_runs_in_and_a_reload_cannot_change_it()
    {
        var registry = RegistryLoader.Load(TestPaths.MiniTown);
        var state = new LatestState();
        var clock = TimeProvider.System;

        Assert.Equal("demo", new SnapshotBuilder(registry, state, clock).Build().Mode);
        Assert.Equal("live", new SnapshotBuilder(registry, state, clock) { Mode = "live" }.Build().Mode);
        await Task.CompletedTask;
    }

    // ---- validating it ----

    [Fact]
    public void A_town_with_demo_files_that_is_not_set_to_demo_is_an_error_on_town_yaml()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("town.yaml", "mode: demo\n", "");

        var r = RegistryValidator.Validate(f.Path);

        var hit = Assert.Single(r.Findings, x => x.Rule == "mode");
        Assert.Equal(Severity.Error, hit.Severity);
        Assert.Equal("town.yaml", hit.File);
        Assert.Contains("mode: demo", hit.Message);
    }

    [Fact]
    public void Saying_live_out_loud_with_demo_files_is_the_same_error_and_without_them_is_fine()
    {
        using var f = new RegistryCopy(TestPaths.MiniTown);
        f.Replace("town.yaml", "mode: demo", "mode: live");
        Assert.Contains(RegistryValidator.Validate(f.Path).Findings, x => x.Rule == "mode");

        File.Delete(f.FilePath("fake.yaml"));
        Directory.Delete(f.FilePath("stories"), true);
        Assert.DoesNotContain(RegistryValidator.Validate(f.Path).Findings, x => x.Rule == "mode");
    }

    [Fact]
    public void A_demo_town_and_a_live_town_without_demo_files_are_clean()
    {
        Assert.Empty(RegistryValidator.Validate(TestPaths.MiniTown).Findings);
        Assert.Empty(RegistryValidator.Validate(TestPaths.LiveTown).Findings);
    }

    // ---- running it ----

    private static WebApplicationFactory<Program> Host(string registry) => new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
    {
        b.UseSetting("Registry:Path", registry);
        b.UseSetting("Registry:WatchSeconds", "0");
        b.UseSetting("Snapshot:IntervalSeconds", "0.2");
        b.UseSetting("Fake:PollInterval", "00:00:00.2");
    });

    private static async Task<Snapshot> Latest(HttpClient client)
    {
        for (var i = 0; i < 100; i++)
        {
            var r = await client.GetAsync("/api/snapshot/latest");
            if (r.IsSuccessStatusCode) return (await r.Content.ReadFromJsonAsync<Snapshot>(Json))!;
            await Task.Delay(100);
        }
        throw new TimeoutException("No snapshot");
    }

    [Fact]
    public async Task A_demo_server_has_the_steering_endpoints_and_says_demo()
    {
        using var factory = Host(TestPaths.MiniTown);
        var client = factory.CreateClient();

        Assert.Equal("demo", (await Latest(client)).Mode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/fake")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/fake/stories")).StatusCode);
    }

    [Fact]
    public async Task A_live_server_says_live_and_has_no_steering_endpoints_at_all()
    {
        using var factory = Host(TestPaths.LiveTown);
        var client = factory.CreateClient();

        Assert.Equal("live", (await Latest(client)).Mode);
        foreach (var path in new[] { "/api/fake", "/api/fake/stories", "/api/fake/story" })
            Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(path)).StatusCode);
        var effect = await client.PostAsJsonAsync("/api/fake/effects", new { target = "*", kind = "Down", intensity = 1 });
        Assert.Equal(HttpStatusCode.NotFound, effect.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync("/api/fake/reset", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync("/api/fake/story/stop", null)).StatusCode);
    }

    [Fact]
    public async Task A_live_town_with_no_sources_shows_no_data_never_healthy_and_the_time_of_day_is_real()
    {
        using var factory = Host(TestPaths.LiveTown);
        var client = factory.CreateClient();
        await Task.Delay(800);

        var s = await Latest(client);

        Assert.All(s.Groups.SelectMany(g => g.Nodes), n => Assert.Equal(HealthState.Stale, n.State));
        Assert.Empty(s.Groups.SelectMany(g => g.Incidents));
        var expected = DateTimeOffset.Now.TimeOfDay.TotalDays;
        Assert.InRange(Math.Abs(s.DayFraction - expected), 0, 0.01);
        // the inspector's logs say the environment has none set up, instead of failing or showing empty sections
        var node = s.Groups.SelectMany(g => g.Nodes).First();
        var logs = await client.GetAsync($"/api/systems/{node.Id}/logs");
        Assert.Equal(HttpStatusCode.OK, logs.StatusCode);
        var answer = (await logs.Content.ReadFromJsonAsync<SystemLogs>(Json))!;
        Assert.False(answer.Configured);
        Assert.Empty(answer.Sections);
    }
}
