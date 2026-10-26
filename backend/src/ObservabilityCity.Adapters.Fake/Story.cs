using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace ObservabilityCity.Adapters.Fake;

/// <summary>One effect a story step starts, aimed like any other: a node id, a group id, "*", or "store#tenant" for Saturate.</summary>
public sealed class StoryEffectSpec
{
    public string Target { get; set; } = "";
    public string Kind { get; set; } = "";
    public double Intensity { get; set; } = 1;
}

/// <summary>An effect that grows (or shrinks) from one intensity to another over some seconds, starting when its step begins.</summary>
public sealed class StoryRampSpec
{
    public string Target { get; set; } = "";
    public string Kind { get; set; } = "";
    public double From { get; set; }
    public double To { get; set; } = 1;
    public double Over { get; set; } = 10;
}

/// <summary>Takes effects away: all of them, or those matching a target and/or kind.</summary>
public sealed class StoryClearSpec
{
    public bool All { get; set; }
    public string? Target { get; set; }
    public string? Kind { get; set; }
}

public sealed class StoryStep
{
    /// <summary>Seconds from the start of the story.</summary>
    public double At { get; set; }
    /// <summary>What the story bar says while this step is the latest one.</summary>
    public string? Caption { get; set; }
    /// <summary>A system or island the camera glides to when the step begins.</summary>
    public string? Camera { get; set; }
    public List<StoryEffectSpec> Apply { get; set; } = [];
    public List<StoryRampSpec> Ramp { get; set; } = [];
    public List<StoryClearSpec> Clear { get; set; } = [];
}

/// <summary>A timeline of the same effects the Break things panel uses. The state at any second is worked out from the steps alone, so scrubbing is exact.</summary>
public sealed class Story
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    /// <summary>Seconds the story runs. When left out, it ends 5 seconds after its last step.</summary>
    public double? Length { get; set; }
    public List<StoryStep> Steps { get; set; } = [];

    public double Duration => Length ?? (Steps.Count == 0 ? 0 : Steps.Max(s => s.At + s.Ramp.Select(r => r.Over).DefaultIfEmpty(0).Max()) + 5);

    /// <summary>What is wrong with the story, one line each; empty when it can play.</summary>
    public IReadOnlyList<string> Problems()
    {
        var problems = new List<string>();
        if (string.IsNullOrWhiteSpace(Id)) problems.Add("it has no id");
        if (Steps.Count == 0) problems.Add("it has no steps");
        for (var i = 0; i < Steps.Count; i++)
        {
            var s = Steps[i];
            var at = $"step {i + 1}";
            if (s.At < 0) problems.Add($"{at}: 'at' is before the start");
            if (i > 0 && s.At < Steps[i - 1].At) problems.Add($"{at}: steps must be in time order");
            foreach (var a in s.Apply) Check(a.Kind, a.Target, at);
            foreach (var r in s.Ramp)
            {
                Check(r.Kind, r.Target, at);
                if (r.Over <= 0) problems.Add($"{at}: a ramp needs 'over' above zero");
            }
            foreach (var c in s.Clear)
                if (c.Kind is not null && !Enum.TryParse<FakeEffectKind>(c.Kind, true, out _)) problems.Add($"{at}: '{c.Kind}' is not an effect kind");
            if (s.Apply.Count + s.Ramp.Count + s.Clear.Count == 0 && string.IsNullOrWhiteSpace(s.Caption) && string.IsNullOrWhiteSpace(s.Camera))
                problems.Add($"{at}: it does nothing");
        }
        if (Length is { } len && Steps.Count > 0 && Steps[^1].At > len) problems.Add("the last step is after the story's length");
        return problems;

        void Check(string kind, string target, string at)
        {
            if (!Enum.TryParse<FakeEffectKind>(kind, true, out _)) problems.Add($"{at}: '{kind}' is not an effect kind");
            if (string.IsNullOrWhiteSpace(target)) problems.Add($"{at}: an effect needs a target");
        }
    }

    /// <summary>The effects in force and the latest step, <paramref name="seconds"/> into the story.</summary>
    public StoryMoment At(double seconds)
    {
        var active = new List<StoryEffect>();
        var stepIndex = -1;
        for (var i = 0; i < Steps.Count && Steps[i].At <= seconds + 1e-9; i++)
        {
            var step = Steps[i];
            stepIndex = i;
            foreach (var c in step.Clear)
                active.RemoveAll(e => c.All || ((c.Target is null || c.Target == e.Target) && (c.Kind is null || string.Equals(c.Kind, e.Kind.ToString(), StringComparison.OrdinalIgnoreCase)) && (c.Target is not null || c.Kind is not null)));
            for (var j = 0; j < step.Apply.Count; j++)
                active.Add(new StoryEffect($"{Id}/{i}a{j}", step.Apply[j].Target, Parse(step.Apply[j].Kind), Math.Clamp(step.Apply[j].Intensity, 0, 1)));
            for (var j = 0; j < step.Ramp.Count; j++)
            {
                var r = step.Ramp[j];
                var done = Math.Clamp((seconds - step.At) / r.Over, 0, 1);
                active.Add(new StoryEffect($"{Id}/{i}r{j}", r.Target, Parse(r.Kind), Math.Clamp(r.From + (r.To - r.From) * done, 0, 1)));
            }
        }
        var caption = Steps.Take(stepIndex + 1).LastOrDefault(s => !string.IsNullOrWhiteSpace(s.Caption))?.Caption;
        var camera = stepIndex >= 0 ? Steps[stepIndex].Camera : null;
        return new StoryMoment(stepIndex, caption, camera, active);
    }

    private static FakeEffectKind Parse(string kind) => Enum.Parse<FakeEffectKind>(kind, true);
}

