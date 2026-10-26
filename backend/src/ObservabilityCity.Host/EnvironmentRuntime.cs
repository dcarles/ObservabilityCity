using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Snapshots;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Host;

/// <summary>
/// Everything one environment runs on its own: its view of the registry, its source and the readings that source produced, and the stream of
/// snapshots built from them. Every environment of the town has one, so dev, staging and prod each move on their own.
/// </summary>
public sealed class EnvironmentRuntime(string id, EnvironmentRegistry registry, FakeSource fake, LatestState state, SnapshotBuilder builder, SnapshotStore store, ILogSource logs)
{
    public string Id { get; } = id;
    public EnvironmentRegistry Registry { get; } = registry;
    public FakeSource Fake { get; } = fake;
    public LatestState State { get; } = state;
    public SnapshotBuilder Builder { get; } = builder;
    public SnapshotStore Store { get; } = store;
    public ILogSource Logs { get; } = logs;
}

/// <summary>The environments this server runs, by id. The environments are fixed when the server starts; the registry behind each can change while it runs.</summary>
public sealed class EnvironmentSet(IReadOnlyList<EnvironmentRuntime> all, string defaultId)
{
    public IReadOnlyList<EnvironmentRuntime> All { get; } = all;
    public EnvironmentRuntime Default => Find(defaultId)!;

    /// <summary>The environment with this id, or null. Asking for none gives the default one.</summary>
    public EnvironmentRuntime? Find(string? id) =>
        string.IsNullOrEmpty(id) ? Default : All.FirstOrDefault(e => e.Id == id);
}
