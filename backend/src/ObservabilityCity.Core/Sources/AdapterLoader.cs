using System.Reflection;
using System.Runtime.Loader;

namespace ObservabilityCity.Core.Sources;

/// <summary>
/// Finds adapter modules on disk. Each folder under the adapters folder holds one module and what it needs (<c>adapters/azure/*.dll</c>). A module
/// loads into a context of its own, so its dependencies (an SDK of some cloud) never clash with the host's or another module's, but it shares the
/// core's types, which is what lets the host talk to it. A folder that cannot be loaded is reported and skipped.
/// </summary>
public static class AdapterLoader
{
    public sealed record Loaded(IReadOnlyList<IAdapterModule> Modules, IReadOnlyList<string> Problems);

    public static Loaded LoadFrom(string folder)
    {
        var modules = new List<IAdapterModule>();
        var problems = new List<string>();
        if (!Directory.Exists(folder)) return new Loaded(modules, problems);
        foreach (var dir in Directory.GetDirectories(folder).OrderBy(d => d, StringComparer.Ordinal))
        {
            var found = 0;
            foreach (var dll in Directory.GetFiles(dir, "*.dll").Where(f => Path.GetFileName(f).Contains("Adapters", StringComparison.OrdinalIgnoreCase)))
            {
                try
                {
                    var context = new ModuleContext(dll);
                    var assembly = context.LoadFromAssemblyPath(dll);
                    foreach (var type in assembly.GetTypes().Where(t => typeof(IAdapterModule).IsAssignableFrom(t) && t is { IsAbstract: false, IsInterface: false }))
                    {
                        modules.Add((IAdapterModule)Activator.CreateInstance(type)!);
                        found++;
                    }
                }
                catch (Exception e) when (e is IOException or BadImageFormatException or ReflectionTypeLoadException or MissingMethodException or TargetInvocationException or FileLoadException)
                {
                    problems.Add($"Adapter folder {Path.GetFileName(dir)}: {Path.GetFileName(dll)} could not be loaded: {(e as ReflectionTypeLoadException)?.LoaderExceptions.FirstOrDefault()?.Message ?? e.Message}");
                }
            }
            if (found == 0 && problems.All(p => !p.StartsWith($"Adapter folder {Path.GetFileName(dir)}:")))
                problems.Add($"Adapter folder {Path.GetFileName(dir)} has no adapter module in it (a class that implements IAdapterModule).");
        }
        return new Loaded(modules, problems);
    }

    /// <summary>A load context for one module: its own files first, the host's copy of the core and contracts so the types match.</summary>
    private sealed class ModuleContext(string path) : AssemblyLoadContext(Path.GetFileNameWithoutExtension(path), isCollectible: false)
    {
        private readonly AssemblyDependencyResolver _resolver = new(path);

        protected override Assembly? Load(AssemblyName name)
        {
            // shared with the host: the contract the module is written against
            if (name.Name is "ObservabilityCity.Core" or "ObservabilityCity.Contracts") return null;
            return _resolver.ResolveAssemblyToPath(name) is { } file ? LoadFromAssemblyPath(file) : null;
        }

        protected override IntPtr LoadUnmanagedDll(string unmanagedDllName) =>
            _resolver.ResolveUnmanagedDllToPath(unmanagedDllName) is { } file ? LoadUnmanagedDllFromPath(file) : IntPtr.Zero;
    }
}
