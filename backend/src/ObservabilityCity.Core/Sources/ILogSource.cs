using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Sources;

/// <summary>
/// Where a system's recent log lines come from (Log Analytics later, the fake generator now). Logs are read only when someone opens a system's
/// inspector, never polled for the whole town: health comes from metrics. Lines come back newest first; a system with no fresh data has none.
/// </summary>
public interface ILogSource
{
    string Name { get; }
    Task<IReadOnlyList<LogLine>> RecentAsync(RegistryNode node, int limit, CancellationToken ct);
}
