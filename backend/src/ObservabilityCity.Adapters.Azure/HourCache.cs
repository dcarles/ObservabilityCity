namespace ObservabilityCity.Adapters.Azure;

/// <summary>
/// The answers of hourly (range) queries, kept for the frames of that hour. A fill goes back in time one hour after another, so only the last few hours are kept.
/// An answer that failed is forgotten, so the next frame asks again.
/// </summary>
internal sealed class HourCache<T>(int keep = 3)
{
    private readonly object _lock = new();
    private readonly Dictionary<DateTimeOffset, Task<T>> _hours = [];
    private readonly List<DateTimeOffset> _order = [];

    /// <summary>The start of the hour that holds <paramref name="at"/>.</summary>
    public static DateTimeOffset HourOf(DateTimeOffset at) => new(at.UtcTicks - at.UtcTicks % TimeSpan.FromHours(1).Ticks, TimeSpan.Zero);

    public async Task<T> GetAsync(DateTimeOffset hour, Func<Task<T>> ask)
    {
        Task<T> task;
        lock (_lock)
        {
            if (!_hours.TryGetValue(hour, out task!))
            {
                task = ask();
                _hours[hour] = task;
                _order.Add(hour);
                while (_order.Count > keep) { _hours.Remove(_order[0]); _order.RemoveAt(0); }
            }
        }
        try { return await task; }
        catch
        {
            lock (_lock) if (_hours.TryGetValue(hour, out var t) && t == task) { _hours.Remove(hour); _order.Remove(hour); }
            throw;
        }
    }
}
