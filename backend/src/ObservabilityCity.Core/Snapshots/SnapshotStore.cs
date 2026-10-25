using ObservabilityCity.Contracts;

namespace ObservabilityCity.Core.Snapshots;

/// <summary>Holds the newest snapshot for late joiners and /api/snapshot/latest.</summary>
public sealed class SnapshotStore
{
    private volatile Snapshot? _latest;
    public Snapshot? Latest => _latest;
    public void Set(Snapshot snapshot) => _latest = snapshot;
}

/// <summary>How a snapshot reaches viewers. The builder does not know the transport (SignalR today).</summary>
public interface ISnapshotNotifier
{
    Task PublishAsync(Snapshot snapshot, CancellationToken ct);
}
