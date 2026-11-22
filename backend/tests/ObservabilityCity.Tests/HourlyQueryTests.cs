using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// The hourly forms of the Log Analytics queries (the region query and the job query): a rebuilt hour asks them once instead of once for each of its twelve frames, and every
/// frame gets the same answer the per-frame query would have given.
/// </summary>
public class HourlyQueryTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "function-town-a");
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");
    private const string Workspace = "00000000-0000-0000-0000-00000000c0de";

    private static string Table(string[] columns, IEnumerable<object?[]> rows) =>
        JsonSerializer.Serialize(new { tables = new[] { new { name = "PrimaryResult", columns = columns.Select(n => new { name = n, type = "string" }), rows } } });

    // ---- the region query ----

    [Fact]
    public async Task The_region_query_is_asked_once_for_the_hour_and_each_frame_gets_the_share_of_its_own_bin()
    {
        var registry = RegistryLoader.Load(TownA).ForEnvironment("prod");
        var env = registry.ActiveEnvironment!;
        var regions = Table(["role", "region", "calls", "at"],
        [
            ["OrdersApi", "northeurope", 900, "2025-12-30T09:00:00Z"], ["OrdersApi", "westeurope", 100, "2025-12-30T09:00:00Z"],
            ["OrdersApi", "northeurope", 100, "2025-12-30T09:05:00Z"], ["OrdersApi", "westeurope", 900, "2025-12-30T09:05:00Z"],
        ]);
        var main = File.ReadAllText(Path.Combine(TownA, "telemetry.json"));
        var http = new CannedHttp().Respond(r => CannedHttp.Reply(r.Json.GetProperty("query").GetString()!.Contains("RANGE-REGIONS") ? regions : main));
        var definition = env.Sources.Single(s => s.Name == "telemetry") with
        {
            Connection = Workspace,
            Typed = AzureSettings.None with { RegionQuery = "AppRequests | summarize calls = sum(ItemCount) by role = AppRoleName, region = \"x\"", RegionRangeQuery = "RANGE-REGIONS | summarize calls = sum(ItemCount) by role = AppRoleName, region = \"x\", at = bin(TimeGenerated, {window})" },
        };
        var source = (LogAnalyticsSource)new LogAnalyticsSourceFactory(new HttpClient(http), new FakeTimeProvider(T0)).Create(new SourceContext("prod", definition, null, env.Scope, new ScopeStore(), TownA));
        var loaded = RegistryLoader.Load(TownA);

        var first = await source.PollAtAsync(loaded, DateTimeOffset.Parse("2025-12-30T09:05:00Z"), CancellationToken.None);
        var second = await source.PollAtAsync(loaded, DateTimeOffset.Parse("2025-12-30T09:10:00Z"), CancellationToken.None);

        var asked = http.Sent.Where(r => r.Json.GetProperty("query").GetString()!.Contains("RANGE-REGIONS")).ToList();
        Assert.Equal("2025-12-30T09:00:00Z/2025-12-30T10:05:00Z", Assert.Single(asked).Json.GetProperty("timespan").GetString());
        Assert.Equal(0.9, first["aa.orders-api"].Regions!.Single(r => r.Region == "northeurope").Share!.Value, 6);
        Assert.Equal(0.1, second["aa.orders-api"].Regions!.Single(r => r.Region == "northeurope").Share!.Value, 6);
    }

    // ---- the job query ----

    private static readonly TimeSpan Window = TimeSpan.FromDays(7);

    private static JobEvent Run(string job, string at, bool ok) => new("/apps/one", job, true, DateTimeOffset.Parse(at), ok, null);
    private static JobEvent Schedule(string job, string at, string? next) => new("/apps/one", job, false, DateTimeOffset.Parse(at), null, next is null ? null : DateTimeOffset.Parse(next));

    /// <summary>A week of logs: a job that runs every minute, an hourly one, a daily one and one that has not run for six days, each with its schedule lines.</summary>
    private static List<JobEvent> Week(DateTimeOffset until)
    {
        var events = new List<JobEvent>();
        for (var t = until - TimeSpan.FromDays(7); t < until; t += TimeSpan.FromMinutes(1))
        {
            events.Add(new JobEvent("/apps/one", "minute", true, t, t.Minute % 17 != 0, null));
            events.Add(new JobEvent("/apps/one", "minute", false, t, null, t.Minute % 5 == 0 ? null : t + TimeSpan.FromMinutes(1)));
            if (t.Minute == 0) events.Add(new JobEvent("/apps/one", "hourly", true, t, t.Hour % 7 != 0, null));
            if (t.Minute == 0) events.Add(new JobEvent("/apps/one", "hourly", false, t, null, t + TimeSpan.FromHours(1)));
            if (t.Hour == 0 && t.Minute == 30) { events.Add(new JobEvent("/apps/two", "daily", true, t, true, null)); events.Add(new JobEvent("/apps/two", "daily", false, t, null, t + TimeSpan.FromDays(1))); }
        }
        // a job of an app that runs in two regions and fails over: the north app ran it until three days ago, the west app since, each logging its own schedule lines
        for (var t = until - TimeSpan.FromDays(7); t < until; t += TimeSpan.FromMinutes(5))
        {
            var resource = t < until - TimeSpan.FromDays(3) ? "/apps/north" : "/apps/west";
            events.Add(new JobEvent(resource, "failover", true, t, true, null, "app-x-scheduler"));
            events.Add(new JobEvent(resource, "failover", false, t, null, t + TimeSpan.FromMinutes(5), "app-x-scheduler"));
        }
        events.Add(Run("rare", (until - TimeSpan.FromDays(6)).ToString("o"), false));
        events.Add(Schedule("rare", (until - TimeSpan.FromDays(6)).ToString("o"), (until - TimeSpan.FromDays(5)).ToString("o")));
        return events;
    }

    /// <summary>What the logs say about each job just before the start of the hour, and everything in the hour: the answer the hourly query gives.</summary>
    private static List<JobEvent> HourlyAnswer(List<JobEvent> week, DateTimeOffset hour) =>
        week.Where(e => e.At < hour).GroupBy(e => (Owner: e.App ?? e.ResourceId, e.Job, e.IsRun)).Select(g => g.OrderByDescending(e => e.At).First())
            .Concat(week.Where(e => e.At >= hour && e.At < hour + TimeSpan.FromHours(1))).ToList();

    [Fact]
    public void The_jobs_cut_out_of_an_hourly_answer_are_the_jobs_the_per_frame_query_gives_for_every_frame_of_the_hour()
    {
        var hour = DateTimeOffset.Parse("2026-11-20T03:00:00Z");
        var week = Week(hour + TimeSpan.FromHours(1));
        var answer = HourlyAnswer(week, hour);
        Assert.True(answer.Count < week.Count / 20); // the hourly answer is small: a week of every-minute runs is not sent

        for (var at = hour + TimeSpan.FromMinutes(5); at <= hour + TimeSpan.FromHours(1); at += TimeSpan.FromMinutes(5))
        {
            var perFrame = FunctionJobsSource.RowsAt(week.Where(e => e.At < at), at, Window); // the whole week, as the per-frame query sees the logs
            var fromHour = FunctionJobsSource.RowsAt(answer, at, Window);
            Assert.Equal(perFrame.Select(Show).Order(), fromHour.Select(Show).Order());
        }
    }

    private static string Show(JobRow r) => $"{r.ResourceId}|{r.Job}|{r.LastRun:o}|{r.Succeeded}|{r.Next:o}";

    [Fact]
    public void A_job_has_a_row_only_when_it_ran_in_the_window_and_takes_its_next_run_from_the_newest_schedule_line_even_when_that_has_none()
    {
        var at = DateTimeOffset.Parse("2026-11-20T12:00:00Z");
        var events = new List<JobEvent>
        {
            Run("a", "2026-11-20T11:00:00Z", true), Run("a", "2026-11-20T11:30:00Z", false), Schedule("a", "2026-11-20T11:00:00Z", "2026-11-20T12:30:00Z"), Schedule("a", "2026-11-20T11:30:00Z", null),
            Run("old", "2026-11-10T11:00:00Z", true), Schedule("old", "2026-11-20T11:00:00Z", "2026-11-21T11:00:00Z"), // no run in the window: no row
            Run("later", "2026-11-20T12:05:00Z", true), // after the frame: not yet
        };

        var rows = FunctionJobsSource.RowsAt(events, at, Window);

        var a = Assert.Single(rows);
        Assert.Equal("a", a.Job);
        Assert.Equal(DateTimeOffset.Parse("2026-11-20T11:30:00Z"), a.LastRun);
        Assert.False(a.Succeeded);
        Assert.Null(a.Next);
    }

    [Fact]
    public void A_job_that_runs_in_the_apps_of_two_regions_is_one_job_and_the_region_on_standby_is_not_late()
    {
        var at = DateTimeOffset.Parse("2026-11-16T19:29:00Z");
        JobEvent Of(string resource, string kind, string time, string? next) =>
            new(resource, "scale", kind == "run", DateTimeOffset.Parse(time), kind == "run" ? true : null, next is null ? null : DateTimeOffset.Parse(next), "app-x-scheduler");
        var events = new List<JobEvent>
        {
            Of("/apps/west", "run", "2026-11-16T11:03:00Z", null), Of("/apps/west", "schedule", "2026-11-16T11:03:00Z", "2026-11-16T11:04:00Z"), // west ran it this morning
            Of("/apps/north", "run", "2026-11-16T19:24:00Z", null), Of("/apps/north", "schedule", "2026-11-16T19:24:00Z", "2026-11-16T19:25:00Z"), // north has it now
        };

        var row = Assert.Single(FunctionJobsSource.RowsAt(events, at, Window));

        Assert.Equal("/apps/north", row.ResourceId);
        Assert.Equal(DateTimeOffset.Parse("2026-11-16T19:24:00Z"), row.LastRun);
        Assert.Equal(DateTimeOffset.Parse("2026-11-16T19:25:00Z"), row.Next);
        // a query that does not name the app keeps each function app on its own, as before
        Assert.Equal(2, FunctionJobsSource.RowsAt(events.Select(e => e with { App = null }), at, Window).Count);
    }

    [Fact]
    public void The_app_column_of_an_hourly_answer_is_read_and_is_optional()
    {
        var withApp = LogAnalyticsReader.ParseJobEvents(Table(["resourceId", "job", "kind", "at", "succeeded", "next", "app"],
            [["/apps/one", "tick", "run", "2026-11-20T02:50:00Z", true, null, "app-x-scheduler"]]));
        var without = LogAnalyticsReader.ParseJobEvents(Table(["resourceId", "job", "kind", "at", "succeeded", "next"],
            [["/apps/one", "tick", "run", "2026-11-20T02:50:00Z", true, null]]));

        Assert.Equal("app-x-scheduler", Assert.Single(withApp).App);
        Assert.Null(Assert.Single(without).App);
    }

    [Fact]
    public async Task The_jobs_of_an_hour_are_asked_once_with_the_start_of_the_hour_in_the_query_and_each_frame_gets_its_own_jobs()
    {
        var registry = RegistryLoader.Load(TownA).ForEnvironment("prod");
        var env = registry.ActiveEnvironment!;
        var set = new AdapterCatalog([new AzureAdapters()]).Build(env, TownA);
        await set.Sources.Single(s => s.Name == "inventory").PollAsync(registry, CancellationToken.None);
        var app = "/subscriptions/00000000-0000-0000-0000-0000000000f1/resourceGroups/rg/providers/microsoft.web/sites/app-acme-al-sch-northeurope1x";
        var answer = Table(["resourceId", "job", "kind", "at", "succeeded", "next"],
        [
            [app, "tick", "run", "2026-11-20T02:50:00Z", true, null], [app, "tick", "schedule", "2026-11-20T02:50:00Z", null, "2026-11-20T03:10:00Z"],
            [app, "tick", "run", "2026-11-20T03:10:00Z", false, null], [app, "tick", "schedule", "2026-11-20T03:10:00Z", null, "2026-11-20T03:30:00Z"],
        ]);
        var http = CannedHttp.Always(answer);
        var definition = env.Sources.Single(s => s.Name == "jobs") with
        {
            Connection = Workspace,
            Query = "FunctionAppLogs | where TimeGenerated > ago({window}) | summarize by x",
            Typed = AzureSettings.None with { RangeQuery = "let start = {rangeStart}; FunctionAppLogs | where TimeGenerated < start | summarize by x" },
        };
        var source = (FunctionJobsSource)new FunctionJobsSourceFactory(new HttpClient(http), new FakeTimeProvider(T0)).Create(new SourceContext("prod", definition, null, env.Scope, set.Scope, TownA));
        var loaded = RegistryLoader.Load(TownA);

        var early = await source.PollAtAsync(loaded, DateTimeOffset.Parse("2026-11-20T03:05:00Z"), CancellationToken.None);
        var late = await source.PollAtAsync(loaded, DateTimeOffset.Parse("2026-11-20T03:15:00Z"), CancellationToken.None);
        var last = await source.PollAtAsync(loaded, DateTimeOffset.Parse("2026-11-20T04:00:00Z"), CancellationToken.None); // the last frame of the hour that started at 03:00

        var sent = Assert.Single(http.Sent);
        Assert.Equal($"{DateTimeOffset.Parse("2026-11-20T03:00:00Z") - source.Window:yyyy-MM-dd'T'HH:mm:ss'Z'}/2026-11-20T04:00:00Z", sent.Json.GetProperty("timespan").GetString());
        Assert.Contains("let start = datetime(2026-11-20T03:00:00Z);", sent.Json.GetProperty("query").GetString());
        var before = early["aa.sched-fn"].Jobs!.Single(j => j.Name == "tick");
        Assert.Equal(DateTimeOffset.Parse("2026-11-20T02:50:00Z"), before.LastRun);
        Assert.Equal(DateTimeOffset.Parse("2026-11-20T03:10:00Z"), before.Next);
        var after = late["aa.sched-fn"].Jobs!.Single(j => j.Name == "tick");
        Assert.Equal(DateTimeOffset.Parse("2026-11-20T03:10:00Z"), after.LastRun);
        Assert.Equal(DateTimeOffset.Parse("2026-11-20T03:30:00Z"), after.Next);
        Assert.NotEmpty(last["aa.sched-fn"].Jobs!);
    }

    [Fact]
    public async Task An_hourly_job_answer_without_its_columns_says_what_is_missing()
    {
        var registry = RegistryLoader.Load(TownA).ForEnvironment("prod");
        var env = registry.ActiveEnvironment!;
        var set = new AdapterCatalog([new AzureAdapters()]).Build(env, TownA);
        await set.Sources.Single(s => s.Name == "inventory").PollAsync(registry, CancellationToken.None);
        var http = CannedHttp.Always(File.ReadAllText(Path.Combine(TownA, "jobs.json"))); // the per-frame shape
        var definition = env.Sources.Single(s => s.Name == "jobs") with { Connection = Workspace, Query = "x", Typed = AzureSettings.None with { RangeQuery = "y" } };
        var source = (FunctionJobsSource)new FunctionJobsSourceFactory(new HttpClient(http), new FakeTimeProvider(T0)).Create(new SourceContext("prod", definition, null, env.Scope, set.Scope, TownA));

        var e = await Assert.ThrowsAsync<InvalidOperationException>(() => source.PollAtAsync(RegistryLoader.Load(TownA), DateTimeOffset.Parse("2026-11-20T03:05:00Z"), CancellationToken.None));

        Assert.Contains("kind, at", e.Message);
    }
}
