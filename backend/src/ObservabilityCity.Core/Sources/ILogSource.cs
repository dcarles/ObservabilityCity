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

    /// <summary>
    /// What the logs said around a past time, for the Logs tab while a page looks at the past: the same window, ending at <paramref name="at"/>. A source that cannot read the past
    /// answers as it does for now.
    /// </summary>
    Task<SystemLogs> AtAsync(RegistryNode node, DateTimeOffset at, CancellationToken ct) => RecentAsync(node, ct);
}
