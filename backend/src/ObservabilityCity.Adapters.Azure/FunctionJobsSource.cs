using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Scope;
using ObservabilityCity.Core.Sources;
using TownRegistry = ObservabilityCity.Core.Registry.Registry;

namespace ObservabilityCity.Adapters.Azure;

/// <summary>
/// Reads how the scheduled jobs of function buildings are doing from the function apps' logs in a Log Analytics workspace. It sends the environment's own
/// query (<c>query</c> in the source definition), which summarises the logs into one row per function app and job with the columns <c>resourceId</c> (the
/// function app's resource id), <c>job</c>, <c>lastRun</c>, <c>succeeded</c> and <c>next</c> (when the schedule says it runs next); <c>region</c> may be added.
/// What a log line looks like, which text means success and where the next time sits are the query's business, so the adapter knows no company's logs.
/// Rows are matched to function systems by their app's resource id (the resources the scope rules found for the system); the town works out from the
/// times whether a job failed or is overdue. A function app with no row ran no job in the window, which is an empty list, not unknown.
/// <c>file:name.json</c> replays a recorded answer kept beside the town's files.
/// </summary>
public sealed class FunctionJobsSource(
    string name, string environmentId, RegistrySource definition, LogAnalyticsReader reader, ScopeStore store, ScopeRules rules, string? recording, TimeProvider time) : IMetricSource
{
    public string Name => name;
    public TimeSpan PollInterval => definition.PollInterval;
    public TimeSpan Timeout => definition.Timeout;
    public TimeSpan Window { get; } = SourceQuery.WindowOf(definition);

    public async Task<IReadOnlyDictionary<string, NodeReading>> PollAsync(TownRegistry registry, CancellationToken ct)
    {
        var view = registry.ForEnvironment(environmentId);
        if (recording is null && string.IsNullOrWhiteSpace(definition.Connection) && store.Inventory is null) await store.WaitForReadAsync(Timeout / 2, ct);
        var resolution = store.Resolve(view);
        var functions = view.AllNodes.Where(n => n.Kind == NodeKind.Function).Select(n => n.Id).ToHashSet();
        var asked = resolution.Systems.Where(s => functions.Contains(s.SystemId) && s.Resources.Count > 0).ToList();
        if (asked.Count == 0) return new Dictionary<string, NodeReading>();

        IReadOnlyList<JobRow> rows;
        if (recording is not null)
            rows = LogAnalyticsReader.ParseJobs(await File.ReadAllTextAsync(recording, ct));
        else
        {
            var query = definition.Query ?? throw new InvalidOperationException($"source '{name}' has no query. Write the query that returns one row per function app and job with the columns {string.Join(", ", LogAnalyticsReader.JobColumns)} (see docs/connect-your-company.md)");
            var workspace = LogAnalyticsSource.Workspace(name, definition, resolution);
            rows = await reader.QueryJobsAsync(workspace, SourceQuery.Render(query, definition, environmentId, rules, []), Window, ct);
        }
        return Readings(asked, rows, time.GetUtcNow());
    }

    /// <summary>A reading for every asked function: the jobs of the rows whose app is one of its resources, each in the region of that resource (else the row's own).</summary>
    public static IReadOnlyDictionary<string, NodeReading> Readings(IEnumerable<SystemScope> asked, IReadOnlyList<JobRow> rows, DateTimeOffset at)
    {
        var byApp = rows.GroupBy(r => r.ResourceId, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.OrdinalIgnoreCase);
        var readings = new Dictionary<string, NodeReading>();
        foreach (var system in asked)
        {
            var jobs = system.Resources.SelectMany(res => (byApp.GetValueOrDefault(res.Id) ?? []).Select(r => new JobReading(r.Job, res.Region ?? r.Region, r.LastRun, r.Succeeded, r.Next)))
                .OrderBy(j => j.Name, StringComparer.Ordinal).ThenBy(j => j.Region, StringComparer.Ordinal).ToList();
            readings[system.SystemId] = new NodeReading(at, true, 0, 0, 0, 0, 0, 0, Jobs: jobs);
        }
        return readings;
    }
}

public sealed class FunctionJobsSourceFactory(HttpClient? http = null, TimeProvider? time = null) : IMetricSourceFactory
{
    public string Kind => "functionjobs";

    public IMetricSource Create(SourceContext context)
    {
        var connection = context.Source.Connection ?? "";
        string? recording = null;
        if (connection.StartsWith(ResourceGraphSourceFactory.RecordingPrefix, StringComparison.OrdinalIgnoreCase))
        {
            var file = connection[ResourceGraphSourceFactory.RecordingPrefix.Length..].Trim();
            recording = Path.IsPathRooted(file) || context.RegistryFolder is null ? file : Path.Combine(context.RegistryFolder, file);
            if (!File.Exists(recording)) throw new InvalidOperationException($"the recording {file} does not exist");
        }
        else if (context.Source.Query is null)
            throw new InvalidOperationException("it has no query. Write the query that returns one row per function app and job with the columns " + string.Join(", ", LogAnalyticsReader.JobColumns));
        return new FunctionJobsSource(context.Source.Name, context.EnvironmentId, context.Source, new LogAnalyticsReader(http ?? Shared, context.Credential),
            context.Scope ?? new ScopeStore(), context.Rules ?? ScopeRules.None, recording, time ?? TimeProvider.System);
    }

    private static readonly HttpClient Shared = new();
}
