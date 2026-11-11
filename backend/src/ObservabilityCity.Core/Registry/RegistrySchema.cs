using System.Text.Json;
using System.Text.Json.Nodes;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Core.Registry;

/// <summary>
/// JSON schemas for the registry files, so an editor with a YAML language server completes and checks them.
/// The structure schemas ship inside the app. system-ids.schema.json lists this registry's own ids, so `calls` and
/// town.yaml complete from what is really there. The environment schema holds the core's keys of a source; each adapter module loaded adds the keys
/// of its kinds (<see cref="ISourceSettingsReader.Schema"/>), so an editor completes those too. Regenerate after adding systems or adapters:
/// `dotnet run --project src/ObservabilityCity.Host -- --write-schema`.
/// </summary>
public static class RegistrySchema
{
    public const string FolderName = "schema";

    /// <param name="adapters">The adapter modules loaded, whose source settings the environment schema describes. Without them only the core's kinds are described.</param>
    public static IReadOnlyDictionary<string, string> Files(Registry registry, AdapterCatalog? adapters = null)
    {
        var files = new SortedDictionary<string, string>(StringComparer.Ordinal);
        var asm = typeof(RegistrySchema).Assembly;
        foreach (var resource in asm.GetManifestResourceNames().Where(r => r.EndsWith(".schema.json")))
        {
            using var stream = asm.GetManifestResourceStream(resource)!;
            using var reader = new StreamReader(stream);
            // resource names look like ObservabilityCity.Core.Registry.Schemas.pillar.schema.json
            var name = string.Join('.', resource.Split('.')[^3..]);
            files[name] = reader.ReadToEnd().ReplaceLineEndings("\n");
        }
        files["environment.schema.json"] = WithSettings(files["environment.schema.json"], adapters ?? new AdapterCatalog([]));
        files["system-ids.schema.json"] = SystemIds(registry);
        return files;
    }

    public static void Write(Registry registry, string registryFolder, AdapterCatalog? adapters = null)
    {
        var dir = Path.Combine(registryFolder, FolderName);
        Directory.CreateDirectory(dir);
        foreach (var (name, text) in Files(registry, adapters))
            File.WriteAllText(Path.Combine(dir, name), text.TrimEnd() + "\n");
    }

    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>
    /// The environment schema with the settings of each source kind the loaded modules know: one <c>if kind is one of these, then these keys</c> for each
    /// settings reader, with the reader's fragment, and the core's keys only for the kinds that take none. The fragments' shared definitions join the
    /// schema's own <c>$defs</c>; two modules that define one name differently are a mistake in a module, so it throws.
    /// </summary>
    private static string WithSettings(string schema, AdapterCatalog adapters)
    {
        var root = JsonNode.Parse(schema)!.AsObject();
        var core = root["properties"]!["sources"]!["additionalProperties"]!["properties"]!.AsObject().Select(p => p.Key).ToList();
        var defs = new JsonObject();
        var branches = new JsonArray();
        foreach (var (reader, kinds) in adapters.SettingsReaders())
        {
            var keys = new JsonObject();
            foreach (var key in core) keys[key] = true;
            if (reader?.Schema is { } text)
            {
                var fragment = JsonNode.Parse(text)!.AsObject();
                foreach (var (name, def) in fragment["$defs"]?.AsObject() ?? [])
                {
                    if (defs[name] is { } existing && !JsonNode.DeepEquals(existing, def))
                        throw new InvalidOperationException($"two adapter modules define the schema '$defs/{name}' differently; one of them must rename it");
                    defs[name] = def!.DeepClone();
                }
                foreach (var (name, property) in fragment["properties"]?.AsObject() ?? []) keys[name] = property!.DeepClone();
            }
            branches.Add(new JsonObject
            {
                ["if"] = new JsonObject { ["properties"] = new JsonObject { ["kind"] = new JsonObject { ["enum"] = new JsonArray([.. kinds.Select(k => (JsonNode)k)]) } }, ["required"] = new JsonArray("kind") },
                ["then"] = new JsonObject { ["properties"] = keys, ["additionalProperties"] = false },
            });
        }
        return schema
            .Replace("  \"$defs\": {},", "  \"$defs\": " + Indent(defs.ToJsonString(Indented), "  ") + ",")
            .Replace("        \"allOf\": []", "        \"allOf\": " + Indent(branches.ToJsonString(Indented), "        "));
    }

    private static string Indent(string json, string by) => json.ReplaceLineEndings("\n").Replace("\n", "\n" + by);

    private static string SystemIds(Registry registry)
    {
        var ids = registry.AllNodes.Select(n => n.Id).Order(StringComparer.Ordinal).ToList();
        var pillars = registry.Groups.Where(g => !g.IsHub).Select(g => g.Id).ToList();
        // a list to complete from, and a pattern so an id that does not exist yet is still allowed
        var schema = new Dictionary<string, object>
        {
            ["$schema"] = "http://json-schema.org/draft-07/schema#",
            ["$comment"] = "Generated from this registry. Run: dotnet run --project src/ObservabilityCity.Host -- --write-schema",
            ["$defs"] = new Dictionary<string, object>
            {
                ["systemId"] = new Dictionary<string, object>
                {
                    ["anyOf"] = new object[]
                    {
                        new Dictionary<string, object> { ["enum"] = ids },
                        new Dictionary<string, object> { ["type"] = "string", ["pattern"] = "^[a-z0-9-]+\\.[a-z0-9-]+$" },
                    },
                },
                ["pillarId"] = new Dictionary<string, object>
                {
                    ["anyOf"] = new object[]
                    {
                        new Dictionary<string, object> { ["enum"] = pillars },
                        new Dictionary<string, object> { ["type"] = "string", ["pattern"] = "^[a-z0-9-]+$" },
                    },
                },
            },
        };
        return JsonSerializer.Serialize(schema, new JsonSerializerOptions { WriteIndented = true }).ReplaceLineEndings("\n");
    }
}
