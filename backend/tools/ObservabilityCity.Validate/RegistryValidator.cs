using System.Text.RegularExpressions;
using ObservabilityCity.Adapters.Fake;
using ObservabilityCity.Contracts;
using ObservabilityCity.Core.Registry;
using ObservabilityCity.Core.Sources;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace ObservabilityCity.Validate;

/// <summary>
/// Checks a registry folder beyond what loading it needs: the loader's own problems (format, ids, links), and then the rules that
/// keep a town readable and honest. Errors fail CI; warnings are listed and do not. Every finding names a file and a line.
/// </summary>
public static partial class RegistryValidator
{
    private static readonly Regex FileName = new(@"^((?:environments/)?[A-Za-z0-9._-]+\.yaml)(?: \(line (\d+)\))?", RegexOptions.Compiled);
    private static readonly Regex Colour = new("^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$", RegexOptions.Compiled);
    private static readonly Regex Quoted = new("'([^']+)'", RegexOptions.Compiled);
    private static readonly Regex CallsMessage = new("^'([^']+)' calls '([^']+)'", RegexOptions.Compiled);
    private static readonly string[] TopLevel = ["town.yaml", "defaults.yaml", "hub.yaml", "fake.yaml", "third-parties.yaml"];
    private static readonly string[] Topologies = ["hub-and-spoke", "direct"];
    private static readonly string[] Blocks = ["errors", "resources", "throttle", "backlog"];

    /// <param name="adapters">The adapter modules loaded, to check the kinds of source and login against. Without them only the shape of the files is checked.</param>
    public static ValidationResult Validate(string folder, AdapterCatalog? adapters = null)
    {
        folder = Path.GetFullPath(folder);
        var findings = new List<Finding>();
        var ctx = new Context(folder, findings);

        Registry registry;
        try
        {
            registry = RegistryLoader.LoadResilient(folder, adapters); // each adapter checks the settings of its own kinds' sources
        }
        catch (RegistryException e)
        {
            // town, defaults, hub or layout are unreadable: nothing further can be checked
            foreach (var problem in Split(e.Message)) ctx.FromLoader(problem, null);
            return ctx.Result();
        }

        foreach (var problem in registry.Problems) ctx.FromLoader(problem, registry);
        ctx.Registry = registry;

        CheckTown(ctx);
        CheckColoursAndNames(ctx, registry);
        CheckLayout(ctx, registry);
        CheckThresholds(ctx, registry);
        CheckCalls(ctx, registry);
        CheckHub(ctx, registry);
        CheckExternalCallers(ctx, registry);
        CheckWorkersHaveDatabases(ctx, registry);
        CheckDatabaseEngines(ctx, registry);
        CheckUncalled(ctx, registry);
        CheckStandalone(ctx, registry);
        CheckServices(ctx, registry);
        CheckEnvironments(ctx, registry, adapters);
        CheckFake(ctx, registry);
        CheckFakeAssets(ctx, registry);
        return ApplyExpectedWarnings(ctx, ctx.Result());
    }

    /// <summary>
    /// A registry that shows a rule on purpose (a test town with a standalone island) lists the warning under expectedWarnings in town.yaml.
    /// The warning then leaves the report, and an expected warning that no longer appears is an error, so the rule is still proven.
    /// </summary>
    private static ValidationResult ApplyExpectedWarnings(Context c, ValidationResult result)
    {
        var town = c.Raw("town.yaml");
        var listed = RawYaml.Get(town.Root, "expectedWarnings");
        if (listed is null) return result;
        var findings = result.Findings.ToList();
        var expected = new List<Finding>();
        var problems = new List<Finding>();
        foreach (var entry in RawYaml.Items(listed))
        {
            var rule = RawYaml.Str(RawYaml.Get(entry as YamlMappingNode, "rule"));
            var file = RawYaml.Str(RawYaml.Get(entry as YamlMappingNode, "file"));
            var line = RawYaml.Line(entry);
            if (string.IsNullOrWhiteSpace(rule))
            {
                problems.Add(new Finding(Severity.Error, "town.yaml", line, "expected-warning", "An expectedWarnings entry needs a 'rule', for example { rule: standalone, file: groups/sta.yaml }."));
                continue;
            }
            var expectedFile = file is null ? null : c.InGroupFolder(file.Replace('\\', '/'));
            var hits = findings.Where(f => f.Severity == Severity.Warning && f.Rule == rule && (expectedFile is null || f.File == expectedFile)).ToList();
            if (hits.Count == 0)
            {
                problems.Add(new Finding(Severity.Error, "town.yaml", line, "expected-warning", $"Expected a '{rule}' warning{(file is null ? "" : $" in {file}")}, but there is none. If the rule no longer applies here, remove this entry; if it should, this registry has stopped showing it."));
                continue;
            }
            foreach (var hit in hits) { findings.Remove(hit); expected.Add(hit); }
        }
        findings.AddRange(problems);
        return new ValidationResult(result.Folder, findings.OrderBy(f => f.File, StringComparer.Ordinal).ThenBy(f => f.Line).ToList(), expected);
    }

    // ── town, names, colours ────────────────────────────────────────────────

    private static IEnumerable<string> Split(string message)
    {
        var lines = message.Split('\n');
        if (lines.Length > 1 && lines[0].StartsWith("The registry has"))
            return lines.Skip(1).Select(l => l.TrimStart(' ', '-').Trim()).Where(l => l.Length > 0);
        return [message];
    }

