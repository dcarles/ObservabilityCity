namespace ObservabilityCity.Core.Registry;

/// <summary>
/// The kinds of database a town can tell apart. The list is fixed here, not in a company's files, because the renderer may one day draw each kind differently.
/// A company's databaseEngines (town.yaml) each belong to exactly one of these.
/// </summary>
public static class DatabaseTypes
{
    public const string Relational = "relational";
    public const string Document = "document";
    public const string KeyValue = "key-value";
    public const string WideColumn = "wide-column";
    public const string Graph = "graph";
    public const string TimeSeries = "time-series";
    public const string Analytical = "analytical";
    public const string Vector = "vector";

    /// <summary>Every type, with the name shown for it.</summary>
    public static readonly IReadOnlyDictionary<string, string> Names = new Dictionary<string, string>
    {
        [Relational] = "Relational",
        [Document] = "Document",
        [KeyValue] = "Key-value",
        [WideColumn] = "Wide-column",
        [Graph] = "Graph",
        [TimeSeries] = "Time-series",
        [Analytical] = "Analytical",
        [Vector] = "Vector",
    };

    public static IEnumerable<string> All => Names.Keys;
}
