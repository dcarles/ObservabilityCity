using System.Text.Json.Nodes;

namespace ObservabilityCity.Core.History;

/// <summary>
/// The changes between two snapshots, as a list of operations on paths, so that a frame after the first one of an hour holds only what moved. An
/// operation is <c>{"p":[path],"v":value}</c> (set the value at the path) or <c>{"p":[path],"d":1}</c> (remove it). Objects are compared field by field; a list that
/// differs is replaced whole, because its parts have no stable identity.
/// </summary>
public static class SnapshotPatch
{
    public static JsonArray Diff(JsonNode? before, JsonNode? after)
    {
        var ops = new JsonArray();
        Walk(before, after, new List<object>(), ops);
        return ops;
    }

    private static void Walk(JsonNode? before, JsonNode? after, List<object> path, JsonArray ops)
    {
        if (before is JsonArray ba && after is JsonArray aa && ba.Count == aa.Count)
        {
            for (var i = 0; i < ba.Count; i++)
            {
                path.Add(i);
                Walk(ba[i], aa[i], path, ops);
                path.RemoveAt(path.Count - 1);
            }
            return;
        }
        if (before is JsonObject b && after is JsonObject a)
        {
            foreach (var (key, value) in a)
            {
                path.Add(key);
                if (b.TryGetPropertyValue(key, out var old)) Walk(old, value, path, ops);
                else Set(path, value, ops);
                path.RemoveAt(path.Count - 1);
            }
            foreach (var (key, _) in b)
                if (!a.ContainsKey(key))
                {
                    path.Add(key);
                    ops.Add(new JsonObject { ["p"] = Path(path), ["d"] = 1 });
                    path.RemoveAt(path.Count - 1);
                }
            return;
        }
        if (!JsonNode.DeepEquals(before, after)) Set(path, after, ops);
    }

    private static void Set(List<object> path, JsonNode? value, JsonArray ops) =>
        ops.Add(new JsonObject { ["p"] = Path(path), ["v"] = value?.DeepClone() });

    private static JsonArray Path(List<object> path) => new(path.Select(p => p is int i ? JsonValue.Create(i) : JsonValue.Create((string)p)).Cast<JsonNode?>().ToArray());

    /// <summary>The snapshot that results from applying the operations to this one. The result is a new tree; the one given is left alone.</summary>
    public static JsonNode Apply(JsonNode before, JsonArray ops)
    {
        var root = before.DeepClone();
        foreach (var op in ops.OfType<JsonObject>())
        {
            var path = (op["p"] as JsonArray ?? []).Select(p => p!.AsValue()).ToList();
            if (path.Count == 0)
            {
                if (op["v"] is { } whole) return whole.DeepClone();
                continue;
            }
            var node = root;
            for (var i = 0; i < path.Count - 1 && node is not null; i++) node = Child(node, path[i]);
            if (node is null) continue;
            var last = path[^1];
            var value = op.ContainsKey("d") ? null : op["v"]?.DeepClone();
            if (node is JsonObject o && last.TryGetValue<string>(out var key))
            {
                if (op.ContainsKey("d")) o.Remove(key);
                else o[key] = value;
            }
            else if (node is JsonArray a && last.TryGetValue<int>(out var index) && index >= 0 && index < a.Count) a[index] = value;
        }
        return root;
    }

    private static JsonNode? Child(JsonNode node, JsonValue segment) =>
        node is JsonObject o && segment.TryGetValue<string>(out var key) ? (o.TryGetPropertyValue(key, out var next) ? next : null)
        : node is JsonArray a && segment.TryGetValue<int>(out var index) && index >= 0 && index < a.Count ? a[index]
        : null;
}
