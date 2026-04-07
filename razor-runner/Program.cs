// razor-runner — executes a Razor/C# Epic transform against a JSON payload
// Usage:  razor-runner <template-file> <input-json-file>
//         razor-runner --stdin  (first line = JSON, remainder = template)
// Exit 0 = success (rendered output on stdout)
// Exit 1 = error   (JSON error message on stderr)

using System;
using System.Collections.Generic;
using System.Dynamic;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RazorEngine.Configuration;
using RazorEngine.Templating;
using RazorEngine.Text;

// ── EpicBlock ─────────────────────────────────────────────────────────────────
public class EpicBlock
{
    public string TableName { get; set; } = "";
    public IDictionary<string, object?> Values { get; set; } = new Dictionary<string, object?>();
    public EpicBlock(string tableName, IDictionary<string, object?> values)
    {
        TableName = tableName;
        Values = values;
    }
}

// ── Base template — all helpers inherit into every template ───────────────────
public abstract class EpicTemplateBase<T> : TemplateBase<T>
{
    // Get modelJson from the dynamic model
    private JObject GetMj()
    {
        try { return (JObject)((dynamic)Model!).modelJson; }
        catch { return new JObject(); }
    }

    // ── @Raw(value) ───────────────────────────────────────────────────────────
    public IEncodedString Raw(object? value) =>
        new RazorEngine.Text.RawString(value?.ToString() ?? "");

    // ── @Value("TABLE_NAME", "FIELD_NAME") ────────────────────────────────────
    public IEncodedString Value(string tableName, string fieldName)
    {
        var table = GetMj()["data"]?
            .FirstOrDefault(t => t["name"]?.ToString() == tableName);
        if (table == null) return new RazorEngine.Text.RawString("null");
        var val = table["values"]?[fieldName];
        return QuoteToken(val);
    }

    // ── @Value(epicBlock, "FIELD_NAME") ───────────────────────────────────────
    public IEncodedString Value(EpicBlock? block, string fieldName)
    {
        if (block?.Values == null) return new RazorEngine.Text.RawString("null");
        block.Values.TryGetValue(fieldName, out var raw);
        if (raw == null) return new RazorEngine.Text.RawString("null");
        var str = raw.ToString() ?? "";
        return string.IsNullOrEmpty(str) ? new RazorEngine.Text.RawString("null") : new RazorEngine.Text.RawString(JsonQuote(str));
    }

    // ── @AllValues("TABLE_NAME") ──────────────────────────────────────────────
    public IEncodedString AllValues(string tableName)
    {
        var table = GetMj()["data"]?
            .FirstOrDefault(t => t["name"]?.ToString() == tableName);
        return AllValuesFromJObject(table?["values"] as JObject);
    }

    // ── @AllValues(epicBlock) ─────────────────────────────────────────────────
    public IEncodedString AllValues(EpicBlock? block)
    {
        if (block?.Values == null) return new RazorEngine.Text.RawString("");
        var sb = new StringBuilder();
        foreach (var kv in block.Values)
            sb.AppendLine($"{{\"name\":\"{kv.Key}\",\"value\":\"{Esc(kv.Value?.ToString())}\"}},");
        return new RazorEngine.Text.RawString(sb.ToString());
    }

    private IEncodedString AllValuesFromJObject(JObject? values)
    {
        if (values == null) return new RazorEngine.Text.RawString("");
        var sb = new StringBuilder();
        foreach (var prop in values.Properties())
        {
            var v = prop.Value.Type == JTokenType.Null ? "" : Esc(prop.Value.ToString());
            sb.AppendLine($"{{\"name\":\"{prop.Name}\",\"value\":\"{v}\"}},");
        }
        return new RazorEngine.Text.RawString(sb.ToString());
    }

    // ── @NullableReferenceProperty("TABLE","FIELD","propName","lookupProp") ───
    public IEncodedString NullableReferenceProperty(
        string tableName, string fieldName, string propName, string lookupPropName)
    {
        var table = GetMj()["data"]?
            .FirstOrDefault(t => t["name"]?.ToString() == tableName);
        var val = table?["values"]?[fieldName]?.ToString();
        return NullRef(val, propName, lookupPropName);
    }

    // ── @NullableReferenceProperty(block,"FIELD","propName","lookupProp") ─────
    public IEncodedString NullableReferenceProperty(
        EpicBlock? block, string fieldName, string propName, string lookupPropName)
    {
        object? raw = null;
        block?.Values?.TryGetValue(fieldName, out raw);
        return NullRef(raw?.ToString(), propName, lookupPropName);
    }

