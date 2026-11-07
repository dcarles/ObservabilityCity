using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace ObservabilityCity.Core.Sources;

/// <summary>
/// Runs one polling loop per source, each on its own interval. A source that throws only
/// stops updating its own readings, which then age into the stale state.
/// </summary>
public sealed class SourcePoller(
    IEnumerable<IMetricSource> sources,
    Registry.IRegistryProvider registries,
    LatestState state,
    ILogger<SourcePoller> log,
    ReadingCache? cache = null) : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken) =>
        Task.WhenAll(sources.Select(s => Loop(s, stoppingToken)));

    private async Task Loop(IMetricSource source, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(source.PollInterval);
        do
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
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
                log.LogWarning("Source {Source} did not finish within {Seconds:0}s; its values will go stale until the next round", source.Name, source.Timeout.TotalSeconds);
            }
            catch (Exception e) when (IsNetworkHiccup(e) && !ct.IsCancellationRequested)
            {
                log.LogWarning("Source {Source} could not reach its service ({Reason}); its values will go stale until the next round", source.Name, Root(e).Message);
            }
            catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                log.LogWarning(e, "Source {Source} failed; its values will go stale", source.Name);
            }
            cache?.Save(source.Name, state.Of(source.Name));
        }
        while (source is IRetrySoon { RetryIn: { } soon } ? await WaitSoon(soon, ct) : await WaitNext(timer, ct));
    }

    /// <summary>A connection that dropped or could not be made: not a bug in a source, so it needs no stack trace. Answers such as 403 are not these and stay loud.</summary>
    private static bool IsNetworkHiccup(Exception e) =>
        e is System.Net.Http.HttpRequestException { StatusCode: null } or System.IO.IOException or System.Net.Sockets.SocketException
        || e.InnerException is { } inner && IsNetworkHiccup(inner);

    private static Exception Root(Exception e) => e.InnerException is { } inner ? Root(inner) : e;

    private static async Task<bool> WaitSoon(TimeSpan soon, CancellationToken ct)
    {
        try { await Task.Delay(soon, ct); return true; }
        catch (OperationCanceledException) { return false; }
    }

    private static async Task<bool> WaitNext(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}
