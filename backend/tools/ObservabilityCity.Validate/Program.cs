using ObservabilityCity.Validate;

// Validates registry folders. Exit code 1 when any has an error; warnings never fail the run.
//   dotnet run --project tools/ObservabilityCity.Validate -- --all                 every registry folder in the repo (any folder with a town.yaml)
//   dotnet run --project tools/ObservabilityCity.Validate -- config/galactic-credit
// Options: --github (workflow annotations), --markdown <file> (the body of a pull request comment).

var folders = new List<string>();
var all = false;
var github = false;
string? markdownPath = null;
for (var i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--all": all = true; break;
        case "--github": github = true; break;
        case "--markdown": markdownPath = args[++i]; break;
        default: folders.Add(args[i]); break;
    }
}

var root = Report.FindRepoRoot(Directory.GetCurrentDirectory());
if (all) folders.AddRange(Report.FindRegistries(root));
if (folders.Count == 0)
{
    Console.Error.WriteLine("Nothing to validate. Pass registry folders, or --all.");
    return 2;
}

var results = folders.Select(RegistryValidator.Validate).ToList();
foreach (var r in results) Report.WriteText(r, root, Console.Out);
if (github) foreach (var r in results) Report.WriteAnnotations(r, root, Console.Out);
if (markdownPath is not null) File.WriteAllText(markdownPath, Report.Markdown(results, root));

var errors = results.Sum(r => r.Errors);
var warnings = results.Sum(r => r.Warnings);
Console.WriteLine($"\n{results.Count} registr{(results.Count == 1 ? "y" : "ies")} checked: {errors} error(s), {warnings} warning(s).");
return errors > 0 ? 1 : 0;
