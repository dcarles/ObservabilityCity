namespace ObservabilityCity.Validate;

public enum Severity
{
    Warning,
    Error,
}

/// <summary>One thing wrong (or suspicious) in a registry file. Line is 1-based.</summary>
public sealed record Finding(Severity Severity, string File, int Line, string Rule, string Message);

/// <summary>Everything found in one registry folder.</summary>
public sealed record ValidationResult(string Folder, IReadOnlyList<Finding> Findings, IReadOnlyList<Finding>? ExpectedFindings = null)
{
    /// <summary>Warnings the registry's town.yaml says to expect (expectedWarnings). They are not in Findings and do not count as warnings.</summary>
    public int Expected => ExpectedFindings?.Count ?? 0;
    public int Errors => Findings.Count(f => f.Severity == Severity.Error);
    public int Warnings => Findings.Count(f => f.Severity == Severity.Warning);
}
