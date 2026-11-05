namespace ObservabilityCity.Core.Sources;

/// <summary>
/// A resource the cloud itself reports as not healthy: Degraded or Unavailable. Id is stable for as long as the same event lasts (the resource and when it started), so a viewer can tell a
/// new event on a resource from the one it already knows. A resolved event has State "Resolved" and ResolvedAt: the source keeps it listed for a while after the resource recovered (Previous is what the resource was before it went wrong). Previous and Cause are as the cloud gave them (null when it gave none); Summary is the cloud's own one-line title, when it has one.
/// </summary>
public sealed record ResourceHealthEvent(string Id, string ResourceId, string ResourceName, string State, string? Previous, string? Cause, DateTimeOffset Since, string? Summary = null, DateTimeOffset? ResolvedAt = null);

/// <summary>
/// Where the cloud's own word on a resource's health comes from. Like <see cref="IIncidentSource"/> it answers from what it already knows, so the snapshot builder never waits on it; a real
/// adapter refreshes its list on its own timer. It lists the events that are open right now and, for a configured time (keepResolvedFor), those that just resolved. A source that is also a metric source reports no readings.
/// </summary>
public interface IHealthEventSource
{
    string Name { get; }

    /// <summary>The events open now. The last good list stays while a read fails.</summary>
    IReadOnlyList<ResourceHealthEvent> Current();

    /// <summary>Why the last read failed, or null when it worked. The town shows it as a notice, so a list that stopped updating is not mistaken for a quiet cloud.</summary>
    string? Problem { get; }

    /// <summary>Hides one event (by its Id) until the source restarts, open or resolved. True when the source knew it.</summary>
    bool Dismiss(string id);
}
