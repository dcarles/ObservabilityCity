using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Host;

/// <summary>
/// Everything one environment runs on its own: its view of the registry, its source and the readings that source produced, and the stream of
/// snapshots built from them. Every environment of the town has one, so dev, staging and prod each move on their own.
/// </summary>
public sealed class EnvironmentRuntime(string townId, string id, EnvironmentRegistry registry, FakeSource fake, LatestState state, SnapshotBuilder builder, SnapshotStore store, ILogSource logs)
{
    public string TownId { get; } = townId;
    public string Id { get; } = id;

    /// <summary>The SignalR group of everyone looking at this environment of this town. Two towns can both have a "demo" or a "prod".</summary>
    public string Key { get; } = $"{townId}/{id}";
    public EnvironmentRegistry Registry { get; } = registry;
    public FakeSource Fake { get; } = fake;
    public LatestState State { get; } = state;
    public SnapshotBuilder Builder { get; } = builder;
    public SnapshotStore Store { get; } = store;
    public ILogSource Logs { get; } = logs;
}

/// <summary>
/// The environments one town runs, by id. The environments are fixed when the server starts; the registry behind each can change while it runs.
/// In an endpoint's parameters it stands for the town in the address' ?town= (the default town when the address names none). A town the server does
/// not have gives a set with no environments, so every lookup fails and the endpoint answers "no such town", never another town's data.
/// </summary>
public sealed class EnvironmentSet(IReadOnlyList<EnvironmentRuntime> all, string defaultId, string townId = "")
{
    public string TownId { get; } = townId;
    public static ValueTask<EnvironmentSet?> BindAsync(HttpContext http) =>
        ValueTask.FromResult<EnvironmentSet?>(http.RequestServices.GetRequiredService<TownSet>().EnvironmentsOf(http.Request.Query["town"].ToString()));

    public IReadOnlyList<EnvironmentRuntime> All { get; } = all;
    public EnvironmentRuntime Default => Find(defaultId)!;
    /// <summary>Whether this is the set of a town that exists (false for the empty set an unknown ?town= gets).</summary>
    public bool Exists => all.Count > 0;

    /// <summary>The environment with this id, or null. Asking for none gives the default one.</summary>
    public EnvironmentRuntime? Find(string? id) =>
        !Exists ? null : string.IsNullOrEmpty(id) ? Default : All.FirstOrDefault(e => e.Id == id);
}


/// <summary>One town the server runs: its registry (which reloads on its own), the stories it ships, and the environments it runs.</summary>
public sealed class TownRuntime(string id, string name, string folder, RegistryHolder holder, EnvironmentSet environments)
{
    public string Id { get; } = id;
    public string Name { get; } = name;
    public string Folder { get; } = folder;
    public RegistryHolder Registry { get; } = holder;
    public EnvironmentSet Environments { get; } = environments;
}

/// <summary>The towns this server runs, by id. Fixed when the server starts.</summary>
public sealed class TownSet(IReadOnlyList<TownRuntime> all, string defaultId)
{
    public IReadOnlyList<TownRuntime> All { get; } = all;
    public TownRuntime Default => All.First(t => t.Id == defaultId);

    /// <summary>The town with this id, or null. Asking for none gives the default one.</summary>
    public TownRuntime? Find(string? id) => string.IsNullOrEmpty(id) ? Default : All.FirstOrDefault(t => t.Id == id);

    /// <summary>The environments of the town named (the default town for none); an empty set for a town the server does not have.</summary>
    public EnvironmentSet EnvironmentsOf(string? id) => Find(id)?.Environments ?? new EnvironmentSet([], "", id ?? "");

    public IReadOnlyList<TownSummary> Infos => All.Select(t => new TownSummary(t.Id, t.Registry.Current.Town.Name, t.Id == defaultId)).ToList();
}
