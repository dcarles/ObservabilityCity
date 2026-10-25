using System.Reflection;
using System.Text.Json;

namespace ObservabilityCity.Core.Registry;

/// <summary>
/// JSON schemas for the registry files, so an editor with a YAML language server completes and checks them.
/// The structure schemas ship inside the app. system-ids.schema.json lists this registry's own ids, so `calls` and
/// layout.yaml complete from what is really there. Regenerate after adding systems: `dotnet run --project src/ObservabilityCity.Host -- --write-schema`.
/// </summary>
public static class RegistrySchema
{
    public const string FolderName = "schema";

    public static IReadOnlyDictionary<string, string> Files(Registry registry)
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
        files["system-ids.schema.json"] = SystemIds(registry);
        return files;
    }

    public static void Write(Registry registry, string registryFolder)
    {
        var dir = Path.Combine(registryFolder, FolderName);
        Directory.CreateDirectory(dir);
        foreach (var (name, text) in Files(registry))
            File.WriteAllText(Path.Combine(dir, name), text.TrimEnd() + "\n");
    }

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
