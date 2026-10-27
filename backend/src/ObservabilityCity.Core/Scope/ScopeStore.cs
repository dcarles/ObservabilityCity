using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.Core.Scope;

/// <summary>
/// The last inventory an environment's inventory source read, and what went wrong if its last read failed. Everything else is worked out from it on
/// demand, with the registry as it is at that moment, so a registry that reloads is resolved with its new rules at once. Other adapters ask it where a
/// system lives; before the first read they get what the rules say without an inventory.
/// </summary>
public sealed class ScopeStore
{
    private volatile Snapshot _state = new(null, null, null);

    private sealed record Snapshot(Inventory? Inventory, DateTimeOffset? At, string? Error);

    public Inventory? Inventory => _state.Inventory;
    public DateTimeOffset? ReadAt => _state.At;
    /// <summary>Why the last read failed, or null. The previous inventory is kept meanwhile.</summary>
    public string? Error => _state.Error;

    private readonly TaskCompletionSource _firstRead = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public void Update(Inventory inventory, DateTimeOffset at)
    {
        _state = new Snapshot(inventory, at, null);
        _firstRead.TrySetResult();
    }

    /// <summary>
    /// Waits, for at most <paramref name="limit"/>, until the inventory has been read once. Sources start together, so one that needs to know where a system
    /// lives would otherwise report nothing on its first poll and wait a whole poll interval for the second. True when the inventory has been read.
    /// </summary>
    public async Task<bool> WaitForReadAsync(TimeSpan limit, CancellationToken ct)
    {
        if (_firstRead.Task.IsCompletedSuccessfully) return true;
        try { await _firstRead.Task.WaitAsync(limit, ct); return true; }
        catch (TimeoutException) { return false; }
    }
    public void Fail(string error) => _state = _state with { Error = error };

    public Resolution Resolve(Registry.Registry view) => ScopeResolver.Resolve(view, _state.Inventory);
}
