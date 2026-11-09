using System.Text.RegularExpressions;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace ObservabilityCity.Validate;

/// <summary>Rules about the environment files and the fake source. Part of <see cref="RegistryValidator"/>.</summary>
public static partial class RegistryValidator
{
    private static void CheckEnvironments(Context c, Registry registry, AdapterCatalog? adapters)
    {
        var tenanted = registry.AllNodes.Where(n => n.TenantPattern is not null).ToList();
        if (registry.Environments.Count == 0)
        {
            foreach (var n in tenanted)
            {
                var at = c.Locate(n.Id);
                c.Warn(at.File, at.Line, "tenants", $"'{n.Id}' has a tenantPattern, but the town has no environments folder, so there are no tenants to draw. Add environments/{{env}}.yaml with a tenants list.");
            }
            return;
        }
        foreach (var env in registry.Environments)
        {
            var file = $"environments/{env.Id}.yaml";
            foreach (var problem in adapters?.Check(env) ?? [])
                c.Error(file, 1, "sources", problem.StartsWith(file + ": ") ? problem[(file.Length + 2)..] : problem);
            foreach (var warning in Registry.EnvironmentWarnings(env, registry.ForEnvironment(env.Id)))
                c.Warn(file, 1, "tenants", warning);
        }
    }

    // ── fake data ───────────────────────────────────────────────────────────

    private static void CheckFake(Context c, Registry registry)
    {
        var path = Path.Combine(c.Folder, "fake.yaml");
        if (!File.Exists(path)) return;
        try
        {
            FakeProfiles.Load(c.Folder);
        }
        catch (Exception e)
        {
            var inner = e.InnerException ?? e;
            var line = (e as YamlException)?.Start.Line ?? (inner as YamlException)?.Start.Line ?? 1;
            c.Error("fake.yaml", (int)Math.Max(1, line), "fake", $"fake.yaml cannot be read: {inner.Message}");
            return;
        }

        var ids = registry.AllNodes.Concat(registry.Vendors.Select(v => v.Node)).Select(n => n.Id).ToHashSet(); // vendors have fake profiles too
        var aliases = c.Aliases();
        var raw = c.Raw("fake.yaml");
        if (raw.Root is null) return;
        foreach (var (key, value) in raw.Root.Children)
        {
            var id = RawYaml.Str(key) ?? "?";
            var line = RawYaml.Line(key);
            var skipped = registry.Groups.Any(g => g.ConfigError is not null && id.StartsWith(g.Id + "."));
            if (!ids.Contains(id) && !aliases.Contains(id) && !skipped) // a pillar that failed to load has no systems to name
                c.Error("fake.yaml", line, "fake", $"fake.yaml describes '{id}', which is not a system in this town.{DidYouMean.Hint(id, ids)}");
            if (value is not YamlMappingNode profile) continue;
            foreach (var field in new[] { "rps", "p99Ms", "perInstanceRps" })
                if (RawYaml.Get(profile, field) is { } f && RawYaml.Number(f) is not >= 0)
                    c.Error("fake.yaml", RawYaml.Line(f), "fake", $"{id}: {field} must be a number, 0 or more.");
            if (RawYaml.Get(profile, "perInstanceRps") is { } per && RawYaml.Number(per) is 0)
                c.Error("fake.yaml", RawYaml.Line(per), "fake", $"{id}: perInstanceRps must be above 0, or the autoscaler would divide by zero.");
            if (RawYaml.Get(profile, "errorRate") is { } er && RawYaml.Number(er) is not (>= 0 and <= 1))
                c.Error("fake.yaml", RawYaml.Line(er), "fake", $"{id}: errorRate must be a share between 0 and 1.");
            if (RawYaml.Get(profile, "regions") is { } regions)
            {
                if (regions is not YamlMappingNode weights || weights.Children.Count < 2)
                    c.Error("fake.yaml", RawYaml.Line(regions), "fake", $"{id}: regions needs two or more entries of region name and weight, or the region view would not show.");
                else
                    foreach (var (name, weight) in weights.Children)
                        if (RawYaml.Number(weight) is not > 0)
                            c.Error("fake.yaml", RawYaml.Line(weight), "fake", $"{id}: the weight of region '{RawYaml.Str(name)}' must be a number above 0.");
            }
            var min = RawYaml.Get(profile, "minInstances");
            var max = RawYaml.Get(profile, "maxInstances");
            if (min is not null && RawYaml.Number(min) is not >= 1)
                c.Error("fake.yaml", RawYaml.Line(min), "fake", $"{id}: minInstances must be 1 or more.");
            if (min is not null && max is not null && RawYaml.Number(min) > RawYaml.Number(max))
                c.Error("fake.yaml", RawYaml.Line(min), "fake", $"{id}: minInstances ({RawYaml.Str(min)}) is above maxInstances ({RawYaml.Str(max)}).");
        }
    }

    private static void CheckFakeAssets(Context c, Registry registry)
    {
        if (!File.Exists(Path.Combine(c.Folder, "fake-assets.yaml"))) return;
        try
        {
            var pillars = registry.Groups.Select(g => g.Id).ToHashSet();
            foreach (var a in FakeAssets.Load(c.Folder))
                if (!pillars.Contains(a.PillarId))
                    c.Error("fake-assets.yaml", 1, "fake", $"fake-assets.yaml puts '{a.Name}' in '{a.PillarId}', which is not a pillar of this town.{DidYouMean.Hint(a.PillarId, pillars)}");
        }
        catch (Exception e)
        {
            var inner = e.InnerException ?? e;
            c.Error("fake-assets.yaml", (int)Math.Max(1, (inner as YamlException)?.Start.Line ?? 1), "fake", $"fake-assets.yaml cannot be read: {inner.Message}");
        }
    }
}
