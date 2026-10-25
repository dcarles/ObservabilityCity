namespace ObservabilityCity.Validate;

public enum Severity
{
    Warning,
    Error,
}

/// <summary>One thing wrong (or suspicious) in a registry file. Line is 1-based.</summary>
public sealed record Finding(Severity Severity, string File, int Line, string Rule, string Message);

/// <summary>Everything found in one registry folder.</summary>
public sealed record ValidationResult(string Folder, IReadOnlyList<Finding> Findings)
{
    public int Errors => Findings.Count(f => f.Severity == Severity.Error);
    public int Warnings => Findings.Count(f => f.Severity == Severity.Warning);
}
