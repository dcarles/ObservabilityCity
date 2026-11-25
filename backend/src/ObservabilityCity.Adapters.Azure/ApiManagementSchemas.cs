using System.Text.Json;
using ObservabilityCity.Contracts;

namespace ObservabilityCity.Adapters.Azure;

/// <summary>
/// Reads the request and response bodies an API Management operation describes. An operation names a body by content type and, usually, by a schema id and a type name; the shared
/// definitions sit once on the API (<c>/schemas</c>), as an OpenAPI <c>components.schemas</c> or a Swagger <c>definitions</c> block. Pure, so tests feed it recorded answers.
/// </summary>
public static class ApiManagementSchemas
{
    private const int MaxDepth = 6;
    private const int MaxFields = 60;

    public static string SchemasUrl(string gatewayId, string api) => $"{Azure.AzureMonitorReader.Endpoint}{gatewayId.TrimEnd('/')}/apis/{Uri.EscapeDataString(api)}/schemas?api-version={ApiManagementReading.ApiVersion}&$top=100";

    public static string SchemaUrl(string gatewayId, string api, string schema) =>
        $"{Azure.AzureMonitorReader.Endpoint}{gatewayId.TrimEnd('/')}/apis/{Uri.EscapeDataString(api)}/schemas/{Uri.EscapeDataString(schema)}?api-version={ApiManagementReading.ApiVersion}";

