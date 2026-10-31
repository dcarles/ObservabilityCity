using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// Phase 3, slices 3 and 3b: a function building (the old cron) knows whether its app runs, how each scheduled job of each region is doing, and a service
/// that runs in two regions is shown as its worst region. The program knows no state word, log text, region name or naming: two towns that write all of
/// those differently (names and a state called Running; tags and a state called Started) show the same town, which is the proof.
/// </summary>
public class FunctionBuildingTests
{
    private static string TownA => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "function-town-a");
    private static string TownB => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", "function-town-b");
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");

    private static TownRegistry Prod(string folder) => RegistryLoader.Load(folder).ForEnvironment("prod");
    private static NodeSnapshot Node(Snapshot s, string id) => s.Groups.SelectMany(g => g.Nodes).First(n => n.Id == id);
    private static string Town(string name) => name == "a" ? TownA : TownB;

    private static async Task<Snapshot> TownSnapshot(string folder, Func<TownRegistry, TownRegistry>? change = null)
    {
        var registry = Prod(folder);
        var set = new AdapterCatalog([new AzureAdapters()]).Build(registry.ActiveEnvironment!, folder);
        Assert.Empty(set.Problems);
        var state = new LatestState();
        foreach (var source in set.Sources) state.Update(source.Name, await source.PollAsync(registry, CancellationToken.None));
        return new SnapshotBuilder(change?.Invoke(registry) ?? registry, state, new FakeTimeProvider(T0)) { Environment = "prod" }.Build();
    }

    // ---- the function building, whatever the conventions ----

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task A_function_shows_its_app_and_the_state_of_each_job_in_each_region(string town)
    {
        var snapshot = await TownSnapshot(Town(town));
        var west = town == "a" ? "West" : "Amsterdam";
        var north = town == "a" ? "North" : "Dublin";

        var scheduler = Node(snapshot, "aa.sched-fn");
        Assert.Equal(NodeKind.Function, scheduler.Kind);
        Assert.Equal(AppState.Running, scheduler.App);
        Assert.Equal(HealthState.Down, scheduler.State); // one job failed its last run
        Assert.Equal(
            [("daily", north, JobStatus.Ok), ("hourly", west, JobStatus.Overdue), ("purge", west, JobStatus.Failed)],
            scheduler.Jobs!.Select(j => (j.Name, j.Region, j.Status)));
        Assert.Equal(DateTimeOffset.Parse("2025-12-31T23:55:00Z"), scheduler.Jobs![2].LastRun);
        Assert.Equal(DateTimeOffset.Parse("2025-12-31T23:00:00Z"), scheduler.Jobs![1].Next);
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task A_job_that_did_not_run_when_its_schedule_said_it_would_is_amber_not_red(string town)
    {
        var report = Node(await TownSnapshot(Town(town)), "aa.report-fn");

        Assert.Equal(AppState.Running, report.App);
        Assert.Equal(JobStatus.Overdue, Assert.Single(report.Jobs!).Status);
        Assert.Equal(HealthState.Degraded, report.State);
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task A_stopped_app_is_under_construction_not_in_trouble_and_its_jobs_are_not_judged(string town)
    {
        var idle = Node(await TownSnapshot(Town(town)), "aa.idle-fn");

        Assert.Equal(AppState.Stopped, idle.App);
        Assert.Equal(HealthState.Healthy, idle.State); // its job is long overdue, but the app is switched off
        Assert.Null(idle.Jobs);
        Assert.Contains(Signals.Instances, idle.Absent); // no 0 of 0 instances: a count of nothing is not known
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task An_app_the_inventory_does_not_have_is_grey_and_missing_and_the_old_role_name_still_works(string town)
    {
        var ghost = Node(await TownSnapshot(Town(town)), "aa.ghost-fn"); // declared with role: cron

        Assert.Equal(NodeKind.Function, ghost.Kind);
        Assert.Equal(AppState.Missing, ghost.App);
        Assert.Equal(HealthState.Stale, ghost.State);
    }

    // ---- the per-region view ----

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task A_service_in_two_regions_shows_its_worst_region_and_lists_both(string town)
    {
        var api = Node(await TownSnapshot(Town(town)), "aa.orders-api");
        var (hot, calm) = town == "a" ? ("West", "North") : ("Amsterdam", "Dublin");

        Assert.Equal(new[] { calm, hot }.Order(StringComparer.Ordinal).ToList(), api.Regions!.Select(r => r.Label).ToList());
        var shown = api.Regions!.Single(r => r.Label == hot);
        var other = api.Regions!.Single(r => r.Label == calm);
        Assert.Equal((1, 0.64, 0.60), (shown.Instances, shown.Cpu!.Value, shown.Memory!.Value));
        Assert.Equal((2, 0.42, 0.58), (other.Instances, Math.Round(other.Cpu!.Value, 2), other.Memory!.Value));
        // the building itself follows the region under more pressure: its floors, CPU and memory
        Assert.Equal(1, api.InstancesTotal);
        Assert.Equal(0.64, api.Cpu!.Value, 6);
        Assert.Equal(0.60, api.Memory!.Value, 6);
    }

    [Theory]
    [InlineData("environment")]
    [InlineData("pillar")]
    [InlineData("system")]
    public async Task The_region_view_can_be_turned_off_for_an_environment_a_pillar_or_one_system(string level)
    {
        TownRegistry Change(TownRegistry r)
        {
            var env = r.ActiveEnvironment!;
            switch (level)
            {
                case "environment": return r with { ActiveEnvironment = env with { Scope = env.Scope with { Regions = env.Scope.Regions with { Enabled = false } } } };
                case "pillar": return r with { ActiveEnvironment = env with { Scope = env.Scope with { Regions = env.Scope.Regions with { Off = ["aa"] } } } };
                default:
                    return r with { Groups = r.Groups.Select(g => g with { Nodes = g.Nodes.Select(n => n.Id == "aa.orders-api" ? n with { RegionView = false } : n).ToList() }).ToList() };
            }
        }

        var api = Node(await TownSnapshot(TownA, Change), "aa.orders-api");

        Assert.Null(api.Regions);
        Assert.Equal(3, api.InstancesTotal); // all the service's instances again, as before the region view
        Assert.Equal(0.64, api.Cpu!.Value, 6); // the busiest plan, as before
    }

    [Fact]
    public async Task A_service_in_one_region_has_no_region_view()
    {
        var inventory = ResourceGraphInventory.FromRecording(File.ReadAllText(Path.Combine(TownA, "inventory.json")));
        var oneRegion = inventory with { Resources = inventory.Resources.Where(r => !r.Name.Contains("westeurope")).ToList() };
        var registry = Prod(TownA);
        var resolution = ScopeResolver.Resolve(registry, oneRegion);
        var readings = ResourceGraphSource.InstanceReadings(resolution, T0);
        var state = new LatestState();
        state.Update("inventory", readings);
        var api = Node(new SnapshotBuilder(registry, state, new FakeTimeProvider(T0)) { Environment = "prod", StaleAfter = TimeSpan.FromDays(1) }.Build(), "aa.orders-api");

        Assert.Null(api.Regions);
        Assert.Equal(2, api.InstancesTotal);
    }

    // ---- the pieces ----

    [Fact]
    public void The_job_rows_name_the_app_and_the_job_and_the_times_may_be_left_out()
    {
        var rows = LogAnalyticsReader.ParseJobs("""
            { "tables": [ { "columns": [ {"name":"resourceId"}, {"name":"job"}, {"name":"Succeeded"} ],
              "rows": [ ["/x/APP", "nightly", "false"], ["/x/app", "", true], ["", "oops", true], ["/x/app", "weekly", null] ] } ] }
            """);

        Assert.Equal([("/x/APP", "nightly", false), ("/x/app", "weekly", (bool?)null)], rows.Select(r => (r.ResourceId, r.Job, r.Succeeded)));
        Assert.All(rows, r => { Assert.Null(r.LastRun); Assert.Null(r.Next); });
        var e = Assert.Throws<InvalidOperationException>(() => LogAnalyticsReader.ParseJobs("""{ "tables": [ { "columns": [ {"name":"app"} ], "rows": [] } ] }"""));
        Assert.Contains("resourceId, job, lastRun, succeeded, next, region", e.Message);
    }

    [Fact]
    public void A_job_is_matched_to_its_app_whatever_the_case_of_the_resource_id()
    {
        var scope = new SystemScope("aa.f", "f", "role", null, "sub", null, [new ResolvedResource("/Subs/X/App-1", "App-1", "t", "northeurope", null, "rule")]);
        var rows = new[] { new JobRow("/subs/x/app-1", "daily", T0, true, T0.AddDays(1), null), new JobRow("/subs/x/other", "nope", T0, true, null, null) };

        var readings = FunctionJobsSource.Readings([scope], rows, T0);

        var job = Assert.Single(readings["aa.f"].Jobs!);
        Assert.Equal(("daily", "northeurope"), (job.Name, job.Region));
    }

    [Fact]
    public void The_inventory_query_reads_the_state_with_the_rules_expression_and_nothing_for_a_type_no_rule_reads()
    {
        var rules = Prod(TownA).ActiveEnvironment!.Scope;

        Assert.Equal("case(type =~ 'microsoft.web/sites', tostring(tostring(properties.state)), '')", ResourceGraphInventory.StateExpression(rules));
        Assert.Equal("''", ResourceGraphInventory.StateExpression(rules with { Resources = [] }));
    }

    [Fact]
    public void A_state_rule_needs_the_values_that_mean_running_and_running_needs_a_state()
    {
        string Errors(string rule)
        {
            var dir = Path.Combine(Path.GetTempPath(), "fn-" + Guid.NewGuid().ToString("N"));
            try
            {
                CopyDirectory(TownA, dir);
                var env = Path.Combine(dir, "environments", "prod.yaml");
                File.WriteAllText(env, File.ReadAllText(env).Replace("state: \"tostring(properties.state)\", running: [Running]", rule));
                try { RegistryLoader.Load(dir); return ""; } catch (RegistryException e) { return e.Message; }
            }
            finally { Directory.Delete(dir, true); }
        }

        Assert.Contains("state needs running", Errors("state: \"tostring(properties.state)\""));
        Assert.Contains("running is only used with state", Errors("running: [Running]"));
        Assert.Equal("", Errors("state: \"tostring(properties.state)\", running: [Running]"));
    }

    private static void CopyDirectory(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var file in Directory.GetFiles(from)) File.Copy(file, Path.Combine(to, Path.GetFileName(file)));
        foreach (var dir in Directory.GetDirectories(from)) CopyDirectory(dir, Path.Combine(to, Path.GetFileName(dir)));
    }
}
