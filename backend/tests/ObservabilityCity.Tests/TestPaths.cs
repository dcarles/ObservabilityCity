namespace ObservabilityCity.Tests;

internal static class TestPaths
{
    public static string RepoRoot { get; } = FindRoot();

    public static string Registry => Path.Combine(RepoRoot, "config", "galactic-credit");
    public static string MiniTown => Path.Combine(RepoRoot, "shared-test-data", "registries", "mini-town");
    public static string Stress23 => Path.Combine(RepoRoot, "shared-test-data", "registries", "stress-23");
    public static string Stress35 => Path.Combine(RepoRoot, "shared-test-data", "registries", "stress-35");
    public static string Fixtures => Path.Combine(RepoRoot, "shared-test-data", "snapshots");

    private static string FindRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "backend", "ObservabilityCity.slnx"))) return dir.FullName;
        throw new DirectoryNotFoundException("Repo root not found");
    }
}
