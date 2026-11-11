using ObservabilityCity.Core.Sources;

namespace Template.Adapters;

/// <summary>
/// The module: what this adapter adds to the town. The host finds it by looking for a class that implements <see cref="IAdapterModule"/> in the
/// assemblies of adapters/&lt;name&gt;/. Registering only records what the module has; it signs nobody in and reaches nothing.
/// </summary>
public sealed class TemplateAdapters : IAdapterModule
{
    /// <summary>Lowercase kebab-case. Shown in start-up messages.</summary>
    public string Name => "template";

    public void Register(IAdapterRegistry registry)
    {
        // the kind an environment file writes: sources: { telemetry: { kind: example-http, connection: "https://..." } }
        // Say what a source of it can serve besides signals. This one fills signals only. A kind that can also answer the Logs tab, find links, read the
        // inventory or report the cloud's health declares Logs, Links, Inventory or HealthEvents here, and its source implements the matching interface.
        // Settings reads and checks the keys a source of this kind has beyond the core's (here: field). A kind without it takes no other key.
        registry.AddSourceKind(new SourceKindInfo(ExampleHttpSourceFactory.SourceKind) { Capabilities = SourceCapabilities.None, Settings = ExampleHttpSettings.Reader });
        registry.AddSource(new ExampleHttpSourceFactory());
    }
}
