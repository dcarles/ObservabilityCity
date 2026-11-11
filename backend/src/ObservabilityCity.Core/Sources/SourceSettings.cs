using System.Reflection;
using ObservabilityCity.Core.Registry;
using YamlDotNet.Core;
using YamlDotNet.Core.Events;

namespace ObservabilityCity.Core.Sources;

/// <summary>
/// The keys of one source in an environment file that are not the core's own (the core reads kind, connection, credential, pollSeconds,
/// timeoutSeconds, lateAfterSeconds, query and window). The core does not know what they mean: the module of the source's kind reads them
/// (<see cref="SourceKindInfo.Settings"/>). The block keeps the line of every key and value, so a mistake in it is reported where it is.
/// </summary>
public sealed class SourceSettings
{
    private readonly IReadOnlyList<(SettingsNode Key, SettingsNode Value)> _entries;
    private readonly Mark _start;
    private readonly Mark _end;

    internal SourceSettings(IReadOnlyList<(SettingsNode Key, SettingsNode Value)> entries, Mark start, Mark end)
    {
        _entries = entries;
        _start = start;
        _end = end;
    }

    /// <summary>A source with no keys beyond the core's, or one made in code.</summary>
    public static SourceSettings None { get; } = new([], Mark.Empty, Mark.Empty);

    /// <summary>
    /// The settings of one source block written as YAML (<c>{ kind: x, queries: { rate: ... } }</c>), with the lines of that text: for a test, or a source
    /// made in code. The core's keys are left out, as when an environment file is read. Throws <see cref="ArgumentException"/> when the text is not a source block.
    /// </summary>
    public static SourceSettings Parse(string yaml)
    {
        try { return RegistryLoader.Strict.Deserialize<SourceFile>(yaml)?.Settings ?? None; }
        catch (YamlException e) { throw new ArgumentException($"not a source block: {(e.InnerException ?? e).Message}", nameof(yaml), e); }
    }

    /// <summary>The keys, in the order the file writes them.</summary>
    public IReadOnlyList<string> Keys => _entries.Select(e => e.Key is SettingsScalar s ? s.Event.Value : "?").ToList();

    public bool IsEmpty => _entries.Count == 0;

    /// <summary>The line the source's block starts on (1 when it was made in code).</summary>
    public int Line => Math.Max(1, (int)_start.Line);

    /// <summary>
    /// The line of a key or an item inside the block: a path of keys (string) and list positions (int), for example <c>("metrics", 0, "cpu")</c>.
    /// The deepest part of the path that exists is used, and the block's own line when not even the first does.
    /// </summary>
    public int LineOf(params object[] path)
    {
        var line = Line;
        SettingsNode? node = null;
        foreach (var part in path)
        {
            if (part is string key && (node is null ? _entries : (node as SettingsMap)?.Entries) is { } entries)
            {
                var (k, v) = entries.FirstOrDefault(e => e.Key is SettingsScalar s && s.Event.Value == key);
                if (k is null) break;
                (line, node) = ((int)k.Start.Line, v);
            }
            else if (part is int index && node is SettingsList list && index >= 0 && index < list.Items.Count)
                (line, node) = ((int)list.Items[index].Start.Line, list.Items[index]);
            else break;
        }
        return Math.Max(1, line);
    }

    /// <summary>
    /// Reads the block into <typeparamref name="T"/> as strictly as the core reads its own files: a key <typeparamref name="T"/> has no property for, or a
    /// value of the wrong shape, is a mistake, given with its line. Keys are camelCase, as everywhere in the registry.
    /// </summary>
    public bool TryBind<T>(out T? value, out SettingsFinding? problem) where T : class, new()
    {
        value = null;
        problem = null;
        if (IsEmpty)
        {
            value = new T();
            return true;
        }
        var events = new List<ParsingEvent> { new MappingStart(AnchorName.Empty, TagName.Empty, true, MappingStyle.Any, _start, _start) };
        foreach (var (key, v) in _entries)
        {
            key.Emit(events);
            v.Emit(events);
        }
        events.Add(new MappingEnd(_end, _end));
        try
        {
            value = RegistryLoader.Strict.Deserialize<T>(new Replay(events)) ?? new T();
            return true;
        }
        catch (YamlException e)
        {
            var text = (e.InnerException ?? e).Message;
            var line = e.Start.Line > 0 ? (int)e.Start.Line : Line;
            if (RegistryLoader.UnknownKeyOf(text) is { } key)
                problem = new SettingsFinding(line, key, $"unknown key '{key}'.{DidYouMean.Hint(key, KeysOf(typeof(T)).Concat(RegistryLoader.SourceKeys))}") { LineInMessage = true };
            else
                problem = new SettingsFinding(line, "", text) { LineInMessage = true };
            return false;
        }
    }

