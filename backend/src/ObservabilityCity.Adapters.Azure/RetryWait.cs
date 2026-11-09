using System.Net;
using System.Net.Http.Headers;

namespace ObservabilityCity.Adapters.Azure;

/// <summary>
/// How long to wait before asking Azure again after a hiccup. When Azure says how long (<c>Retry-After</c>, as seconds or as a date), that is the wait, never
/// longer than <see cref="Longest"/>: asking sooner only keeps the throttling going. Without it the wait grows with each attempt. A little jitter is added so that
/// the many reads of one round do not all come back at the same moment.
/// </summary>
public static class RetryWait
{
    /// <summary>The longest a read waits on Azure's word; a source's own timeout is shorter than a minute of waiting anyway.</summary>
    public static readonly TimeSpan Longest = TimeSpan.FromSeconds(30);

    /// <summary>The wait before attempt + 1. A base of zero (tests) means no waiting at all.</summary>
    public static TimeSpan For(HttpResponseHeaders? headers, int attempt, TimeSpan? baseDelay, DateTimeOffset now, double jitter)
    {
        var step = baseDelay ?? TimeSpan.FromMilliseconds(400);
        if (step <= TimeSpan.Zero) return TimeSpan.Zero;
        var told = headers?.RetryAfter is { } after ? after.Delta ?? (after.Date is { } date ? date - now : null) : null;
        var wait = told is { } t && t > TimeSpan.Zero ? t : step * attempt;
        if (wait > Longest) wait = Longest;
        return wait + wait * (0.25 * Math.Clamp(jitter, 0, 1));
    }

    /// <summary>Statuses that pass by themselves: busy, throttled, unavailable.</summary>
    public static bool IsHiccup(HttpStatusCode code) => code is HttpStatusCode.TooManyRequests or HttpStatusCode.InternalServerError
        or HttpStatusCode.BadGateway or HttpStatusCode.ServiceUnavailable or HttpStatusCode.GatewayTimeout;
}
