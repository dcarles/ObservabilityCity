using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace ObservabilityCity.Core.Sources;

/// <summary>
/// Runs one polling loop per source, each on its own interval. A source that throws only
/// stops updating its own readings, which then age into the stale state.
/// </summary>
public sealed class SourcePoller(
    IEnumerable<IMetricSource> sources,
    Registry.Registry registry,
    LatestState state,
    ILogger<SourcePoller> log) : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken) =>
        Task.WhenAll(sources.Select(s => Loop(s, stoppingToken)));

    private async Task Loop(IMetricSource source, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(source.PollInterval);
        do
        {
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(10));
                state.Update(await source.PollAsync(registry, timeout.Token));
            }
            catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                log.LogWarning(e, "Source {Source} failed; its values will go stale", source.Name);
            }
        }
        while (await WaitNext(timer, ct));
    }

    private static async Task<bool> WaitNext(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}
