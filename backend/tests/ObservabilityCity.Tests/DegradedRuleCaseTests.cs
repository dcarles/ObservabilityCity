using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Time.Testing;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>
/// Every rule that can make a system amber (<see cref="DegradedRules"/>) has a case: a system whose numbers trip it. The case is built by the real snapshot builder and kept in
/// <c>shared-test-data/degraded-rules/&lt;rule&gt;.json</c>, where the browser's tests read it and check that the drawer and the wall can say why. A rule with no case, or a case
/// for a rule that is gone, fails here, so a rule added to the server cannot be left out of the browser's explanations.
/// </summary>
public class DegradedRuleCaseTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true, NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals };
    private static readonly DateTimeOffset T0 = new(2026, 11, 13, 12, 0, 0, TimeSpan.Zero);
    private static string Folder => Path.Combine(TestPaths.RepoRoot, "shared-test-data", "degraded-rules");

    private const string Api = "aa.orders-api", Worker = "aa.orders-worker", Db = "aa.orders-db";

    private static NodeReading Healthy(DateTimeOffset at) => new(at, true, 2, 2, 0.3, 10, 0, 100, Cpu: 0.2, Memory: 0.2);

    /// <summary>For each rule: the system and the numbers that trip it (the readings of an otherwise healthy system).</summary>
    private static readonly Dictionary<string, (string Node, Func<NodeReading, NodeReading> Trip)> Cases = new()
    {
        ["no-response"] = (Api, r => r with { Up = false }),
        ["job-failed"] = (Worker, r => r with { Jobs = [new JobReading("nightly", null, r.At, false, r.At.AddHours(1)), new JobReading("hourly", null, r.At, true, r.At.AddHours(1))] }), // one of two fails: all of them failing is red
        ["job-late"] = (Worker, r => r with { Jobs = [new JobReading("nightly", null, null, null, r.At.AddHours(-2))] }),
        ["error-rate"] = (Api, r => r with { ErrorRate = 0.5 }),
        ["p99"] = (Api, r => r with { P99Ms = 5000 }),
        ["instances"] = (Api, r => r with { InstancesHealthy = 1 }),
        ["cpu"] = (Api, r => r with { Cpu = 0.9 }),
        ["memory"] = (Api, r => r with { Memory = 0.9 }),
        ["oldest-message"] = (Worker, r => r with { OldestMessageSeconds = 120 }),
        ["waiting-count"] = (Worker, r => r with { QueueDepth = 424 }),
        ["store"] = (Db, r => r with { Utilisation = 0.95 }),
    };

    public static IEnumerable<object[]> Rules => DegradedRules.All.Select(r => new object[] { r.Id });

    /// <summary>The mini town with a waiting-count line for workers, which the rule needs to apply.</summary>
    private static string TownWithCountLine()
    {
        var target = Path.Combine(Path.GetTempPath(), "oc-rules-" + Guid.NewGuid().ToString("N"));
        CopyDirectory(TestPaths.MiniTown, target);
        var defaults = Path.Combine(target, "defaults.yaml");
        File.WriteAllText(defaults, File.ReadAllText(defaults).Replace("backlog: { amber: 60, red: 300 } }", "backlog: { amber: 60, red: 300 }, backlogCount: { amber: 100, red: 1000 } }"));
        return target;
    }

    private static void CopyDirectory(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)));
        foreach (var d in Directory.GetDirectories(from)) CopyDirectory(d, Path.Combine(to, Path.GetFileName(d)));
    }

    private static NodeSnapshot Build(string rule)
    {
        var folder = TownWithCountLine();
        try
        {
            var registry = RegistryLoader.Load(folder);
            var clock = new FakeTimeProvider(T0);
            var (node, trip) = Cases[rule];
            var state = new LatestState();
            state.Update(new Dictionary<string, NodeReading> { [node] = trip(Healthy(T0)) });
            var snapshot = new SnapshotBuilder(registry, state, clock) { StaleAfter = TimeSpan.FromMinutes(5) }.Build();
            return snapshot.Groups.SelectMany(g => g.Nodes).Single(n => n.Id == node);
        }
        finally { Directory.Delete(folder, true); }
    }

    [Fact]
    public void Every_rule_has_a_case_and_every_case_and_file_belongs_to_a_rule()
    {
        var rules = DegradedRules.All.Select(r => r.Id).Order().ToList();

        Assert.Equal(rules, Cases.Keys.Order());
        Assert.Equal(rules, Directory.GetFiles(Folder, "*.json").Select(f => Path.GetFileNameWithoutExtension(f)).Order());
    }

    [Theory]
    [MemberData(nameof(Rules))]
    public void A_system_that_trips_a_rule_is_not_healthy_says_why_and_matches_the_shared_case(string rule)
    {
        var node = Build(rule);

        Assert.Equal(rule == "no-response" ? HealthState.Down : HealthState.Degraded, node.State);
        Assert.False(string.IsNullOrWhiteSpace(node.Reason));
        var actual = JsonSerializer.Serialize(node, Json).ReplaceLineEndings("\n");
        var path = Path.Combine(Folder, rule + ".json");
        if (Environment.GetEnvironmentVariable("UPDATE_GOLDEN") == "1" || !File.Exists(path)) File.WriteAllText(path, actual + "\n");
        Assert.Equal(File.ReadAllText(path).ReplaceLineEndings("\n").TrimEnd(), actual.TrimEnd());
    }
}
