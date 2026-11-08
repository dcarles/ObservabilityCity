using Microsoft.Extensions.Logging;
using ObservabilityCity.Core.Sources;

namespace ObservabilityCity.Tests;

/// <summary>A reading cache that cannot save (a read-only or missing mount) says so in the log; without that, a restart leaves everything grey with no explanation.</summary>
public class ReadingCacheLogTests
{
    private sealed class Capture : ILogger
    {
        public readonly List<(LogLevel Level, string Message)> Lines = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) => Lines.Add((logLevel, formatter(state, exception)));
    }

    [Fact]
    public void A_save_that_fails_is_logged_as_a_warning_naming_the_source()
    {
        // the folder is a file, so it can be neither created nor written to on any system
        var blocker = Path.GetTempFileName();
        try
        {
            var log = new Capture();

            new ReadingCache(Path.Combine(blocker, "readings"), log).Save("platform", new Dictionary<string, NodeReading> { ["aa.orders-db"] = new(DateTimeOffset.UnixEpoch, true, 0, 0, 0, 0, 0, 0) });

            var line = Assert.Single(log.Lines);
            Assert.Equal(LogLevel.Warning, line.Level);
            Assert.Contains("platform", line.Message);
        }
        finally { File.Delete(blocker); }
    }
}
