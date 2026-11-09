using System.Text.RegularExpressions;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Sources;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace ObservabilityCity.Core.Registry;

/// <summary>Checks of the town file: ring capacity, database engines and the role keys of defaults. Part of <see cref="RegistryLoader"/>.</summary>
public static partial class RegistryLoader
{
    /// <summary>
    /// The ring capacity from town.yaml, within its limits, and the pillar count it allows. These are errors even in a resilient load:
    /// a town that does not fit on two rings cannot be drawn at all.
    /// </summary>
    private static int CheckRingCapacity(TownFile town, int pillarCount, List<string> errors)
    {
        var capacity = town.RingCapacity ?? Registry.DefaultRingCapacity;
        if (capacity is < Registry.MinRingCapacity or > Registry.MaxRingCapacity)
        {
            errors.Add($"town.yaml: ringCapacity must be between {Registry.MinRingCapacity} and {Registry.MaxRingCapacity}, not {capacity}");
            return Registry.DefaultRingCapacity;
        }
        var max = Registry.MaxPillars(capacity);
        if (pillarCount > max)
        {
            var needed = (pillarCount + 2) / 2;
            var hint = needed <= Registry.MaxRingCapacity
                ? $"set ringCapacity to {needed} or more in town.yaml"
                : $"{Registry.MaxPillars(Registry.MaxRingCapacity)} is the most a town can hold (ringCapacity {Registry.MaxRingCapacity})";
            errors.Add($"town.yaml: {pillarCount} pillars do not fit on two rings of {capacity}: at most {max}. {hint}. Lost & found counts as a pillar");
        }
        return capacity;
    }

    /// <summary>The company's databaseEngines: each needs a kebab-case id, a name, and one of the fixed types. Problems go to <paramref name="errors"/>.</summary>
    private static Dictionary<string, DatabaseEngine> CheckEngines(TownFile town, List<string> errors)
    {
        var engines = new Dictionary<string, DatabaseEngine>();
        foreach (var (id, e) in town.DatabaseEngines)
        {
            if (!KebabId.IsMatch(id)) { errors.Add($"town.yaml: databaseEngines id '{id}' must be lowercase kebab-case"); continue; }
            if (string.IsNullOrWhiteSpace(e.Name)) { errors.Add($"town.yaml: databaseEngines '{id}' needs a name, the engine as it should be shown (for example Cosmos DB)"); continue; }
            if (!DatabaseTypes.Names.ContainsKey(e.Type))
            {
                errors.Add($"town.yaml: databaseEngines '{id}' has type '{e.Type}', which is not a database type. Use {string.Join(", ", DatabaseTypes.All)}.{DidYouMean.Hint(e.Type, DatabaseTypes.All)}");
                continue;
            }
            engines[id] = new DatabaseEngine(id, e.Name.Trim(), e.Type);
        }
        return engines;
    }

    private static void CheckRoleKeys(DefaultsFile defaults, string fileName, List<string> errors)
    {
        foreach (var role in defaults.Keys)
            if (!Roles.Contains(role))
                errors.Add($"{fileName}: defaults for unknown role '{role}'. Use {RoleList}.{DidYouMean.Hint(role, Roles)}");
    }
}
