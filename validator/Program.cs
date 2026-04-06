using System.Text.Json;

var argsMap = ParseArgs(args);
var mode = argsMap.TryGetValue("--mode", out var modeValue) ? modeValue : "json-epic";
var templatePath = argsMap.TryGetValue("--template", out var templateValue) ? templateValue : string.Empty;
var samplePath = argsMap.TryGetValue("--sample", out var sampleValue) ? sampleValue : string.Empty;

var messages = new List<string>();

if (string.IsNullOrWhiteSpace(templatePath) || !File.Exists(templatePath))
{
    WriteResult(false, new[] { "Missing --template file." });
    return;
}

if (string.IsNullOrWhiteSpace(samplePath) || !File.Exists(samplePath))
{
    WriteResult(false, new[] { "Missing --sample file." });
    return;
}

var template = File.ReadAllText(templatePath);
var sample = File.ReadAllText(samplePath);

// Placeholder behavior so the contract is testable before internal references are wired in.
// Replace this with real calls into RazorMergeDocumentBuilder / RazorJsonMergeDocumentBuilder.
if (string.IsNullOrWhiteSpace(template))
{
    messages.Add("Template is empty.");
    WriteResult(false, messages);
    return;
}

messages.Add($"Stub validator ran in {mode} mode.");
messages.Add($"Template length: {template.Length} characters.");
messages.Add($"Sample length: {sample.Length} characters.");
messages.Add("Replace validator/Program.cs with calls into your real merge builders for true compilation.");
WriteResult(true, messages);

static Dictionary<string, string> ParseArgs(string[] args)
{
    var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    for (var i = 0; i < args.Length; i++)
    {
        if (!args[i].StartsWith("--", StringComparison.Ordinal)) continue;
        var value = i + 1 < args.Length ? args[i + 1] : string.Empty;
        map[args[i]] = value;
    }
    return map;
}

static void WriteResult(bool ok, IEnumerable<string> messages)
{
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        ok,
        messages = messages.ToArray()
    }));
}
