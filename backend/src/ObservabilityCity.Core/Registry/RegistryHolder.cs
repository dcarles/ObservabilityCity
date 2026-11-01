using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace ObservabilityCity.Core.Registry;

/// <summary>Where the rest of the app gets the registry from. It can change while the app runs (see <see cref="RegistryReloader"/>).</summary>
public interface IRegistryProvider
{
    Registry Current { get; }

    /// <summary>Configuration problems that did not stop the town: skipped files, dropped links, a failed reload, and warnings such as an island nothing connects to.</summary>
    IReadOnlyList<string> Notices { get; }

    /// <summary>Things worth knowing that are not mistakes, such as calls to a pillar the town does not have yet. Shown apart from the problems.</summary>
    IReadOnlyList<string> Notes => [];
}

/// <summary>Holds the registry in use. A reload that fails leaves the last good one in place and only adds a notice.</summary>
public sealed class RegistryHolder(Registry initial) : IRegistryProvider
{
    private volatile Registry _current = initial;
    private volatile string? _reloadFailure;

    public Registry Current => _current;

    public IReadOnlyList<string> Notices =>
        _reloadFailure is null ? [.. _current.Notices, .. _current.Warnings] : [_reloadFailure, .. _current.Notices, .. _current.Warnings];

    /// <summary>Why the last reload failed, or null when it did not.</summary>
    public string? ReloadFailure => _reloadFailure;

    public void Replace(Registry registry)
    {
        _current = registry;
        _reloadFailure = null;
    }

    /// <summary>Loads the folder again now; a load that fails leaves the last good registry in place. True when the new one is in use.</summary>
    public bool ReloadFrom(string folder, ILogger? log = null)
    {
        try
        {
            Replace(RegistryLoader.LoadResilient(folder));
            log?.LogInformation("Registry reloaded from {Folder}", folder);
            return true;
        }
        catch (Exception e)
        {
            Fail(e.Message.ReplaceLineEndings(" "));
            log?.LogWarning("Registry reload failed, keeping the last good one: {Message}", e.Message);
            return false;
        }
    }

    public void Fail(string message) => _reloadFailure = $"Reload failed, still showing the last good registry: {message}";
}

/// <summary>
/// The registry as one environment sees it (see <see cref="Registry.ForEnvironment"/>), following the holder through reloads. The view is made
/// once for each registry the holder has, not once for each snapshot.
/// </summary>
public sealed class EnvironmentRegistry(RegistryHolder source, string environmentId, Links.DiscoveredLinks? discovered = null, TimeProvider? time = null) : IRegistryProvider
{
    private readonly object _gate = new();
    private Registry? _from;
    private Registry? _view;
    private int _discoveredVersion = -1;
    private DateOnly _day;

    public string EnvironmentId => environmentId;

    public Registry Current
    {
        get
        {
            var current = source.Current;
            var version = discovered?.Version ?? 0;
            var today = DateOnly.FromDateTime((time ?? TimeProvider.System).GetUtcNow().UtcDateTime);
            lock (_gate)
            {
                // a link ages out with the day, so the view is made again when the day changes too
                if (!ReferenceEquals(current, _from) || version != _discoveredVersion || today != _day)
                {
                    var links = discovered is not null && current.Environments.FirstOrDefault(e => e.Id == environmentId)?.Links is { } config
                        ? discovered.Found((time ?? TimeProvider.System).GetUtcNow(), config.MinDays, config.KeepFor)
                        : null;
                    _view = current.ForEnvironment(environmentId, links);
                    _from = current;
                    _discoveredVersion = version;
                    _day = today;
                }
                return _view!;
            }
        }
    }

    public IReadOnlyList<string> Notes => discovered is not null && Current.ActiveEnvironment?.Links is { } config ? discovered.Notes(config.MinDays) : [];

    public IReadOnlyList<string> Notices
    {
        get
        {
            var view = Current;
            var found = discovered is not null && view.ActiveEnvironment?.Links is { } config ? discovered.Notices(config.MinDays) : [];
            return source.ReloadFailure is { } failure ? [failure, .. view.Notices, .. view.Warnings, .. found] : [.. view.Notices, .. view.Warnings, .. found];
        }
    }
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
    public bool Reload() => holder.ReloadFrom(folder, log);

    /// <summary>Where link discovery saves what it found, under the registry folder (see <see cref="Links.DiscoveredLinks"/>).</summary>
    public const string DiscoveredFolder = "_discovered";

    internal static string Fingerprint(string folder)
    {
        try
        {
            // _discovered holds what link discovery wrote itself; a reload for that would only repeat the last one. The one file there that is read as
            // configuration, the third parties added from the panel (which may be edited by hand), does count.
            var added = Path.GetFullPath(AddedHosts.PathIn(folder));
            return string.Join('|', Directory.EnumerateFiles(folder, "*.yaml", SearchOption.AllDirectories)
                .Where(f => Path.GetFullPath(f) == added || !Path.GetRelativePath(folder, f).StartsWith(DiscoveredFolder + Path.DirectorySeparatorChar, StringComparison.Ordinal))
                .OrderBy(f => f, StringComparer.Ordinal)
                .Select(f => { var i = new FileInfo(f); return $"{f}:{i.Length}:{i.LastWriteTimeUtc.Ticks}"; }));
        }
        catch (IOException) { return "unreadable"; }
    }
}
