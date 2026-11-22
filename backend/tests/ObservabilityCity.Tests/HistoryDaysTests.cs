using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.History;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Host;

namespace ObservabilityCity.Tests;

/// <summary>
/// Each environment can keep its own number of days of history (<c>history.days</c> in its file): a test environment two days and prod fourteen. Without it the app's
/// <c>History:Days</c> is used for that environment.
/// </summary>
public sealed class HistoryDaysTests : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };
    private readonly string _folder = Path.Combine(Path.GetTempPath(), "history-days-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_folder, true); } catch (IOException) { }
    }

    private static RegistryCopy LiveTownWith(params (string File, string Text)[] environments)
    {
        var copy = new RegistryCopy(TestPaths.LiveTown);
        Directory.CreateDirectory(copy.FilePath("environments"));
        foreach (var (file, text) in environments) copy.Write($"environments/{file}.yaml", text);
        return copy;
    }

    [Fact]
    public void An_environment_file_can_set_its_own_days_and_one_without_them_has_none()
    {
        using var copy = LiveTownWith(("alpha", "name: Alpha\nhistory:\n  days: 2\n"), ("beta", "name: Beta\n"));

        var environments = RegistryLoader.Load(copy.Path).Environments;

        Assert.Equal(2, environments.Single(e => e.Id == "alpha").HistoryDays);
        Assert.Null(environments.Single(e => e.Id == "beta").HistoryDays);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-3)]
    [InlineData(15)]
    public void Days_outside_one_to_fourteen_are_named_with_the_file(int days)
    {
        using var copy = LiveTownWith(("alpha", $"name: Alpha\nhistory:\n  days: {days}\n"));

        var message = Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message;

        Assert.Contains($"environments/alpha.yaml: history.days is {days}; it must be 1 to 14", message);
    }

    [Fact]
    public void A_key_that_is_not_days_is_refused_in_the_history_block()
    {
        using var copy = LiveTownWith(("alpha", "name: Alpha\nhistory:\n  day: 2\n"));

        Assert.Contains("unknown key 'day'", Assert.Throws<RegistryException>(() => RegistryLoader.Load(copy.Path)).Message);
    }

    [Fact]
    public void The_options_of_an_environment_keep_the_app_settings_and_change_only_the_days()
    {
        var app = new HistoryOptions { Days = 7, IntervalSeconds = 60, Path = "kept", Enabled = true };

        var own = app.ForDays(2);

        Assert.Equal(2, own.EffectiveDays);
        Assert.Equal(TimeSpan.FromDays(2), own.Keep);
        Assert.Equal(TimeSpan.FromSeconds(60), own.Interval);
        Assert.Equal("kept", own.Path);
        Assert.Equal(7, app.ForDays(null).EffectiveDays); // no days in the file: the app's
        Assert.Equal(HistoryOptions.MaxDays, app.ForDays(30).EffectiveDays); // never over the most
        Assert.Equal(7, app.EffectiveDays); // the app's own is not touched
    }

    [Fact]
    public async Task Each_environment_serves_the_days_of_its_own_file_and_the_app_setting_where_it_has_none()
    {
        using var copy = LiveTownWith(("alpha", "name: Alpha\ndefault: true\nhistory:\n  days: 2\n"), ("beta", "name: Beta\n"));
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("Registry:Path", copy.Path);
            b.UseSetting("Registry:WatchSeconds", "0");
            b.UseSetting("Snapshot:IntervalSeconds", "0.2");
            b.UseSetting("Fake:PollInterval", "00:00:00.2");
            b.UseSetting("History:Path", _folder);
            b.UseSetting("History:Days", "5");
        });
        var environments = factory.Services.GetRequiredService<TownSet>().Default.Environments;
        var gap = TimeSpan.FromMinutes(5);
        var threeDaysAgo = new DateTimeOffset((DateTimeOffset.UtcNow - TimeSpan.FromDays(3)).UtcTicks / gap.Ticks * gap.Ticks, TimeSpan.Zero);
        // the same frame, three days old, in both: inside the five days of beta and outside the two days of alpha
        foreach (var id in new[] { "alpha", "beta" })
            environments.Find(id)!.History!.Append(threeDaysAgo, JsonNode.Parse("""{"townId":"t","totals":{"requestsPerSecond":1,"degraded":0,"down":0},"groups":[],"note":null}""")!, 0, 0);
        var client = factory.CreateClient();
        var ct = TestContext.Current.CancellationToken;

        var alpha = (await client.GetFromJsonAsync<HistoryRange>("/api/history/range?env=alpha", Json, ct))!;
        var beta = (await client.GetFromJsonAsync<HistoryRange>("/api/history/range?env=beta", Json, ct))!;

        Assert.Equal(2, alpha.Days);
        Assert.Equal(0, alpha.Frames);
        Assert.Equal(5, beta.Days);
        Assert.Equal(1, beta.Frames);
        var at = Uri.EscapeDataString(threeDaysAgo.ToString("O"));
        var tooOld = await client.GetAsync($"/api/history/frame?env=alpha&at={at}", ct);
        Assert.Equal(HttpStatusCode.NotFound, tooOld.StatusCode);
        Assert.Contains("History goes back 2 days.", await tooOld.Content.ReadAsStringAsync(ct));
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync($"/api/history/frame?env=beta&at={at}", ct)).StatusCode);
        Assert.Equal(TimeSpan.FromDays(2), environments.Find("alpha")!.HistorySettings!.Keep);
        Assert.Equal(TimeSpan.FromDays(5), environments.Find("beta")!.HistorySettings!.Keep);
    }
}
