using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
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
                var reason = wasIdle ? "somebody is looking again" : !_priority.IsEmpty ? "an hour was asked for" : _time.GetUtcNow() - lastPass >= PassEvery ? "the hourly check" : null;
                if (reason is not null)
                {
                    wasIdle = false;
                    await PassAsync(ct, reason);
                    lastPass = _time.GetUtcNow();
                }
                await Task.Delay(CheckEvery, _time, ct);
                if (gate is { Wanted: false }) wasIdle = true;
            }
        }
        catch (OperationCanceledException) { }
    }

    /// <summary>One pass: every hour of the days kept that is still a gap, the asked-for ones first, then newest first. Public so a test can run one.</summary>
    public async Task PassAsync(CancellationToken ct, string reason = "asked")
    {
        var from = _time.GetUtcNow() - options.Keep;
        var clock = Stopwatch.StartNew();
        try
        {
            var missing = rebuilder.MissingHours(from).ToList();
            if (missing.Count == 0)
            {
                _status = new FillStatus(false, 0, 0, null, null);
                log?.LogInformation("History: nothing to fill ({Reason})", reason);
                return;
            }
            var done = 0;
            var failed = 0;
            string? problem = null;
            _status = new FillStatus(true, 0, missing.Count, null, null);
            log?.LogInformation("History: filling started ({Reason}): {Hours} hours are missing, newest first", reason, missing.Count);
            while (missing.Count > 0)
            {
                if (gate is { Wanted: false })
                {
                    log?.LogInformation("History: filling paused, nobody is looking; {Left} hours left", missing.Count);
                    break;
                }
                var hour = Next(missing);
                missing.Remove(hour);
                if (_failed.TryGetValue(hour, out var when) && _time.GetUtcNow() - when < RetryFailedAfter) continue;
                _status = new FillStatus(true, done, done + missing.Count + 1, hour, problem);
                log?.LogInformation("History: rebuilding the hour {Hour} ({Done} of {Total} done)", hour.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture), done, done + missing.Count + 1);
                try
                {
                    await rebuilder.RebuildHourAsync(hour, ct);
                    _failed.Remove(hour);
                    done++;
                }
                catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
                {
                    _failed[hour] = _time.GetUtcNow();
                    failed++;
                    problem = e.Message;
                    log?.LogWarning("History: could not rebuild the hour {Hour}, it is tried again in {Minutes:0} minutes: {Reason}", hour.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture), RetryFailedAfter.TotalMinutes, e.Message);
                }
            }
            _status = new FillStatus(false, done, done, null, problem);
            log?.LogInformation("History: filling pass ended: {Done} hours done, {Failed} failed, {Seconds:0} s", done, failed, clock.Elapsed.TotalSeconds);
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