    private IEncodedString NullRef(string? val, string propName, string lookupPropName) =>
        string.IsNullOrEmpty(val)
            ? new RazorEngine.Text.RawString($"\"{propName}\": null")
            : new RazorEngine.Text.RawString($"\"{propName}\": {{ \"EQ_LookupInfo\": {{ \"{lookupPropName}\": \"{Esc(val)}\" }} }}");

    private static IEncodedString QuoteToken(JToken? val)
    {
        if (val == null || val.Type == JTokenType.Null) return new RazorEngine.Text.RawString("null");
        var str = val.ToString();
        return string.IsNullOrEmpty(str) ? new RazorEngine.Text.RawString("null") : new RazorEngine.Text.RawString(JsonQuote(str));
    }

    private static string JsonQuote(string s) => "\"" + Esc(s) + "\"";
    private static string Esc(string? s) =>
        (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────
class Program
{
    static int Main(string[] args)
    {
        string templateText, inputJsonText;
        try
        {
            if (args.Length >= 2)
            {
                templateText  = File.ReadAllText(args[0], System.Text.Encoding.UTF8);
                inputJsonText = File.ReadAllText(args[1], System.Text.Encoding.UTF8);
            }
            else if (args.Length == 1 && args[0] == "--stdin")
            {
                var all = Console.In.ReadToEnd();
                var nl = all.IndexOf('\n');
                if (nl < 0) { WriteError("stdin: first line must be JSON, remainder is template"); return 1; }
                inputJsonText = all[..nl].Trim();
                templateText  = all[(nl + 1)..];
            }
            else
            {
                WriteError("Usage: razor-runner <template.cshtml> <input.json>  OR  razor-runner --stdin");
                return 1;
            }

            Console.Write(RunTemplate(templateText, inputJsonText));
            return 0;
        }
        catch (Exception ex)
        {
            var msg = ex.Message;
            if (ex.InnerException != null) msg += "\n" + ex.InnerException.Message;
            WriteError(msg);
            return 1;
        }
    }

    static string RunTemplate(string template, string inputJson)
    {
        JObject modelJson;
        try { modelJson = JObject.Parse(inputJson); }
        catch (Exception ex) { throw new Exception("Invalid input JSON: " + ex.Message); }

        // Build EpicData from data array
        var epicData = new List<EpicBlock>();
        if (modelJson["data"] is JArray arr)
        {
            foreach (var item in arr)
            {
                var name = item["name"]?.ToString() ?? "";
                var dict = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
                if (item["values"] is JObject vals)
                    foreach (var p in vals.Properties())
                        dict[p.Name] = p.Value.Type == JTokenType.Null ? null : (object?)p.Value.ToString();
                epicData.Add(new EpicBlock(name, dict));
            }
        }

        // Model passed to template
        dynamic model = new ExpandoObject();
        model.modelJson = modelJson;
        model.EpicData  = epicData;

        // Header: exposes modelJson and EpicData as local C# variables.
        // @Value/@Raw/@AllValues/@NullableReferenceProperty are inherited from EpicTemplateBase.
        const string header = @"@using System
@using System.Linq
@using System.Text
@using System.Collections.Generic
@using System.Dynamic
@using Newtonsoft.Json
@using Newtonsoft.Json.Linq
@{
    var modelJson = (Newtonsoft.Json.Linq.JObject)((dynamic)Model).modelJson;
    var EpicData  = (System.Collections.Generic.List<EpicBlock>)((dynamic)Model).EpicData;
}";

        var full = header + "\n" + template;
        var key  = Guid.NewGuid().ToString("N");

        var cfg = new TemplateServiceConfiguration
        {
            BaseTemplateType     = typeof(EpicTemplateBase<>),
            TemplateManager      = new DelegateTemplateManager(),
            DisableTempFileLocking = true,
            CachingProvider      = new DefaultCachingProvider(_ => { })
        };

        using var svc = RazorEngine.Templating.RazorEngineService.Create(cfg);
        try
        {
            return svc.RunCompile(full, key, typeof(ExpandoObject), (object)model);
        }
        catch (TemplateCompilationException tce)
        {
            // Filter out noise, surface real errors
            var realErrors = tce.CompilerErrors
                .Where(e => !e.IsWarning && !e.ErrorText.Contains("Assuming assembly reference"))
                .Select(e => $"  Line {e.Line}: {e.ErrorText}");
            throw new Exception("Template compilation error:\n" + string.Join("\n", realErrors));
        }
    }

    static void WriteError(string msg) =>
        Console.Error.WriteLine(JsonConvert.SerializeObject(new { error = msg }));
}
