using System.Net;
using System.Text;
using System.Text.Json;

namespace ObservabilityCity.AdapterKit;

/// <summary>One request an adapter sent: what it asked, where, with which headers and what body.</summary>
public sealed record SentRequest(HttpMethod Method, Uri? Uri, IReadOnlyDictionary<string, string> Headers, string Body)
{
    /// <summary>The body as JSON; an adapter that sent none gets an empty object.</summary>
    public JsonElement Json => Body.Length == 0 ? JsonDocument.Parse("{}").RootElement.Clone() : JsonDocument.Parse(Body).RootElement.Clone();
}

/// <summary>
/// An HTTP handler that answers with what a test says and remembers what it was asked, so an adapter is tested against recorded answers and never a
/// live service. Hand it to <c>new HttpClient(canned)</c>. Answers go out in the order given and the last one repeats; <see cref="Respond"/> decides
/// by the request instead.
/// </summary>
public sealed class CannedHttp : HttpMessageHandler
{
    private readonly Queue<Func<SentRequest, HttpResponseMessage>> _answers = new();
    private Func<SentRequest, HttpResponseMessage>? _last;
    private readonly List<SentRequest> _sent = [];

    public IReadOnlyList<SentRequest> Sent => _sent;

    /// <summary>Answers the next request with this status and JSON text.</summary>
    public CannedHttp Answer(string json, HttpStatusCode status = HttpStatusCode.OK) => Respond(_ => Reply(json, status));

    /// <summary>Answers the next request with the result of this function.</summary>
    public CannedHttp Respond(Func<SentRequest, HttpResponseMessage> answer)
    {
        _answers.Enqueue(answer);
        return this;
    }

    /// <summary>Answers every request, whatever it is, with this.</summary>
    public static CannedHttp Always(string json, HttpStatusCode status = HttpStatusCode.OK) => new CannedHttp().Answer(json, status);

    public static HttpResponseMessage Reply(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
        var headers = request.Headers.ToDictionary(h => h.Key, h => string.Join(",", h.Value), StringComparer.OrdinalIgnoreCase);
        var sent = new SentRequest(request.Method, request.RequestUri, headers, body);
        _sent.Add(sent);
        if (_answers.Count > 0) _last = _answers.Dequeue();
        return (_last ?? throw new InvalidOperationException("CannedHttp was asked for something and has no answer. Call Answer(...) first.")).Invoke(sent);
    }
}
