namespace ObservabilityCity.Host;

public static class RegistryPath
{
    private const string SampleTown = "galactic-credit";

    /// <summary>
    /// The folder of the default town. Uses Registry:Path when set. Otherwise looks upward from the app for config/galactic-credit,
    /// so it works from the repo root, from the project folder and from a build output folder.
    /// </summary>
    public static string Resolve(IConfiguration config)
    {
        var configured = config["Registry:Path"];
        if (!string.IsNullOrWhiteSpace(configured))
            return Path.GetFullPath(configured, Directory.GetCurrentDirectory());

        foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
        {
            for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
            {
                var candidate = Path.Combine(dir.FullName, "config", SampleTown);
                if (Directory.Exists(candidate)) return candidate;
            }
        }
        throw new DirectoryNotFoundException("Could not find config/galactic-credit. Set Registry:Path.");
    }

    /// <summary>
    /// Every town folder the server runs, the default one first. Registry:Path alone is one town (a test, or a deployment of a single town). Without it,
    /// every folder beside the sample town that holds a town.yaml is a town, so a company that adds config/acme gets a town switcher with no setting.
    /// Registry:Towns:0, :1, ... add folders by hand. Registry:DefaultTown names the town the page opens on; it is the sample town otherwise.
    /// </summary>
    public static IReadOnlyList<string> ResolveAll(IConfiguration config)
    {
        var first = Resolve(config);
        var folders = new List<string> { first };
        if (string.IsNullOrWhiteSpace(config["Registry:Path"]) && Directory.GetParent(first) is { } config_)
            folders.AddRange(config_.EnumerateDirectories().Where(d => File.Exists(Path.Combine(d.FullName, "town.yaml"))).Select(d => d.FullName).Order(StringComparer.Ordinal));
        folders.AddRange((config.GetSection("Registry:Towns").Get<string[]>() ?? []).Where(p => !string.IsNullOrWhiteSpace(p)).Select(p => Path.GetFullPath(p, Directory.GetCurrentDirectory())));
        return folders.Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }
}
