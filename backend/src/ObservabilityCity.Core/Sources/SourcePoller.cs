using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace ObservabilityCity.Core.Sources;

/// <summary>
/// Runs one polling loop per source, each on its own interval. A source that throws only
/// stops updating its own readings, which then age into the stale state. A source that keeps failing is asked less often
/// (twice the interval after the second failed round in a row, four times from the third, never beyond five minutes unless
/// its own interval is longer) and goes back to its interval as soon as one round works. The log says so once when a source
/// starts failing, now and then while it goes on (<see cref="ReminderEvery"/>), and once when it is back, with how long it was down.
/// </summary>
public sealed class SourcePoller(
    IEnumerable<IMetricSource> sources,
    Registry.IRegistryProvider registries,
    LatestState state,
    ILogger<SourcePoller> log,
    ReadingCache? cache = null,
    TimeProvider? time = null) : BackgroundService
{
    /// <summary>How often a source that stays down is mentioned again in the log.</summary>
    public static readonly TimeSpan ReminderEvery = TimeSpan.FromMinutes(5);

    /// <summary>The longest pause a failing source is given between two asks, unless its own interval is longer.</summary>
    public static readonly TimeSpan LongestBackoff = TimeSpan.FromMinutes(5);

    private readonly TimeProvider _time = time ?? TimeProvider.System;

    protected override Task ExecuteAsync(CancellationToken stoppingToken) =>
        Task.WhenAll(sources.Select(s => Loop(s, stoppingToken)));

    /// <summary>How long to wait after this many failed rounds in a row (0 for none).</summary>
    public static TimeSpan Pause(TimeSpan interval, int failedInARow)
    {
        var times = failedInARow switch { <= 1 => 1, 2 => 2, _ => 4 };
        var wait = interval * times;
        var cap = interval > LongestBackoff ? interval : LongestBackoff;
        return wait > cap ? cap : wait;
    }

    private async Task Loop(IMetricSource source, CancellationToken ct)
    {
        var timer = new PeriodicTimer(source.PollInterval, _time);
        var failed = 0;
        DateTimeOffset? downSince = null;
        var lastMention = default(DateTimeOffset);
        try
        {
            while (true)
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                string? problem = null;
                Exception? detail = null;
                try
                {
                    timeout.CancelAfter(source.Timeout);
                    if (source is IProgressiveMetricSource progressive)
                        await progressive.PollAsync(registries.Current, found => state.Update(source.Name, found), timeout.Token);
                    else
                        state.Update(source.Name, await source.PollAsync(registries.Current, timeout.Token));
                    if (source is IRoundNote { RoundNote: { } note }) log.LogInformation("Source {Source}: {Note}", source.Name, note);
                }
                catch (Exception e) when (e is OperationCanceledException && timeout.IsCancellationRequested && !ct.IsCancellationRequested)
                {
                    // a round that ran out of time is expected now and then (slow cloud, a laptop that slept): one line, no stack trace
                    problem = $"did not finish within {source.Timeout.TotalSeconds:0}s";
                }
                catch (Exception e) when (IsNetworkHiccup(e) && !ct.IsCancellationRequested)
                {
                    problem = $"could not reach its service ({Root(e).Message})";
                }
                catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
                {
                    problem = "failed";
                    detail = e;
                }

                var now = _time.GetUtcNow();
                if (problem is null)
                {
                    if (downSince is { } since) log.LogInformation("Source {Source} is back after {Down} ({Rounds} failed rounds)", source.Name, Length(now - since), failed);
                    failed = 0;
                    downSince = null;
                }
                else
                {
                    failed++;
                    downSince ??= now;
                    if (failed == 1)
                    {
                        lastMention = now;
                        if (detail is null) log.LogWarning("Source {Source} {Problem}; its values will go stale until the next round", source.Name, problem);
                        else log.LogWarning(detail, "Source {Source} {Problem}; its values will go stale", source.Name, problem);
                    }
                    else if (now - lastMention >= ReminderEvery)
                    {
                        lastMention = now;
                        log.LogWarning("Source {Source} has been failing for {Down} ({Rounds} rounds in a row); last problem: {Problem}", source.Name, Length(now - downSince.Value), failed, detail?.Message ?? problem);
                    }
                }
                cache?.Save(source.Name, state.Of(source.Name));

                if (source is IRetrySoon { RetryIn: { } soon })
                {
                    if (!await WaitSoon(soon, ct)) return;
                }
                else if (failed >= 2)
                {
                    // asked less often while it keeps failing; the timer is made again afterwards so that no tick is waiting when the source is back
                    timer.Dispose();
                    var gone = !await WaitSoon(Pause(source.PollInterval, failed), ct);
                    timer = new PeriodicTimer(source.PollInterval, _time);
                    if (gone) return;
                }
                else if (!await WaitNext(timer, ct)) return;
            }
        }
        finally { timer.Dispose(); }
    }

    private static string Length(TimeSpan t) => t.TotalMinutes >= 1 ? $"{t.TotalMinutes:0} min" : $"{t.TotalSeconds:0} s";

    /// <summary>A connection that dropped or could not be made: not a bug in a source, so it needs no stack trace. Answers such as 403 are not these and stay loud.</summary>
    private static bool IsNetworkHiccup(Exception e) =>
        e is System.Net.Http.HttpRequestException { StatusCode: null } or System.IO.IOException or System.Net.Sockets.SocketException
        || e.InnerException is { } inner && IsNetworkHiccup(inner);

    private static Exception Root(Exception e) => e.InnerException is { } inner ? Root(inner) : e;

    private async Task<bool> WaitSoon(TimeSpan soon, CancellationToken ct)
    {
        try { await Task.Delay(soon, _time, ct); return true; }
        catch (OperationCanceledException) { return false; }
    }

    private static async Task<bool> WaitNext(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}
