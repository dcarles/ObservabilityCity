namespace ObservabilityCity.Tests;

/// <summary>A throw-away copy of a registry folder, for tests that break something in it.</summary>
internal sealed class RegistryCopy : IDisposable
{
    public string Path { get; } = Directory.CreateTempSubdirectory().FullName;

    public RegistryCopy(string source)
    {
        foreach (var dir in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(System.IO.Path.Combine(Path, System.IO.Path.GetRelativePath(source, dir)));
        foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
            File.Copy(file, System.IO.Path.Combine(Path, System.IO.Path.GetRelativePath(source, file)));
    }

    public string FilePath(string relative) => System.IO.Path.Combine(Path, relative);

    public string Read(string relative) => File.ReadAllText(FilePath(relative));

    public void Write(string relative, string text) => File.WriteAllText(FilePath(relative), text);

    /// <summary>Replaces text that must occur exactly once, so a test fails loudly when the fixture changes under it.</summary>
    public void Replace(string relative, string oldText, string newText)
    {
        var text = Read(relative);
        Assert.Equal(1, text.Split(oldText).Length - 1);
        Write(relative, text.Replace(oldText, newText));
    }

    /// <summary>Replaces the one line that contains the text.</summary>
    public void ReplaceLine(string relative, string containing, string newLine)
    {
        var lines = Read(relative).Split('\n');
        var i = Array.FindIndex(lines, l => l.Contains(containing));
        Assert.True(i >= 0, $"'{containing}' not found in {relative}");
        lines[i] = newLine;
        Write(relative, string.Join('\n', lines));
    }

    /// <summary>The 1-based line on which the text first appears.</summary>
    public int LineOf(string relative, string text)
    {
        var lines = Read(relative).Split('\n');
        var i = Array.FindIndex(lines, l => l.Contains(text));
        Assert.True(i >= 0, $"'{text}' not found in {relative}");
        return i + 1;
    }

    public void Dispose() => Directory.Delete(Path, true);
}
