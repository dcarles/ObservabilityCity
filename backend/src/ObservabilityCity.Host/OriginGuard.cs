namespace ObservabilityCity.Host;

/// <summary>
/// Refuses a request whose Origin header names a site that is not this app's own. Browsers send Origin on every WebSocket and cross-site request but
/// do not apply CORS to WebSockets, so this is what stops another page in the same browser from reading the town or calling the write endpoints.
/// A request with no Origin (curl, a test client, the server-to-server call) is let through: only a browser attaches one, and a page cannot leave it off.
/// An origin is allowed when its host is this machine (localhost, 127.0.0.1 or [::1], on any port, which covers the dev server and the test ports),
/// or when it is listed in Security:AllowedOrigins (a hosted deployment lists its own address there).
/// </summary>
public sealed class OriginGuard(RequestDelegate next, IReadOnlyCollection<string> allowed)
{
    private readonly HashSet<string> _allowed = allowed.Select(Normalise).ToHashSet(StringComparer.OrdinalIgnoreCase);

    public Task InvokeAsync(HttpContext context)
    {
        var origin = context.Request.Headers.Origin.ToString();
        if (origin.Length == 0 || IsAllowed(origin)) return next(context);
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        return Task.CompletedTask;
    }

    public bool IsAllowed(string origin)
    {
        if (_allowed.Contains(Normalise(origin))) return true;
        // "null" (a sandboxed page or a file) and anything that is not a web address is not ours
        return Uri.TryCreate(origin, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" && IsLoopback(uri.Host);
    }

    private static bool IsLoopback(string host) => host is "localhost" or "127.0.0.1" or "[::1]" or "::1";

    private static string Normalise(string origin) => origin.Trim().TrimEnd('/');
}
