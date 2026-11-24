using System.Text.RegularExpressions;

namespace ObservabilityCity.Core.Apis;

/// <summary>
/// Hides anything in a policy's XML that looks like a secret before it leaves the server: the value of an attribute or header whose name says it is one (a key, secret, password, token, signature,
/// connection string or authorization), a bearer token, and any long opaque run of letters and digits (32 or more characters). A reference to a named value (<c>{{name}}</c>), a flag or a number is
/// left alone, so the policy still reads. Nothing here knows a cloud: it only reads XML text.
/// </summary>
public static partial class PolicyMask
{
    public const string Masked = "[masked]";

    [GeneratedRegex("(key|secret|passw|pwd|token|credential|authorization|connection-?string|signature|\\bsas\\b|thumbprint)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SecretName();

    [GeneratedRegex("(?<name>[\\w:.-]+)(?<eq>\\s*=\\s*)\"(?<value>[^\"]*)\"", RegexOptions.CultureInvariant)]
    private static partial Regex Attribute();

    [GeneratedRegex("(?<open><(?:set-header|set-query-parameter)\\b[^>]*?\\bname\\s*=\\s*\"(?<n>[^\"]*)\"[^>]*>\\s*<value>)(?<v>[^<]*)(?<close></value>)", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex HeaderValue();

    [GeneratedRegex("Bearer\\s+(?<t>[A-Za-z0-9._~+/=-]{10,})", RegexOptions.CultureInvariant)]
    private static partial Regex Bearer();

    [GeneratedRegex("(?<![\\w/.:%-])(?=[A-Za-z0-9+/=_-]*[A-Za-z])(?=[A-Za-z0-9+/=_-]*\\d)[A-Za-z0-9+/=_-]{32,}(?![\\w/.:%-])", RegexOptions.CultureInvariant)]
    private static partial Regex Opaque();

    public static string Apply(string xml)
    {
        var text = Attribute().Replace(xml, m => SecretName().IsMatch(m.Groups["name"].Value) && Hide(m.Groups["value"].Value)
            ? $"{m.Groups["name"].Value}{m.Groups["eq"].Value}\"{Masked}\"" : m.Value);
        text = HeaderValue().Replace(text, m => SecretName().IsMatch(m.Groups["n"].Value) && Hide(m.Groups["v"].Value) ? m.Groups["open"].Value + Masked + m.Groups["close"].Value : m.Value);
        text = Bearer().Replace(text, m => Hide(m.Groups["t"].Value) ? "Bearer " + Masked : m.Value);
        return Opaque().Replace(text, m => IsReference(text, m) ? m.Value : Masked);
    }

    /// <summary>A value worth hiding: not empty, not a flag or a number, not a reference to a named value.</summary>
    private static bool Hide(string value)
    {
        var v = value.Trim();
        return v.Length > 0 && !v.Equals("true", StringComparison.OrdinalIgnoreCase) && !v.Equals("false", StringComparison.OrdinalIgnoreCase)
               && !double.TryParse(v, System.Globalization.CultureInfo.InvariantCulture, out _) && !(v.StartsWith("{{", StringComparison.Ordinal) && v.EndsWith("}}", StringComparison.Ordinal)) && v != Masked;
    }

    private static bool IsReference(string text, Match m) => m.Index >= 2 && text.AsSpan(m.Index - 2, 2) is "{{";
}
