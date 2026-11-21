using System.Collections.Concurrent;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.History;

/// <summary>Where the filling of the history stands, for the screen's loading card.</summary>
public sealed record FillStatus(bool Running, int Done, int Total, DateTimeOffset? Hour, string? Problem);

/// <summary>
/// Fills the gaps of one environment's history in the background (see <see cref="HistoryRebuilder"/>), newest hour first, whenever somebody is looking at the environment. Looking at an
/// environment again after looking away starts a new pass that fetches only what is still missing, so a stretch spent on another environment is made up as soon as you are back. An hour a
/// person jumps to that is not filled yet goes to the front (<see cref="Prioritise"/>). It never keeps a cloud environment busy when nobody looks: it stops with the demand, like the polls.
/// An hour that failed is left alone for ten minutes, then tried again; the reason is in <see cref="Status"/> and the log, never in the town.
/// </summary>
public sealed class HistoryFiller(
    HistoryRebuilder rebuilder,
    IReadOnlyList<IMetricSource> sources,
    Registry.IRegistryProvider registries,
    HistoryOptions options,
    Demand? gate = null,
    TimeProvider? time = null,
    ILogger<HistoryFiller>? log = null) : BackgroundService
{
    public static readonly TimeSpan RetryFailedAfter = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan CheckEvery = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan PassEvery = TimeSpan.FromHours(1);

    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly ConcurrentQueue<DateTimeOffset> _priority = new();
    private readonly Dictionary<DateTimeOffset, DateTimeOffset> _failed = [];
    private volatile FillStatus _status = new(false, 0, 0, null, null);

    public FillStatus Status => _status;

    /// <summary>Whether this environment has a past to rebuild from at all.</summary>
    public bool CanFill => rebuilder.CanRebuildFrom(sources);

    /// <summary>Asks for the hour of a time to be filled next, when it is a gap.</summary>
    public void Prioritise(DateTimeOffset at)
    {
        if (at < _time.GetUtcNow() - options.Keep) return;
        _priority.Enqueue(new DateTimeOffset(at.UtcDateTime.Date.AddHours(at.UtcDateTime.Hour), TimeSpan.Zero));
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (!CanFill) return;
        var lastPass = DateTimeOffset.MinValue;
        var wasIdle = true;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                if (!await Demand.WaitUntilWantedAsync(gate, ct)) return;
                var due = wasIdle || !_priority.IsEmpty || _time.GetUtcNow() - lastPass >= PassEvery;
                if (due)
                {
                    wasIdle = false;
                    await PassAsync(ct);
                    lastPass = _time.GetUtcNow();
                }
                await Task.Delay(CheckEvery, _time, ct);
                if (gate is { Wanted: false }) wasIdle = true;
            }
        }
        catch (OperationCanceledException) { }
    }

    /// <summary>One pass: every hour of the days kept that is still a gap, the asked-for ones first, then newest first. Public so a test can run one.</summary>
    public async Task PassAsync(CancellationToken ct)
    {
        var from = _time.GetUtcNow() - options.Keep;
        try
        {
            var missing = rebuilder.MissingHours(from).ToList();
            if (missing.Count == 0) { _status = new FillStatus(false, 0, 0, null, null); return; }
            var done = 0;
            string? problem = null;
            _status = new FillStatus(true, 0, missing.Count, null, null);
            var health = await rebuilder.ReadHealthAsync(sources, registries.Current, from, ct);
            while (missing.Count > 0)
            {
                if (gate is { Wanted: false }) break; // nobody looks any more
                var hour = Next(missing);
                missing.Remove(hour);
                if (_failed.TryGetValue(hour, out var when) && _time.GetUtcNow() - when < RetryFailedAfter) continue;
                _status = new FillStatus(true, done, done + missing.Count + 1, hour, problem);
                try
                {
                    await rebuilder.RebuildHourAsync(hour, health, ct);
                    _failed.Remove(hour);
                    done++;
                }
                catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
                {
                    _failed[hour] = _time.GetUtcNow();
                    problem = e.Message;
                    log?.LogWarning("History: could not rebuild the hour {Hour}: {Reason}", hour.ToString("O"), e.Message);
                }
            }
            _status = new FillStatus(false, done, done, null, problem);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            _status = new FillStatus(false, 0, 0, null, e.Message);
            log?.LogWarning("History: could not fill the gaps: {Reason}", e.Message);
        }
    }

    /// <summary>The hour to do next: one a person asked for if it is still a gap, else the newest.</summary>
    private DateTimeOffset Next(List<DateTimeOffset> missing)
    {
        while (_priority.TryDequeue(out var asked))
            if (missing.Contains(asked)) return asked;
        return missing[0]; // MissingHours lists the newest first
    }
}
