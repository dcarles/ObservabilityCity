using ObservabilityCity.Core.Registry;

namespace ObservabilityCity.AdapterKit;

/// <summary>
/// A town's registry folder copied somewhere private, so a test can change a file (the environment's sources, a pillar's systems) without touching
/// the original. Dispose it to delete the copy.
/// </summary>
public sealed class TownFiles : IDisposable
{
    public string Path { get; } = Directory.CreateTempSubdirectory("oc-town-").FullName;

    public TownFiles(string source)
    {
        foreach (var dir in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(System.IO.Path.Combine(Path, System.IO.Path.GetRelativePath(source, dir)));
        foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
            File.Copy(file, System.IO.Path.Combine(Path, System.IO.Path.GetRelativePath(source, file)));
    }

    public string FilePath(string relative) => System.IO.Path.Combine(Path, relative);

    public void Write(string relative, string text)
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(FilePath(relative))!);
        File.WriteAllText(FilePath(relative), text);
    }

    /// <summary>The town as one environment sees it, loaded strictly: a mistake in a file throws a <see cref="RegistryException"/> naming it.</summary>
    public Registry Load(string environment) => RegistryLoader.Load(Path).ForEnvironment(environment);

    public void Dispose()
    {
        try { Directory.Delete(Path, true); }
        catch (IOException) { /* a temp folder left behind is not worth failing a test for */ }
    }
}