    /// <summary>Every key a settings type and the types under it can have, for "did you mean".</summary>
    private static IEnumerable<string> KeysOf(Type type)
    {
        var seen = new HashSet<Type>();
        var keys = new List<string>();
        void Walk(Type t)
        {
            t = Nullable.GetUnderlyingType(t) ?? t;
            if (t.IsGenericType && t.GetGenericArguments() is { } args) foreach (var a in args) Walk(a);
            if (!t.IsClass || t == typeof(string) || t.Namespace?.StartsWith("System", StringComparison.Ordinal) == true || !seen.Add(t)) return;
            foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                keys.Add(char.ToLowerInvariant(p.Name[0]) + p.Name[1..]);
                Walk(p.PropertyType);
            }
        }
        Walk(type);
        return keys;
    }

    /// <summary>Hands the deserializer the block's events again, with the lines they had in the file.</summary>
    private sealed class Replay(IReadOnlyList<ParsingEvent> events) : IParser
    {
        private int _at = -1;
        public ParsingEvent? Current => _at >= 0 && _at < events.Count ? events[_at] : null;
        public bool MoveNext() => ++_at < events.Count;
    }
}

/// <summary>
/// One mistake in a source's settings: the line it is on, the key it is about (a path such as <c>metrics[0].cpu</c>, empty when it is the block) and what is
/// wrong, in words that start where the file's name would end, for example <c>source 'platform' metrics[0]: ...</c>.
/// </summary>
public sealed record SettingsFinding(int Line, string Key, string Message)
{
    /// <summary>A mistake the YAML reader found (an unknown key, a value of the wrong shape): it is reported as the core reports its own, with the line in the text.</summary>
    internal bool LineInMessage { get; init; }
}

/// <summary>What the module of a source's kind is given to read the source's settings with: the block, and the environment's scope (the rules and variables a setting may name).</summary>
public sealed record SourceSettingsContext(string EnvironmentId, string SourceName, string Kind, SourceSettings Settings, ScopeRules Scope);

/// <summary>What the module made of a source's settings: the object its source reads (null when it could not be read) and the mistakes, empty when there are none.</summary>
public sealed record SourceSettingsResult(object? Settings, IReadOnlyList<SettingsFinding> Findings);

/// <summary>
/// How a module reads and checks the settings of its kinds' sources. The loader and the validator ask it for every source of a kind that names it
/// (<see cref="SourceKindInfo.Settings"/>); a kind without one takes no keys beyond the core's.
/// </summary>
public interface ISourceSettingsReader
{
    SourceSettingsResult Read(SourceSettingsContext context);

    /// <summary>
    /// What an editor may complete for a source of these kinds: a JSON schema fragment, an object with <c>properties</c> (the keys this module adds) and
    /// optionally <c>$defs</c> (shared definitions its properties refer to as <c>#/$defs/name</c>). Null: none, and the editor offers only the core's keys.
    /// </summary>
    string? Schema => null;
}

/// <summary>
/// The usual way to write an <see cref="ISourceSettingsReader"/>: the block is read into <typeparamref name="TFile"/> (a plain class with one property for each
/// key, read as strictly as the core's own files), checked by <see cref="Check"/>, and turned into <typeparamref name="TSettings"/>, which the source reads.
/// </summary>
public abstract class SourceSettingsReader<TFile, TSettings> : ISourceSettingsReader where TFile : class, new() where TSettings : class
{
    public virtual string? Schema => null;

    /// <summary>The checks beyond the shape (which the reading checks): values that must be one of a few, rules that must exist and so on.</summary>
    protected virtual void Check(TFile file, SourceSettingsContext context, SettingsReport report) { }

    /// <summary>The settings the source runs with. Called after <see cref="Check"/>, even when it found mistakes, so it must not throw on bad values.</summary>
    protected abstract TSettings Convert(TFile file);

