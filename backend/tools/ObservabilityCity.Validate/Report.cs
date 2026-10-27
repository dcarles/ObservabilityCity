using System.Text;

namespace ObservabilityCity.Validate;

/// <summary>Turns findings into console text, workflow annotations or a pull request comment.</summary>
public static class Report
{
    /// <summary>Hidden marker on the first line of the comment, so a workflow can find and update it instead of posting another.</summary>
    public const string CommentMarker = "<!-- registry-validation -->";

    public static string FindRepoRoot(string start)
    {
        for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "backend", "ObservabilityCity.slnx")) || Directory.Exists(Path.Combine(dir.FullName, ".git"))) return dir.FullName;
        return start;
    }

    /// <summary>Every folder under the root that holds a town.yaml.</summary>
    public static IEnumerable<string> FindRegistries(string root) =>
        Directory.EnumerateFiles(root, "town.yaml", SearchOption.AllDirectories)
            .Where(f => !f.Split(Path.DirectorySeparatorChar).Any(p => p is "bin" or "obj" or "node_modules" or ".git"))
            .Select(f => Path.GetDirectoryName(f)!)
            .OrderBy(f => f, StringComparer.Ordinal);

    public static string RelativePath(string root, string path) => Path.GetRelativePath(root, path).Replace('\\', '/');

    private static string Expected(ValidationResult r) => r.Expected > 0 ? $", {r.Expected} expected" : "";

    private static string FilePath(ValidationResult r, Finding f, string root) => RelativePath(root, Path.Combine(r.Folder, f.File));

    public static void WriteText(ValidationResult r, string root, TextWriter w)
    {
        w.WriteLine($"{RelativePath(root, r.Folder)}: {r.Errors} error(s), {r.Warnings} warning(s){Expected(r)}");
        foreach (var f in r.Findings.OrderByDescending(f => f.Severity))
            w.WriteLine($"  {(f.Severity == Severity.Error ? "error  " : "warning")} {FilePath(r, f, root)}:{f.Line}  [{f.Rule}] {f.Message}");
    }

    /// <summary>GitHub workflow commands: they show the finding on the file in the pull request.</summary>
    public static void WriteAnnotations(ValidationResult r, string root, TextWriter w)
    {
        foreach (var f in r.Findings)
        {
            var level = f.Severity == Severity.Error ? "error" : "warning";
            var message = f.Message.Replace("%", "%25").Replace("\r", "%0D").Replace("\n", "%0A");
            w.WriteLine($"::{level} file={FilePath(r, f, root)},line={f.Line},title=Registry {f.Rule}::{message}");
        }
    }

    public static string Markdown(IReadOnlyList<ValidationResult> results, string root)
    {
        var repo = Environment.GetEnvironmentVariable("GITHUB_REPOSITORY");
        var sha = Environment.GetEnvironmentVariable("GITHUB_SHA");
        string Link(string path, int line) =>
            repo is not null && sha is not null ? $"[`{path}:{line}`](https://github.com/{repo}/blob/{sha}/{path}#L{line})" : $"`{path}:{line}`";

        var errors = results.Sum(r => r.Errors);
        var warnings = results.Sum(r => r.Warnings);
        var expected = results.Sum(r => r.Expected);
        var sb = new StringBuilder();
        sb.AppendLine(CommentMarker);
        sb.AppendLine(errors > 0 ? "### Registry check: problems to fix" : warnings > 0 ? "### Registry check: passed with warnings" : "### Registry check: all clear");
        sb.AppendLine();
        sb.AppendLine($"{results.Count} registr{(results.Count == 1 ? "y" : "ies")} checked: **{errors} error(s)**, {warnings} warning(s){(expected > 0 ? $", {expected} expected (listed under expectedWarnings in a town.yaml, so not shown)" : "")}. Errors block the merge; warnings do not.");
        foreach (var r in results.Where(r => r.Findings.Count > 0))
        {
            sb.AppendLine();
            sb.AppendLine($"#### `{RelativePath(root, r.Folder)}`");
            sb.AppendLine();
            sb.AppendLine("| | Where | Rule | Problem |");
            sb.AppendLine("|---|---|---|---|");
            foreach (var f in r.Findings.OrderByDescending(f => f.Severity))
                sb.AppendLine($"| {(f.Severity == Severity.Error ? "error" : "warning")} | {Link(FilePath(r, f, root), f.Line)} | {f.Rule} | {f.Message.Replace("|", "\\|").Replace("\n", " ")} |");
        }
        return sb.ToString();
    }
}
