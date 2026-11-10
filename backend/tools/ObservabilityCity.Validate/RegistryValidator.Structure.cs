using System.Text.RegularExpressions;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace ObservabilityCity.Validate;

/// <summary>Rules about the shape of the town: its file, colours and names, layout, calls, the hub and which systems are never called. Part of <see cref="RegistryValidator"/>.</summary>
public static partial class RegistryValidator
{
    private static void CheckTown(Context c)
    {
        var town = c.Raw("town.yaml");
        if (town.Root is null) return;
        var topology = RawYaml.Get(town.Root, "topology");
        if (topology is not null && RawYaml.Str(topology) is { } t && !Topologies.Contains(t))
            c.Error("town.yaml", RawYaml.Line(topology), "topology", $"topology '{t}' is not known. Use {string.Join(" or ", Topologies)}.{DidYouMean.Hint(t, Topologies)}");
        // fake data and stories belong to a demo town: in a live one they would never be used, and someone probably forgot to say it is a demo
        var mode = RawYaml.Get(town.Root, "mode");
        var demo = mode is not null && RawYaml.Str(mode) == TownModes.Demo;
        if (!demo && (File.Exists(Path.Combine(c.Folder, "fake.yaml")) || File.Exists(Path.Combine(c.Folder, "fake-assets.yaml")) || Directory.Exists(Path.Combine(c.Folder, "stories"))))
            c.Error("town.yaml", mode is null ? 1 : RawYaml.Line(mode), "mode", "This town has demo files (fake.yaml or stories/) but is not set to demo, so it runs live and never uses them. Add 'mode: demo' to town.yaml, or remove the demo files.");
        foreach (var key in new[] { "id", "name" })
            if (string.IsNullOrWhiteSpace(RawYaml.Str(RawYaml.Get(town.Root, key))))
                c.Error("town.yaml", 1, "town", $"town.yaml needs a non-empty '{key}'.");
    }

    private static void CheckColoursAndNames(Context c, Registry registry)
    {
        foreach (var file in c.RootFiles("hub.yaml").Concat(c.PillarFiles()))
        {
            var raw = c.Raw(file);
            if (raw.Root is null) continue;
            if (RawYaml.Get(raw.Root, "color") is { } colour && RawYaml.Str(colour) is { } text && !Colour.IsMatch(text))
                c.Error(file, RawYaml.Line(colour), "colour", $"color '{text}' is not a hex colour. Write it like \"#5aa9ff\" (quoted, so YAML keeps the #).");
            if (file != "hub.yaml" && string.IsNullOrWhiteSpace(RawYaml.Str(RawYaml.Get(raw.Root, "displayName"))))
                c.Error(file, 1, "name", "The pillar has no displayName, so its island would have a blank sign.");
        }
        foreach (var g in registry.Groups.Where(g => !g.IsHub && g.ConfigError is null && g.Nodes.Count == 0))
            c.Warn(c.PillarFile(g.Id), 1, "empty", $"Pillar '{g.Id}' has no systems, so its island would be empty.");
    }

    // ── layout ──────────────────────────────────────────────────────────────

    private static void CheckLayout(Context c, Registry registry)
    {
        var pillars = registry.Groups.Where(g => !g.IsHub).ToList();
        var layout = c.Raw("town.yaml");
        if (layout.Root is null) return;
        if (RawYaml.Get(layout.Root, "islands") is null)
        {
            if (pillars.Count > 1)
                c.Warn("town.yaml", 1, "layout", "town.yaml has no islands list, so islands stand round the hub in file-name order.");
        }
        else
        {
            var listed = RawYaml.Items(RawYaml.Get(layout.Root, "islands")).Select(RawYaml.Str).ToHashSet();
            foreach (var g in pillars.Where(g => !g.IsLostFound && !listed.Contains(g.Id)))
                c.Error(c.PillarFile(g.Id), 1, "layout", $"Pillar '{g.Id}' is missing from the islands list in town.yaml, so its place round the hub is an accident of file order. Add '{g.Id}' to islands.");
        }
    }

    // ── thresholds ──────────────────────────────────────────────────────────

