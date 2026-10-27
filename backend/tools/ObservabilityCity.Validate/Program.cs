using ObservabilityCity.Core.Sources;
using ObservabilityCity.Validate;

// Validates registry folders. Exit code 1 when any has an error; warnings never fail the run.
//   dotnet run --project tools/ObservabilityCity.Validate -- --all                 every registry folder in the repo (any folder with a town.yaml)
//   dotnet run --project tools/ObservabilityCity.Validate -- config/galactic-credit
//   dotnet run --project backend/tools/ObservabilityCity.Validate -- --sources config/my-company
// --sources probes each source an environment configures (connected / no permission / query returned nothing / unreachable / not configured)
// with your Azure login, instead of checking the files. Exit code 1 on no permission, unreachable or unknown kind; --strict also fails on empty.
// Options: --github (workflow annotations), --markdown <file> (the body of a pull request comment).

var folders = new List<string>();
var all = false;
var github = false;
var sources = false;
var strict = false;
string? markdownPath = null;
for (var i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--all": all = true; break;
        case "--sources": sources = true; break;
        case "--strict": strict = true; break;
        case "--github": github = true; break;
        case "--markdown": markdownPath = args[++i]; break;
        default: folders.Add(args[i]); break;
    }
}

// The adapters sit in adapters/ beside the tool (the build puts them there), as they do beside the host.
var adapterFolder = Path.Combine(AppContext.BaseDirectory, "adapters");
var plugins = AdapterLoader.LoadFrom(adapterFolder);
foreach (var problem in plugins.Problems) Console.Error.WriteLine(problem);
var adapters = new AdapterCatalog(plugins.Modules);

var root = Report.FindRepoRoot(Directory.GetCurrentDirectory());
if (all) folders.AddRange(Report.FindRegistries(root));
if (folders.Count == 0)
{
    Console.Error.WriteLine("Nothing to validate. Pass registry folders, or --all.");
    return 2;
}

if (sources)
{
    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
    var tokens = new AzureTokenProvider();
    var probes = SourceProbes.Default(http, tokens);
    var checks = new List<SourceCheckResult>();
    foreach (var folder in folders)
    {
        var check = await SourceCheck.RunAsync(folder, probes, TimeSpan.FromSeconds(30), CancellationToken.None, adapters.SourceKindNames, new ResourceGraphWorkspaceLookup(http, tokens));
        SourceCheck.WriteText(check, root, Console.Out);
        checks.Add(check);
    }
    var code = SourceCheck.ExitCode(checks, strict);
    Console.WriteLine($"\n{checks.Count} registr{(checks.Count == 1 ? "y" : "ies")} probed: {checks.Sum(c => c.Failures)} failure(s), {checks.Sum(c => c.EmptyCount)} empty.");
    return code;
}

var results = folders.Select(f => RegistryValidator.Validate(f, adapters)).ToList();
foreach (var r in results) Report.WriteText(r, root, Console.Out);
if (github) foreach (var r in results) Report.WriteAnnotations(r, root, Console.Out);
if (markdownPath is not null) File.WriteAllText(markdownPath, Report.Markdown(results, root));

var errors = results.Sum(r => r.Errors);
var warnings = results.Sum(r => r.Warnings);
Console.WriteLine($"\n{results.Count} registr{(results.Count == 1 ? "y" : "ies")} checked: {errors} error(s), {warnings} warning(s).");
return errors > 0 ? 1 : 0;