    /// <summary>
    /// The schemas of one API as the list names them: each with its id and, when the answer carries it, its definitions. The service's list holds only the id and the content type, so
    /// the definitions are then read one schema at a time (<see cref="ParseSchema"/>).
    /// </summary>
    public static IReadOnlyList<(string Id, JsonDocument? Definitions)> ParseSchemaList(string json)
    {
        var found = new List<(string, JsonDocument?)>();
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("value", out var value) || value.ValueKind != JsonValueKind.Array) return found;
        foreach (var item in value.EnumerateArray())
        {
            if (!item.TryGetProperty("name", out var n) || n.GetString() is not { } id) continue;
            found.Add((id, item.TryGetProperty("properties", out var p) ? Definitions(p) : null));
        }
        return found;
    }

    /// <summary>The definitions of one schema, as the JSON object that holds its types, or null when it has none or is in another format (an XSD, say).</summary>
    public static JsonDocument? ParseSchema(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.TryGetProperty("properties", out var p) ? Definitions(p) : null;
    }

    private static JsonDocument? Definitions(JsonElement properties)
    {
        if (!properties.TryGetProperty("document", out var document)) return null;
        try { return document.ValueKind == JsonValueKind.String ? JsonDocument.Parse(document.GetString()!) : JsonDocument.Parse(document.GetRawText()); }
        catch (JsonException) { return null; }
    }

    /// <summary>The bodies of one <c>representations</c> array.</summary>
    public static IReadOnlyList<ApiRepresentation> Representations(JsonElement owner, IReadOnlyDictionary<string, JsonDocument> schemas)
    {
        var list = new List<ApiRepresentation>();
        if (!owner.TryGetProperty("representations", out var reps) || reps.ValueKind != JsonValueKind.Array) return list;
        foreach (var r in reps.EnumerateArray())
        {
            var contentType = Text(r, "contentType") ?? "";
            var typeName = Text(r, "typeName");
            var schemaId = Text(r, "schemaId");
            var fields = schemaId is not null && typeName is not null && schemas.TryGetValue(schemaId, out var document) ? Fields(document.RootElement, typeName) : [];
            list.Add(new ApiRepresentation(contentType, typeName, Example(r), fields));
        }
        return list;
    }

    private static string? Example(JsonElement representation)
    {
        if (representation.TryGetProperty("examples", out var examples) && examples.ValueKind == JsonValueKind.Object)
            foreach (var e in examples.EnumerateObject())
                if (e.Value.TryGetProperty("value", out var v))
                    return v.ValueKind == JsonValueKind.String ? v.GetString() : JsonSerializer.Serialize(v, new JsonSerializerOptions { WriteIndented = true });
        return Text(representation, "sample");
    }

    private static string? Text(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static JsonElement? Types(JsonElement document)
    {
        if (document.ValueKind != JsonValueKind.Object) return null;
        if (document.TryGetProperty("components", out var c) && c.TryGetProperty("schemas", out var s)) return s;
        if (document.TryGetProperty("definitions", out var d)) return d;
        return null;
    }

    /// <summary>The fields of one named type, a few levels deep (a type that contains itself stops there).</summary>
    public static IReadOnlyList<ApiField> Fields(JsonElement document, string typeName)
    {
        if (Types(document) is not { } types || types.ValueKind != JsonValueKind.Object || !types.TryGetProperty(typeName, out var root)) return [];
        var budget = MaxFields;
        return Properties(types, root, new HashSet<string> { typeName }, 1, ref budget);
    }

    private static JsonElement Resolve(JsonElement types, JsonElement schema, ISet<string> seen, out string? name)
    {
        name = null;
        for (var hops = 0; hops < 8 && schema.ValueKind == JsonValueKind.Object && schema.TryGetProperty("$ref", out var r) && r.GetString() is { } reference; hops++)
        {
            name = reference[(reference.LastIndexOf('/') + 1)..];
            if (!types.TryGetProperty(name, out schema)) return default;
        }
        return schema;
    }

    private static IReadOnlyList<ApiField> Properties(JsonElement types, JsonElement schema, ISet<string> path, int depth, ref int budget)
    {
        schema = Resolve(types, schema, path, out _);
        if (schema.ValueKind != JsonValueKind.Object) return [];
        var fields = new List<ApiField>();
        var required = new HashSet<string>(StringComparer.Ordinal);
        if (schema.TryGetProperty("required", out var req) && req.ValueKind == JsonValueKind.Array)
            foreach (var r in req.EnumerateArray()) if (r.GetString() is { } rn) required.Add(rn);
        if (schema.TryGetProperty("allOf", out var all) && all.ValueKind == JsonValueKind.Array)
            foreach (var part in all.EnumerateArray()) fields.AddRange(Properties(types, part, path, depth, ref budget));
        if (schema.TryGetProperty("properties", out var props) && props.ValueKind == JsonValueKind.Object)
            foreach (var p in props.EnumerateObject())
            {
                if (budget-- <= 0) break;
                var value = Resolve(types, p.Value, path, out var refName);
                var (type, childSchema, childName) = Describe(types, value, refName);
                IReadOnlyList<ApiField> children = [];
                if (childSchema is { } cs && depth < MaxDepth && (childName is null || !path.Contains(childName)))
                {
                    var next = new HashSet<string>(path);
                    if (childName is not null) next.Add(childName);
                    children = Properties(types, cs, next, depth + 1, ref budget);
                }
                fields.Add(new ApiField(p.Name, type, required.Contains(p.Name), Text(p.Value, "description") ?? Text(value, "description"), children));
            }
        return fields;
    }

    /// <summary>The words for a field's type, and the schema to open when it has fields of its own.</summary>
    private static (string Type, JsonElement? Children, string? Name) Describe(JsonElement types, JsonElement value, string? refName)
    {
        if (value.ValueKind != JsonValueKind.Object) return (refName ?? "any", null, refName);
        var type = Text(value, "type");
        var format = Text(value, "format");
        if (type == "array" && value.TryGetProperty("items", out var items))
        {
            var item = Resolve(types, items, new HashSet<string>(), out var itemName);
            var (inner, _, _) = Describe(types, item, itemName);
            return ($"array of {inner}", item, itemName);
        }
        var words = refName ?? (type is null ? (value.TryGetProperty("properties", out _) ? "object" : "any") : format is null ? type : $"{type} ({format})");
        if (value.TryGetProperty("enum", out var values) && values.ValueKind == JsonValueKind.Array)
            words += " · enum " + string.Join(", ", values.EnumerateArray().Take(8).Select(v => v.ToString()));
        return (words, value.TryGetProperty("properties", out _) || value.TryGetProperty("allOf", out _) ? value : null, refName);
    }
}