    // ── shared state ────────────────────────────────────────────────────────

    private sealed class Context(string folder, List<Finding> findings)
    {
        private readonly Dictionary<string, RawYaml> _raw = new();
        private HashSet<string>? _aliases;

        public string Folder { get; } = folder;
        public Registry? Registry { get; set; }

        public ValidationResult Result()
        {
            // the same problem can be found twice (by the loader and by a check); keep one
            var distinct = findings.DistinctBy(f => (f.File, f.Line, f.Message)).OrderBy(f => f.File, StringComparer.Ordinal).ThenBy(f => f.Line).ToList();
            return new ValidationResult(Folder, distinct);
        }

        public void Error(string file, int line, string rule, string message) => findings.Add(new Finding(Severity.Error, Rel(file), Math.Max(1, line), rule, message));
        public void Warn(string file, int line, string rule, string message) => findings.Add(new Finding(Severity.Warning, Rel(file), Math.Max(1, line), rule, message));

        private string Rel(string file) => file.Replace('\\', '/');

        /// <summary>Raw tree of a file given relative to the registry folder.</summary>
        public RawYaml Raw(string file)
        {
            if (!_raw.TryGetValue(file, out var r)) _raw[file] = r = RawYaml.Load(Path.Combine(Folder, file));
            return r;
        }

        public IEnumerable<string> RootFiles(params string[] names) => names.Where(n => File.Exists(Path.Combine(Folder, n)));

        /// <summary>The folder of the group files: groups/, or pillars/, its older name. A town with both does not load, so nothing else is checked.</summary>
        private string GroupFolder => Directory.Exists(Path.Combine(Folder, GroupWords.OlderFolder)) && !Directory.Exists(Path.Combine(Folder, GroupWords.Folder)) ? GroupWords.OlderFolder : GroupWords.Folder;

        public IEnumerable<string> PillarFiles()
        {
            var dir = Path.Combine(Folder, GroupFolder);
            return Directory.Exists(dir)
                ? Directory.GetFiles(dir, "*.yaml").OrderBy(f => f, StringComparer.Ordinal).Select(f => GroupFolder + "/" + Path.GetFileName(f))
                : [];
        }

        public string PillarFile(string pillarId) => GroupFolder + "/" + pillarId + ".yaml";

        /// <summary>A file named in groups/ or pillars/ (its older name), as it is found in this town's group folder; any other file as it is.</summary>
        public string InGroupFolder(string file) =>
            file.StartsWith(GroupWords.Folder + "/", StringComparison.Ordinal) || file.StartsWith(GroupWords.OlderFolder + "/", StringComparison.Ordinal) ? GroupFolder + file[file.IndexOf('/')..] : file;

        public HashSet<string> Aliases()
        {
            if (_aliases is not null) return _aliases;
            _aliases = [];
            foreach (var file in RootFiles("hub.yaml").Concat(PillarFiles()))
                foreach (var key in new[] { "systems", "resources" })
                    foreach (var system in Raw(file).Entries(key))
                        foreach (var a in RawYaml.Items(RawYaml.Get(system, "aliases")))
                            if (RawYaml.Str(a) is { } alias) _aliases.Add(alias);
            return _aliases;
        }

        /// <summary>The file and line of a system, or of one entry in its calls.</summary>
        public (string File, int Line) Locate(string systemId, string? callee = null)
        {
            var dot = systemId.IndexOf('.');
            var prefix = dot > 0 ? systemId[..dot] : systemId;
            var file = prefix == "hub" ? "hub.yaml" : PillarFile(prefix);
            var raw = Raw(file);
            var line = (callee is not null ? raw.FindCall(systemId, callee) : null) ?? raw.FindSystem(systemId) ?? 1;
            return (file, line);
        }

        /// <summary>Turns one of the loader's messages into a finding by working out which file and line it is about.</summary>
        public void FromLoader(string message, Registry? registry)
        {
            string file;
            int? line = null;
            var calls = CallsMessage.Match(message);
            if (FileName.Match(message) is { Success: true } m)
            {
                file = m.Groups[1].Value;
                file = TopLevel.Contains(file) || file.StartsWith("environments/") ? file : PillarFile(Path.GetFileNameWithoutExtension(file));
                if (m.Groups[2].Success) line = int.Parse(m.Groups[2].Value);
                else if (registry?.ProblemLines.TryGetValue(message, out var known) == true) line = known; // an adapter placed it
                if (message.Contains("external caller") && Quoted.Matches(message) is { Count: > 1 } q)
                    line = Raw(file).FindScalar(q[1].Groups[1].Value);
            }
            else if (calls.Success)
            {
                var at = Locate(calls.Groups[1].Value, calls.Groups[2].Value);
                (file, line) = (at.File, at.Line);
            }
            else if (Quoted.Match(message) is { Success: true } first)
            {
                var at = Locate(first.Groups[1].Value);
                (file, line) = (at.File, at.Line);
            }
            else
            {
                file = "town.yaml";
            }

            if (line is null)
            {
                var raw = Raw(file);
                foreach (Match t in Quoted.Matches(message))
                    if ((line = raw.FindScalar(t.Groups[1].Value)) is not null) break;
            }
            Error(file, line ?? 1, "registry", message);
        }
    }
}
