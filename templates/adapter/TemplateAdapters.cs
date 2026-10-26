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
        registry.AddSource(new ExampleHttpSourceFactory());
    }
}
