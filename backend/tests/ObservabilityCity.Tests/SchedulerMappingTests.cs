using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.AdapterKit;
using ObservabilityCity.Adapters.Azure;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Tests;

/// <summary>
/// Phase 3, slice 5: which services a scheduled job starts work for is not in the logs, so the pillar file says it (<c>scheduler:</c>). A job that is
/// not listed sends no boats and the town says so. Two towns that write the mapping differently (full ids, exact case; short ids, other case, other
/// order) give the same schedules and the same notice.
/// </summary>
public class SchedulerMappingTests
{
    private static string Town(string name) => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "registries", name == "a" ? "function-town-a" : "function-town-b");
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");

    private static async Task<Snapshot> TownSnapshot(string folder)
    {
        var registry = RegistryLoader.Load(folder).ForEnvironment("prod");
        var set = new AdapterCatalog([new AzureAdapters()]).Build(registry.ActiveEnvironment!, folder);
        Assert.Empty(set.Problems);
        var state = new LatestState();
        foreach (var source in set.Sources) state.Update(source.Name, await source.PollAsync(registry, CancellationToken.None));
        return new SnapshotBuilder(registry, state, new FakeTimeProvider(T0)) { Environment = "prod" }.Build();
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task The_island_says_which_services_each_listed_job_starts_work_for(string town)
    {
        var snapshot = await TownSnapshot(Town(town));
        var schedules = snapshot.Groups.Single(g => g.Id == "aa").Messaging!.Schedules!;

        Assert.Equal(2, schedules.Count);
        Assert.All(schedules, s => Assert.Equal("aa.sched-fn", s.System)); // the short id is resolved to the full one
        Assert.Equal(["orders"], schedules.Single(s => s.Job.Equals("purge", StringComparison.OrdinalIgnoreCase)).Services);
        Assert.Equal(["orders", "reports"], schedules.Single(s => s.Job.Equals("daily", StringComparison.OrdinalIgnoreCase)).Services.Order().ToList());
    }

    [Theory]
    [InlineData("a")]
    [InlineData("b")]
    public async Task A_job_the_file_does_not_map_gets_a_notice_and_a_mapped_job_does_not(string town)
    {
        var snapshot = await TownSnapshot(Town(town));

        var notice = Assert.Single(snapshot.Notices, n => n.StartsWith("Job not mapped: aa.sched-fn"));
        Assert.Contains("aa.sched-fn", notice);
        Assert.Contains("hourly", notice);
        Assert.DoesNotContain("purge", notice);
        Assert.DoesNotContain("daily", notice);
    }

    [Fact]
    public async Task A_town_without_a_scheduler_list_has_no_schedules_and_says_every_job_is_not_mapped()
    {
        var folder = CopyTown("a", yaml => yaml[..yaml.IndexOf("# the jobs of the scheduler", StringComparison.Ordinal)]);
        try
        {
            var snapshot = await TownSnapshot(folder);
            Assert.Empty(snapshot.Groups.Single(g => g.Id == "aa").Messaging!.Schedules!);
            var notice = Assert.Single(snapshot.Notices, n => n.StartsWith("Job not mapped: aa.sched-fn"));
            Assert.Contains("daily, hourly, purge", notice);
        }
        finally { Directory.Delete(folder, true); }
    }

    [Theory]
    [InlineData("scheduler:\n  - system: aa.nothing\n    jobs: { purge: [orders] }\n", "'aa.nothing' is not a system of this pillar")]
    [InlineData("scheduler:\n  - system: aa.orders-api\n    jobs: { purge: [orders] }\n", "only a function has scheduled jobs")]
    [InlineData("scheduler:\n  - system: aa.sched-fn\n    jobs: { purge: [ordrs] }\n", "'ordrs', which is not a service of this pillar")]
    public void A_mapping_that_points_nowhere_is_refused_and_says_what_is_wrong(string block, string expected)
    {
        var folder = CopyTown("a", yaml => yaml[..yaml.IndexOf("# the jobs of the scheduler", StringComparison.Ordinal)] + block);
        try
        {
            var error = Assert.Throws<RegistryException>(() => RegistryLoader.Load(folder));
            Assert.Contains(expected, error.Message);
        }
        finally { Directory.Delete(folder, true); }
    }

    private static string CopyTown(string name, Func<string, string> pillar)
    {
        var target = Path.Combine(Path.GetTempPath(), "oc-scheduler-" + Guid.NewGuid().ToString("N"));
        CopyDirectory(Town(name), target);
        var file = Path.Combine(target, "pillars", "aa.yaml");
        File.WriteAllText(file, pillar(File.ReadAllText(file)));
        return target;
    }

    private static void CopyDirectory(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)));
        foreach (var d in Directory.GetDirectories(from)) CopyDirectory(d, Path.Combine(to, Path.GetFileName(d)));
    }
}
