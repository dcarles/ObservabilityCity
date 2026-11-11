using System.Text.RegularExpressions;
using ObservabilityCity.Core.Sources;

namespace Template.Adapters;

/// <summary>
/// The keys an example-http source has beyond the core's (kind, connection, credential, pollSeconds, timeoutSeconds, lateAfterSeconds, query, window).
/// One property for each key, camelCase in the file. A key that is not here is an error, reported with its line.
/// </summary>
public sealed class ExampleHttpFile
{
    /// <summary>The property of the answer that holds the systems. Default systems.</summary>
    public string? Field { get; set; }
}

/// <summary>What the source runs with, made from the file's keys.</summary>
public sealed record ExampleHttpOptions(string Field)
{
    public const string DefaultField = "systems";
}

/// <summary>
/// Reads and checks the settings of an example-http source. The loader, the validator and the server all run it, so a mistake shows in `validate` with
/// the file and the line. Rename it with the rest of the template, and replace the keys with your own.
/// </summary>
public sealed partial class ExampleHttpSettings : SourceSettingsReader<ExampleHttpFile, ExampleHttpOptions>
{
    public static ExampleHttpSettings Reader { get; } = new();

    [GeneratedRegex("^[A-Za-z][A-Za-z0-9]*$")]
    private static partial Regex Name();

    // what an editor completes for this kind; `--write-schema` merges it into each town's environment schema
    public override string Schema => """
        { "properties": { "field": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9]*$", "description": "The property of the answer that holds the systems. Default systems." } } }
        """;

    protected override void Check(ExampleHttpFile file, SourceSettingsContext context, SettingsReport report)
    {
        // a message starts with the source; the file's name and the line of the key are added for you
        if (file.Field is { } field && !Name().IsMatch(field.Trim()))
            report.Add($"source '{context.SourceName}' has field '{field}'. Write the name of a property of the answer, letters and digits", "field");
    }

    // called even when Check found mistakes, so it must not throw
    protected override ExampleHttpOptions Convert(ExampleHttpFile file) =>
        new(string.IsNullOrWhiteSpace(file.Field) ? ExampleHttpOptions.DefaultField : file.Field.Trim());
}
