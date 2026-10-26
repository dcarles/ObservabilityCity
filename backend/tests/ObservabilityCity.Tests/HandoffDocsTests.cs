using System.Text.RegularExpressions;

namespace ObservabilityCity.Tests;

/// <summary>The handoff kit is only useful if what it points at exists, and if it keeps the rules a fork depends on.</summary>
public partial class HandoffDocsTests
{
    private static readonly string[] Docs = ["AGENTS.md", ".github/copilot-instructions.md", "docs/connect-your-company.md", "extensions/README.md"];

    [GeneratedRegex(@"\]\(([^)#\s]+)(#[^)\s]*)?\)")]
    private static partial Regex LinkPattern();

    [Theory]
    [InlineData("AGENTS.md")]
    [InlineData(".github/copilot-instructions.md")]
    [InlineData("docs/connect-your-company.md")]
    [InlineData("extensions/README.md")]
    public void Relative_links_point_at_files_that_exist(string doc)
    {
        var path = Path.Combine(TestPaths.RepoRoot, doc);
        var text = File.ReadAllText(path);

        foreach (Match m in LinkPattern().Matches(text))
        {
            var target = m.Groups[1].Value;
            if (target.Contains("://")) continue;
            var full = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(path)!, target));
            Assert.True(File.Exists(full) || Directory.Exists(full), $"{doc} links to {target}, which does not exist");
        }
    }

    [Fact]
    public void The_instructions_state_the_rules_a_fork_depends_on()
    {
        foreach (var doc in new[] { "AGENTS.md", ".github/copilot-instructions.md" })
        {
            var text = File.ReadAllText(Path.Combine(TestPaths.RepoRoot, doc));
            Assert.Contains("Never edit core", text, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("both sides", text, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("force-push", text, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("secrets", text, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void The_runbook_names_the_check_and_every_probe_kind()
    {
        var text = File.ReadAllText(Path.Combine(TestPaths.RepoRoot, "docs/connect-your-company.md"));

        Assert.Contains("--sources", text);
        foreach (var kind in new[] { "prometheus", "loganalytics", "servicebus", "grafana-irm" })
            Assert.Contains(kind, text);
    }

    [Fact]
    public void The_docs_exist_and_hold_no_secrets_or_real_hosts()
    {
        foreach (var doc in Docs)
        {
            var text = File.ReadAllText(Path.Combine(TestPaths.RepoRoot, doc));
            Assert.DoesNotMatch(@"(?i)(AccountKey|SharedAccessKey|password)\s*=", text);
            Assert.DoesNotMatch(@"https?://[^\s)""]*\.(windows\.net|azure\.com)\b(?<!example\.test)", text.Replace("sb-example.servicebus.windows.net", ""));
        }
    }
}