    private static void CheckCalls(Context c, Registry registry)
    {
        if (registry.Town.Topology != "hub-and-spoke") return;
        var groupOf = registry.Groups.SelectMany(g => g.Nodes.Select(n => (n.Id, g))).ToDictionary(x => x.Id, x => x.g);
        foreach (var g in registry.Groups.Where(g => !g.IsHub))
            foreach (var n in g.Nodes)
                foreach (var callee in n.Calls)
                {
                    var target = groupOf[callee];
                    if (target.IsHub || target.Id == g.Id) continue;
                    var at = c.Locate(n.Id, callee);
                    c.Error(at.File, at.Line, "cross-pillar-call",
                        $"'{n.Id}' calls '{callee}' in pillar '{target.Id}' directly. In a hub-and-spoke town calls between pillars go through the hub: call the hub's gateway or message broker instead, or set topology: direct.");
                }
    }

    private static void CheckHub(Context c, Registry registry)
    {
        var allowed = new[] { NodeKind.Gateway, NodeKind.Broker, NodeKind.Egress, NodeKind.Database };
        var seen = new HashSet<NodeKind>();
        foreach (var n in registry.Groups.Where(g => g.IsHub).SelectMany(g => g.Nodes))
        {
            var at = c.Locate(n.Id);
            if (!allowed.Contains(n.Kind))
                c.Error(at.File, at.Line, "hub", $"'{n.Id}' has role {n.Kind.ToString().ToLowerInvariant()}, but the hub only draws a gateway, broker, egress and database.");
            else if (!seen.Add(n.Kind))
                c.Error(at.File, at.Line, "hub", $"'{n.Id}' is a second {n.Kind.ToString().ToLowerInvariant()} on the hub, which has room for one of each.");
        }
    }

    private static void CheckExternalCallers(Context c, Registry registry)
    {
        var hub = c.Raw("hub.yaml");
        foreach (var caller in registry.ExternalCallers.Where(x => x.Calls.Count == 0))
        {
            var line = hub.FindScalar(caller.Id) ?? 1;
            c.Warn("hub.yaml", line, "external-caller", $"External caller '{caller.Id}' reaches no system, so no traffic is drawn for it.");
        }
    }

    // ── services ────────────────────────────────────────────────────────────

    private static void CheckWorkersHaveDatabases(Context c, Registry registry)
    {
        foreach (var g in registry.Groups.Where(g => !g.IsHub && g.ConfigError is null))
        {
            var dbs = g.Nodes.Where(n => n.Kind == NodeKind.Database).ToList();
            foreach (var w in g.Nodes.Where(n => n.Kind == NodeKind.Worker))
            {
                var hasDb = w.Calls.Any(id => dbs.Any(d => d.Id == id)) || (w.Service is not null && dbs.Any(d => d.Service == w.Service));
                if (hasDb) continue;
                var at = c.Locate(w.Id);
                c.Warn(at.File, at.Line, "worker-db", $"Worker '{w.Id}' has no database: none in its service and none under calls. Workers normally keep their state somewhere.");
            }
        }
    }

    private static void CheckUncalled(Context c, Registry registry)
    {
        var called = registry.AllNodes.SelectMany(n => n.Calls).Concat(registry.ExternalCallers.SelectMany(x => x.Calls)).ToHashSet();
        foreach (var g in registry.Groups.Where(g => !g.IsHub && !g.IsLostFound))
            foreach (var n in g.Nodes.Where(n => n.Kind is NodeKind.Api or NodeKind.Cache or NodeKind.Database && !n.External && !called.Contains(n.Id)))
            {
                var at = c.Locate(n.Id);
                c.Warn(at.File, at.Line, "uncalled", $"Nothing calls '{n.Id}': no system lists it under calls and it is not external. It will sit idle on the map; add the caller or mark it external.");
            }
    }

    private static void CheckStandalone(Context c, Registry registry)
    {
        foreach (var g in registry.Groups.Where(g => !g.IsHub && g.ConfigError is null && g.Nodes.Count > 0 && TownLinks.Of(registry)[g.Id].Standalone))
            c.Warn(c.PillarFile(g.Id), 1, "standalone", $"Island '{g.Id}' stands alone: it has no API, no topics or subscriptions, no calls to or from other islands and no third party, so nothing connects it to the town. Add an API, a messaging block or a calls link.");
    }
}
