using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace ObservabilityCity.Core.Registry;

/// <summary>Where the rest of the app gets the registry from. It can change while the app runs (see <see cref="RegistryReloader"/>).</summary>
public interface IRegistryProvider
{
    Registry Current { get; }

    /// <summary>Configuration problems that did not stop the town: skipped files, dropped links, a failed reload.</summary>
    IReadOnlyList<string> Notices { get; }
}

/// <summary>Holds the registry in use. A reload that fails leaves the last good one in place and only adds a notice.</summary>
public sealed class RegistryHolder(Registry initial) : IRegistryProvider
{
    private volatile Registry _current = initial;
    private volatile string? _reloadFailure;

    public Registry Current => _current;

    public IReadOnlyList<string> Notices =>
        _reloadFailure is null ? _current.Notices : [_reloadFailure, .. _current.Notices];

    public void Replace(Registry registry)
    {
        _current = registry;
        _reloadFailure = null;
    }

    public void Fail(string message) => _reloadFailure = $"Reload failed, still showing the last good registry: {message}";
}

/// <summary>
/// Watches the registry folder and reloads it when a file changes. A reload that throws is reported and ignored: the town
/// keeps running on the registry it already has. Polls file times instead of using file-system events, which are unreliable
/// on network and container mounts.
/// </summary>
public sealed class RegistryReloader(RegistryHolder holder, string folder, TimeSpan interval, ILogger<RegistryReloader> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (interval <= TimeSpan.Zero) return;
        var seen = Fingerprint(folder);
        using var timer = new PeriodicTimer(interval);
        try
        {
            while (await timer.WaitForNextTickAsync(ct))
            {
                var now = Fingerprint(folder);
                if (now == seen) continue;
                seen = now;
                Reload();
            }
        }
        catch (OperationCanceledException) { }
    }

    /// <summary>Loads the folder again now. Returns true when the new registry is in use.</summary>
    public bool Reload()
    {
        try
        {
            holder.Replace(RegistryLoader.LoadResilient(folder));
            log.LogInformation("Registry reloaded from {Folder}", folder);
            return true;
        }
        catch (Exception e)
        {
            holder.Fail(e.Message.ReplaceLineEndings(" "));
            log.LogWarning("Registry reload failed, keeping the last good one: {Message}", e.Message);
            return false;
        }
    }

    internal static string Fingerprint(string folder)
    {
        try
        {
            return string.Join('|', Directory.EnumerateFiles(folder, "*.yaml", SearchOption.AllDirectories)
                .OrderBy(f => f, StringComparer.Ordinal)
                .Select(f => { var i = new FileInfo(f); return $"{f}:{i.Length}:{i.LastWriteTimeUtc.Ticks}"; }));
        }
        catch (IOException) { return "unreadable"; }
    }
}