    public SourceSettingsResult Read(SourceSettingsContext context)
    {
        if (!context.Settings.TryBind<TFile>(out var file, out var problem)) return new SourceSettingsResult(null, [problem!]);
        var report = new SettingsReport(context.Settings);
        Check(file!, context, report);
        return new SourceSettingsResult(Convert(file!), report.Findings);
    }

    /// <summary>
    /// The settings a source runs with: what the loader made of them, else (a registry loaded without this module, a source made in code) read now.
    /// Throws <see cref="InvalidOperationException"/> when they cannot be read, which stops the source from starting and says why.
    /// </summary>
    public TSettings For(RegistrySource source)
    {
        if (source.Typed is TSettings typed) return typed;
        if (!source.Settings.TryBind<TFile>(out var file, out var problem)) throw new InvalidOperationException($"its settings cannot be read: line {problem!.Line}: {problem.Message}");
        return Convert(file!);
    }
}

/// <summary>Collects the mistakes a module finds in a source's settings, each placed on the line of the key it is about.</summary>
public sealed class SettingsReport(SourceSettings settings)
{
    private readonly List<SettingsFinding> _findings = [];

    public IReadOnlyList<SettingsFinding> Findings => _findings;

    /// <summary>A mistake about the key at <paramref name="path"/> (keys and list positions, see <see cref="SourceSettings.LineOf"/>); no path: the block.</summary>
    public void Add(string message, params object[] path) =>
        _findings.Add(new SettingsFinding(settings.LineOf(path), string.Join("", path.Select((p, i) => p is int n ? $"[{n}]" : i == 0 ? $"{p}" : $".{p}")), message));
}

// The block as the reader saw it: every node with its place in the file, so it can be read again with the right lines.

internal abstract class SettingsNode(Mark start)
{
    public Mark Start { get; } = start;
    public abstract void Emit(List<ParsingEvent> events);

    /// <summary>Reads the node the parser is on, and moves past it.</summary>
    public static SettingsNode Read(IParser parser)
    {
        switch (parser.Current)
        {
            case Scalar scalar:
                parser.MoveNext();
                return new SettingsScalar(scalar);
            case MappingStart start:
            {
                parser.MoveNext();
                var entries = new List<(SettingsNode, SettingsNode)>();
                while (parser.Current is not MappingEnd) entries.Add((Read(parser), Read(parser)));
                var end = (MappingEnd)parser.Current;
                parser.MoveNext();
                return new SettingsMap(start, entries, end);
            }
            case SequenceStart start:
            {
                parser.MoveNext();
                var items = new List<SettingsNode>();
                while (parser.Current is not SequenceEnd) items.Add(Read(parser));
                var end = (SequenceEnd)parser.Current;
                parser.MoveNext();
                return new SettingsList(start, items, end);
            }
            case AnchorAlias alias:
                parser.MoveNext();
                return new SettingsAlias(alias);
            case { } other:
                throw new YamlException(other.Start, other.End, $"Unexpected '{other.GetType().Name}' in a source's settings");
            default:
                throw new YamlException("The file ended inside a source's settings");
        }
    }
}

internal sealed class SettingsScalar(Scalar scalar) : SettingsNode(scalar.Start)
{
    public Scalar Event { get; } = scalar;
    public override void Emit(List<ParsingEvent> events) => events.Add(Event);
}

internal sealed class SettingsAlias(AnchorAlias alias) : SettingsNode(alias.Start)
{
    public override void Emit(List<ParsingEvent> events) => events.Add(alias);
}

internal sealed class SettingsMap(MappingStart start, IReadOnlyList<(SettingsNode Key, SettingsNode Value)> entries, MappingEnd end) : SettingsNode(start.Start)
{
    public IReadOnlyList<(SettingsNode Key, SettingsNode Value)> Entries { get; } = entries;

    public override void Emit(List<ParsingEvent> events)
    {
        events.Add(start);
        foreach (var (k, v) in Entries) { k.Emit(events); v.Emit(events); }
        events.Add(end);
    }
}

internal sealed class SettingsList(SequenceStart start, IReadOnlyList<SettingsNode> items, SequenceEnd end) : SettingsNode(start.Start)
{
    public IReadOnlyList<SettingsNode> Items { get; } = items;

    public override void Emit(List<ParsingEvent> events)
    {
        events.Add(start);
        foreach (var item in Items) item.Emit(events);
        events.Add(end);
    }
}
