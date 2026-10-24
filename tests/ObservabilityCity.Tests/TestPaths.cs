namespace ObservabilityCity.Tests;

internal static class TestPaths
{
    public static string RepoRoot { get; } = FindRoot();

    public static string Registry => Path.Combine(RepoRoot, "samples", "galactic-credit");
    public static string Fixtures => Path.Combine(RepoRoot, "tests", "fixtures", "snapshots");

    private static string FindRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "ObservabilityCity.sln"))) return dir.FullName;
        throw new DirectoryNotFoundException("Repo root not found");
    }
}
