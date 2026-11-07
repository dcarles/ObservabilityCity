using System.Reflection;
using System.Text.Json;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace ObservabilityCity.Host;

/// <summary>
/// Snapshot records always send every property, so the generated TypeScript should not make them optional.
/// Only properties that can be null stay optional, whether the schema marks them so or only the C# declaration does.
/// </summary>
public sealed class RequireAllPropertiesTransformer : IOpenApiSchemaTransformer
{
    public Task TransformAsync(OpenApiSchema schema, OpenApiSchemaTransformerContext context, CancellationToken cancellationToken)
    {
        Normalise(schema);
        if (schema.Properties is not { Count: > 0 }) return Task.CompletedTask;
        schema.Required ??= new HashSet<string>();
        foreach (var (name, prop) in schema.Properties)
            if (!(prop.Type?.HasFlag(JsonSchemaType.Null) ?? false)) schema.Required.Add(name);
        // a property that refers to another record has no type of its own to mark as null, so a nullable one is read off the C# declaration
        var nullability = new NullabilityInfoContext();
        foreach (var property in context.JsonTypeInfo.Type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            if (nullability.Create(property).ReadState == NullabilityState.Nullable)
                schema.Required.Remove(JsonNamingPolicy.CamelCase.ConvertName(property.Name));
        return Task.CompletedTask;
    }

    /// <summary>
    /// The built-in generator describes numbers as "number or numeric string" (the web JSON defaults read numbers from strings), leaves enums without a type
    /// and adds a null member for a nullable enum. The snapshot sends plain numbers and plain enum names, and nullability is expressed through Required, so the schema says that.
    /// </summary>
    static void Normalise(OpenApiSchema schema)
    {
        schema.Default = null;
        if (schema.Type is { } t && (t.HasFlag(JsonSchemaType.Number) || t.HasFlag(JsonSchemaType.Integer)) && t.HasFlag(JsonSchemaType.String))
        {
            schema.Type = t & ~JsonSchemaType.String;
            schema.Pattern = null;
        }
        if (schema.Enum is { Count: > 0 } values)
        {
            for (var i = values.Count - 1; i >= 0; i--)
                if (values[i] is null || values[i]!.GetValueKind() == System.Text.Json.JsonValueKind.Null) values.RemoveAt(i);
            schema.Type = JsonSchemaType.String;
        }
    }
}

/// <summary>
/// Finishes the document once every schema is in place: a nullable reference to another record comes as "null or the record", which is just the reference here
/// (the property is optional through Required).
/// </summary>
public sealed class TidyDocumentTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(OpenApiDocument document, OpenApiDocumentTransformerContext context, CancellationToken cancellationToken)
    {
        if (document.Components?.Schemas is not { } schemas) return Task.CompletedTask;
        foreach (var schema in schemas.Values)
            if (schema.Properties is { } props)
                foreach (var (name, prop) in props.ToList())
                    if (prop is OpenApiSchema { OneOf: { Count: 2 } oneOf } && oneOf.FirstOrDefault(IsNullOnly) is { } nullPart && oneOf.First(o => o != nullPart) is { } other)
                        props[name] = other;
        return Task.CompletedTask;
    }

    static bool IsNullOnly(IOpenApiSchema s) =>
        s is OpenApiSchema { Type: JsonSchemaType.Null } || s is OpenApiSchema { Enum: { Count: 1 } e } && (e[0] is null || e[0]!.GetValueKind() == System.Text.Json.JsonValueKind.Null);
}
