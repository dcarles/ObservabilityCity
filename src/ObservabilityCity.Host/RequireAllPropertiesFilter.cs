using Microsoft.OpenApi;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace ObservabilityCity.Host;

/// <summary>
/// Snapshot records always send every property, so the generated TypeScript should not make them optional.
/// Only properties that can be null stay optional.
/// </summary>
public sealed class RequireAllPropertiesFilter : ISchemaFilter
{
    public void Apply(IOpenApiSchema schema, SchemaFilterContext context)
    {
        if (schema is not OpenApiSchema concrete || concrete.Properties is null) return;
        concrete.Required ??= new HashSet<string>();
        foreach (var (name, prop) in concrete.Properties)
            if (!(prop.Type?.HasFlag(JsonSchemaType.Null) ?? false)) concrete.Required.Add(name);
    }
}
