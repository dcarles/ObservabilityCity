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
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(source.Timeout);
                if (source is IProgressiveMetricSource progressive)
                    await progressive.PollAsync(registries.Current, found => state.Update(source.Name, found), timeout.Token);
                else
                    state.Update(source.Name, await source.PollAsync(registries.Current, timeout.Token));
            }
            catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                log.LogWarning(e, "Source {Source} failed; its values will go stale", source.Name);
            }
            cache?.Save(source.Name, state.Of(source.Name));
        }
        while (await WaitNext(timer, ct));
    }

    private static async Task<bool> WaitNext(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}
