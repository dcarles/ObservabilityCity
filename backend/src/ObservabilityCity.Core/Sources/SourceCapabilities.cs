namespace ObservabilityCity.Core.Sources;

/// <summary>
/// What a source of a kind can do besides filling signals. A module declares it for each kind it registers (<see cref="SourceKindInfo.Capabilities"/>);
/// the core asks the <see cref="AdapterCatalog"/> for a capability and never compares a kind's name, so any adapter's source can read the logs, find
/// links, read the inventory or report the cloud's own health.
/// </summary>
[Flags]
public enum SourceCapabilities
{
    None = 0,

    /// <summary>Answers the Logs tab's query (<c>logs.source</c>). Its source implements <see cref="Logs.ILogRowSource"/>.</summary>
    Logs = 1,

    /// <summary>Answers the link discovery and link traffic queries (<c>links.source</c>). Its source implements <see cref="Links.IDependencySource"/>.</summary>
    Links = 2,

    /// <summary>Reads the inventory that fills the environment's <see cref="Scope.ScopeStore"/> (<c>scope.inventory</c>).</summary>
    Inventory = 4,

    /// <summary>Reads the cloud's own health reports. Its source implements <see cref="IHealthEventSource"/> and fills no signal, so no signal has to name it.</summary>
    HealthEvents = 8,
}

/// <summary>What the core asks about a source kind. The <see cref="AdapterCatalog"/> answers from what the loaded modules declared.</summary>
public interface ISourceKindCatalog
{
    /// <summary>True when a loaded module (or the core) knows the kind.</summary>
    bool Knows(string kind);

    /// <summary>What a source of the kind can do; <see cref="SourceCapabilities.None"/> for a kind nobody knows.</summary>
    SourceCapabilities CapabilitiesOf(string kind);

    /// <summary>How the module of the kind reads its sources' own settings; null for a kind that takes none, or that nobody knows.</summary>
    ISourceSettingsReader? SettingsOf(string kind) => null;
}
