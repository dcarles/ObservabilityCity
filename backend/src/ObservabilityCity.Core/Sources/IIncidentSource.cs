using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Sources;

/// <summary>An open incident assigned to a group. Severity runs from 1 (worst) to 4 (minor).</summary>
public sealed record Incident(string Id, string GroupId, int Severity, string Title, DateTimeOffset StartedAt);

/// <summary>
/// Where the open incidents come from (the incident tool later, the fake generator now). It answers from what it already knows, so the
/// snapshot builder never waits on it; a real adapter refreshes its list on its own timer.
/// An incident for a group the registry does not have is ignored.
/// </summary>
public interface IIncidentSource
{
    string Name { get; }
    IReadOnlyList<Incident> Current(Registry.Registry registry);
}
