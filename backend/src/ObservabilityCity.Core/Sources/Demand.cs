namespace ObservabilityCity.Core.Sources;

/// <summary>
/// Whether anyone is looking at one environment of one town. Browsers count themselves in when they connect and out when they leave. The background
/// work that costs cloud calls (the source pollers and the link reads) goes on while somebody is looking, and for <see cref="Grace"/> after the last one
/// left, so that a reload does not stop and start it. When nobody looks it waits, and starts again at once when a browser connects. At startup nobody is looking.
/// </summary>
public sealed class Demand(TimeSpan? grace = null, TimeProvider? time = null)
{
    /// <summary>How long the work goes on after the last browser left.</summary>
    public static readonly TimeSpan DefaultGrace = TimeSpan.FromMinutes(2);

    private readonly object _gate = new();
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private int _viewers;
    private DateTimeOffset? _lastLeft;
    private TaskCompletionSource _joined = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public TimeSpan Grace { get; } = grace ?? DefaultGrace;

    public int Viewers { get { lock (_gate) return _viewers; } }

    /// <summary>True while a browser is looking, or the last one left less than <see cref="Grace"/> ago.</summary>
    public bool Wanted
    {
        get
        {
            lock (_gate) return _viewers > 0 || _lastLeft is { } left && _time.GetUtcNow() - left < Grace;
        }
    }

    public void Join()
    {
        lock (_gate)
        {
            _viewers++;
            _joined.TrySetResult();
        }
    }

    public void Leave()
    {
        lock (_gate)
        {
            if (_viewers == 0) return;
            _viewers--;
            if (_viewers == 0) _lastLeft = _time.GetUtcNow();
        }
    }

    /// <summary>Returns at once when the work is wanted; otherwise waits until a browser connects. False when cancelled first.</summary>
    public static async Task<bool> WaitUntilWantedAsync(Demand? demand, CancellationToken ct)
    {
        if (demand is null) return true;
        while (!demand.Wanted)
        {
            Task joined;
            lock (demand._gate)
            {
                if (demand._joined.Task.IsCompleted) demand._joined = new(TaskCreationOptions.RunContinuationsAsynchronously);
                joined = demand._joined.Task;
            }
            // a browser may have joined between the check and the wait, so look again after every wake
            if (demand.Wanted) break;
            try { await joined.WaitAsync(ct); }
            catch (OperationCanceledException) { return false; }
        }
        return !ct.IsCancellationRequested;
    }
}
