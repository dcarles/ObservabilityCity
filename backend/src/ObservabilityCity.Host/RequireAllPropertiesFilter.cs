using System.Reflection;
using System.Text.Json;
using Microsoft.OpenApi;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace ObservabilityCity.Host;

/// <summary>
/// Snapshot records always send every property, so the generated TypeScript should not make them optional.
/// Only properties that can be null stay optional, whether the schema marks them so or only the C# declaration does.
/// </summary>
public sealed class RequireAllPropertiesFilter : ISchemaFilter
{
    public void Apply(IOpenApiSchema schema, SchemaFilterContext context)
    {
        if (schema is not OpenApiSchema concrete || concrete.Properties is null) return;
        concrete.Required ??= new HashSet<string>();
        foreach (var (name, prop) in concrete.Properties)
            if (!(prop.Type?.HasFlag(JsonSchemaType.Null) ?? false)) concrete.Required.Add(name);
        // a property that refers to another record has no type of its own to mark as null, so a nullable one is read off the C# declaration
        var nullability = new NullabilityInfoContext();
        foreach (var property in context.Type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            if (nullability.Create(property).ReadState == NullabilityState.Nullable)
                concrete.Required.Remove(JsonNamingPolicy.CamelCase.ConvertName(property.Name));
    }
}