/// <summary>An effect a story has in force at some moment. Its intensity is already worked out for that moment.</summary>
public sealed record StoryEffect(string Id, string Target, FakeEffectKind Kind, double Intensity);

/// <summary>The state of a story at one second: which step is the latest (-1 before the first), its caption and camera target, and the effects in force.</summary>
public sealed record StoryMoment(int Step, string? Caption, string? Camera, IReadOnlyList<StoryEffect> Effects);

/// <summary>Reads the stories of a registry folder: every .yaml file in its stories/ folder. A file with problems is skipped and reported.</summary>
public static class StoryFiles
{
    public const string FolderName = "stories";

    public static (IReadOnlyList<Story> Stories, IReadOnlyList<string> Notices) Load(string registryFolder)
    {
        var folder = Path.Combine(registryFolder, FolderName);
        var stories = new List<Story>();
        var notices = new List<string>();
        if (!Directory.Exists(folder)) return (stories, notices);
        var yaml = new DeserializerBuilder().WithNamingConvention(CamelCaseNamingConvention.Instance).Build();
        foreach (var file in Directory.EnumerateFiles(folder, "*.yaml").Order(StringComparer.Ordinal))
        {
            var name = Path.GetFileName(file);
            try
            {
                var story = yaml.Deserialize<Story>(File.ReadAllText(file)) ?? new Story();
                if (string.IsNullOrWhiteSpace(story.Id)) story.Id = Path.GetFileNameWithoutExtension(file);
                if (string.IsNullOrWhiteSpace(story.Name)) story.Name = story.Id;
                var problems = story.Problems();
                if (problems.Count > 0) notices.Add($"Story {name} skipped: {string.Join("; ", problems)}.");
                else if (stories.Any(s => s.Id == story.Id)) notices.Add($"Story {name} skipped: another story already has the id '{story.Id}'.");
                else stories.Add(story);
            }
            catch (Exception e)
            {
                notices.Add($"Story {name} skipped: {e.Message}");
            }
        }
        return (stories, notices);
    }
}
