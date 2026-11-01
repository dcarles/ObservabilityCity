using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Sources;

/// <summary>
/// Where a system's Logs tab comes from (Log Analytics in a live town, the fake generator in a demo). Read only when someone opens a system's inspector,
/// never polled for the whole town: health comes from metrics. A system with no fresh data has no sections.
/// </summary>
public interface ILogSource
{
    string Name { get; }
    Task<SystemLogs> RecentAsync(RegistryNode node, CancellationToken ct);
}
