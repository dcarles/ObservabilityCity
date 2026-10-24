using Microsoft.OpenApi.Models;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace ObservabilityCity.Host;

/// <summary>
/// Snapshot records always send every property, so the generated TypeScript should not make them optional.
/// Only properties that can be null stay optional.
/// </summary>
public sealed class RequireAllPropertiesFilter : ISchemaFilter
{
    public void Apply(OpenApiSchema schema, SchemaFilterContext context)
    {
        if (schema.Properties is null) return;
        foreach (var (name, prop) in schema.Properties)
            if (!prop.Nullable) schema.Required.Add(name);
    }
}
