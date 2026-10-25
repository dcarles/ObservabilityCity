namespace ObservabilityCity.Host;

public static class RegistryPath
{
    /// <summary>
    /// Uses Registry:Path when set. Otherwise looks upward from the app for config/galactic-credit,
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
                var candidate = Path.Combine(dir.FullName, "config", "galactic-credit");
                if (Directory.Exists(candidate)) return candidate;
            }
        }
        throw new DirectoryNotFoundException("Could not find config/galactic-credit. Set Registry:Path.");
    }
}
