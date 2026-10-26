using YamlDotNet.RepresentationModel;

namespace ObservabilityCity.Validate;

/// <summary>One signal of one environment, and what the probe said.</summary>
public sealed record SourceFinding(string Environment, string Signal, string Kind, ProbeResult Result);

public sealed record SourceCheckResult(string Folder, IReadOnlyList<SourceFinding> Findings)
{
    /// <summary>Probes that mean the source cannot be used as configured.</summary>
    public int Failures => Findings.Count(f => f.Result.Status is ProbeStatus.NoPermission or ProbeStatus.Unreachable or ProbeStatus.UnknownKind);
    public int EmptyCount => Findings.Count(f => f.Result.Status == ProbeStatus.Empty);
}

/// <summary>
/// Reads each environment file of a registry folder and probes every source it configures, one cheap read each.
/// It reads the YAML directly, so it works for source kinds the running town does not use yet.
/// </summary>
public static class SourceCheck
{
    /// <summary>The sources an environment is reported on even when it does not define them: what the signals use unless told otherwise.</summary>
    public static readonly string[] Signals = ["metrics", "incidents", "messaging"];

    public static async Task<SourceCheckResult> RunAsync(string folder, IReadOnlyList<ISourceProbe> probes, TimeSpan timeout, CancellationToken ct)
    {
        var findings = new List<SourceFinding>();
        var dir = Path.Combine(folder, "environments");
        var files = Directory.Exists(dir) ? Directory.GetFiles(dir, "*.yaml").OrderBy(f => f, StringComparer.Ordinal).ToList() : [];
        foreach (var file in files)
        {
            var env = Path.GetFileNameWithoutExtension(file);
            var configured = ReadSources(file);
            foreach (var signal in configured.Keys.Concat(Signals.Where(s => !configured.ContainsKey(s))))
            {
                if (!configured.TryGetValue(signal, out var source))
                {
                    findings.Add(new SourceFinding(env, signal, "", new ProbeResult(ProbeStatus.NotConfigured, "no source: the town leaves this signal out")));
                    continue;
                }
                var probe = probes.FirstOrDefault(p => p.Kind == source.Kind);
                if (probe is null && Core.Sources.SourceKinds.All.Contains(source.Kind))
                {
                    findings.Add(new SourceFinding(env, signal, source.Kind, new ProbeResult(ProbeStatus.NoProbeYet, "the registry accepts this kind; its probe comes with its adapter")));
                    continue;
                }
                if (probe is null)
                {
                    var known = string.Join(", ", probes.Select(p => p.Kind));
                    findings.Add(new SourceFinding(env, signal, source.Kind, new ProbeResult(ProbeStatus.UnknownKind, $"no probe for kind '{source.Kind}'. Known: {known}")));
                    continue;
                }
                using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
                limit.CancelAfter(timeout);
                ProbeResult result;
                try { result = await probe.ProbeAsync(source.Connection ?? "", limit.Token); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested) { result = new ProbeResult(ProbeStatus.Unreachable, "timed out"); }
                findings.Add(new SourceFinding(env, signal, source.Kind, result));
            }
        }
        return new SourceCheckResult(folder, findings);
    }

    private static Dictionary<string, (string Kind, string? Connection)> ReadSources(string file)
    {
        var found = new Dictionary<string, (string, string?)>();
        if (RawYaml.Get(RawYaml.Load(file).Root, "sources") is not YamlMappingNode sources) return found;
        foreach (var (key, value) in sources.Children)
        {
            if (value is not YamlMappingNode def) continue;
            var kind = (RawYaml.Get(def, "kind") as YamlScalarNode)?.Value ?? "";
            var connection = (RawYaml.Get(def, "connection") as YamlScalarNode)?.Value;
            found[((YamlScalarNode)key).Value ?? ""] = (kind.ToLowerInvariant(), connection);
        }
        return found;
    }

    /// <summary>1 when any source cannot be used as configured (and, with strict, when a probe came back empty), else 0.</summary>
    public static int ExitCode(IEnumerable<SourceCheckResult> results, bool strict) =>
        results.Sum(r => r.Failures + (strict ? r.EmptyCount : 0)) > 0 ? 1 : 0;

    public static void WriteText(SourceCheckResult r, string root, TextWriter w)
    {
        w.WriteLine($"{Report.RelativePath(root, r.Folder)}: {r.Failures} failure(s), {r.EmptyCount} empty");
        foreach (var f in r.Findings)
        {
            var label = f.Result.Status switch
            {
                ProbeStatus.Connected => "connected",
                ProbeStatus.NoPermission => "no permission",
                ProbeStatus.Empty => "query returned nothing",
                ProbeStatus.Unreachable => "unreachable",
                ProbeStatus.NotConfigured => "not configured",
                ProbeStatus.NoProbeYet => "no probe yet",
                _ => "unknown kind",
            };
            var kind = f.Kind.Length > 0 ? $" ({f.Kind})" : "";
            var detail = f.Result.Detail.Length > 0 ? $" - {f.Result.Detail}" : "";
            w.WriteLine($"  {f.Environment,-12} {f.Signal,-12}{kind,-16} {label}{detail}");
        }
    }
}
