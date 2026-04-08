// Semantically duplicated from Hub Core.BusinessRules.MergeCodes.RazorJsonMergeDocumentBuilder.
// Hub embeds @helper/@functions in a string; RazorEngine.NetCore uses Roslyn Razor and does NOT support those directives.
// So: same EpicBlock model, same init block logic, same helper *behavior* as C# methods on TemplateBase + a small Razor header.

using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Dynamic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RazorEngine;
using RazorEngine.Compilation;
using RazorEngine.Compilation.ReferenceResolver;
using RazorEngine.Configuration;
using RazorEngine.Templating;
using RazorEngine.Text;

namespace RazorJsonMerge;

/// <summary>
/// SHA256 hex of ASCII bytes — matches Core.Encryption.Hash.ComputeHash(..., SHA256) for template cache keys.
/// </summary>
internal static class HubMergeStringHash
{
	internal static string ComputeSha256HexAscii(string input)
	{
		var inputBytes = System.Text.Encoding.ASCII.GetBytes(input);
		var hash = SHA256.HashData(inputBytes);
		var ret = new StringBuilder();
		foreach (var t in hash)
			ret.Append(t.ToString("x2"));
		return ret.ToString();
	}
}

/// <summary>
/// Same shape as EpicBlock inside Hub's Razor header @functions block.
/// </summary>
public class EpicBlock
{
	public EpicBlock(IDictionary<string, object> jsonBlock)
	{
		TableName = jsonBlock["name"].ToString()!;
		Values = jsonBlock["values"] as IDictionary<string, object>;
	}

	public string TableName { get; set; } = "";
	public IDictionary<string, object>? Values { get; set; }
}

/// <summary>
/// Implements the @helper methods from Hub's RazorJsonMergeDocumentBuilder header as TemplateBase members.
/// </summary>
public abstract class HubEpicTemplateBase<T> : TemplateBase<T>
{
	public IEncodedString Raw(object? value) =>
		new RawString(value?.ToString() ?? "");

	public IEncodedString Value(string tableName, string key)
	{
		var epicData = ViewBag.EpicData as List<EpicBlock>;
		EpicBlock? block = null;
		if (epicData != null)
			block = epicData.SingleOrDefault(a => a.TableName == tableName);
		return Value(block, key);
	}

	public IEncodedString Value(EpicBlock? block, string key)
	{
		if (block?.Values != null && block.Values.ContainsKey(key))
		{
			return block.Values[key] == null
				? new RawString("null")
				: new RawString("\"" + block.Values[key]!.ToString() + "\"");
		}

		return new RawString("null");
	}

	public IEncodedString NullableReferenceProperty(string tableName, string key, string propertyName, string lookupPropertyName)
	{
		var epicData = ViewBag.EpicData as List<EpicBlock>;
		EpicBlock? block = null;
		if (epicData != null)
			block = epicData.SingleOrDefault(a => a.TableName == tableName);
		return NullableReferenceProperty(block, key, propertyName, lookupPropertyName);
	}

	public IEncodedString NullableReferenceProperty(EpicBlock? block, string key, string propertyName, string lookupPropertyName)
	{
		if (block?.Values != null && block.Values.ContainsKey(key))
		{
			if (block.Values[key] != null)
			{
				var builder = new StringBuilder();
				builder.Append("\"" + propertyName + "\": {");
				builder.AppendLine();
				builder.Append("\t\t\"EQ_LookupInfo\": {");
				builder.AppendLine();
				builder.Append("\t\t\t\"" + lookupPropertyName + "\" : \"" + block.Values[key]!.ToString() + "\"");
				builder.AppendLine();
				builder.Append("\t\t}");
				builder.AppendLine();
				builder.Append("\t}");
				return new RawString(builder.ToString());
			}

			return new RawString("\"" + propertyName + "\" : null");
		}

		return new RawString("\"" + propertyName + "\" : null");
	}

	public IEncodedString AllValues(string tableName)
	{
		var epicData = ViewBag.EpicData as List<EpicBlock>;
		EpicBlock? block = null;
		if (epicData != null)
			block = epicData.SingleOrDefault(a => a.TableName == tableName);
		return AllValues(block);
	}

	public IEncodedString AllValues(EpicBlock? block)
	{
		if (block?.Values == null)
			return new RawString("");

		var sb = new StringBuilder();
		foreach (var value in block.Values)
			sb.Append("{\"name\":\"" + value.Key + "\",\"value\":\"" + value.Value + "\"},\n");
		return new RawString(sb.ToString());
	}
}

/// <summary>
/// Filters out assemblies with no file path (dynamic/in-memory assemblies loaded by .NET 5+).
/// Without this, Roslyn crashes trying to open "" as a file when building metadata references.
/// </summary>
internal class SafeReferenceResolver : IReferenceResolver
{
    private readonly UseCurrentAssembliesReferenceResolver _inner = new();

    public IEnumerable<CompilerReference> GetReferences(TypeContext context, IEnumerable<CompilerReference>? references = null)
    {
        foreach (var r in _inner.GetReferences(context, references))
        {
            if (r.ReferenceType == CompilerReference.CompilerReferenceType.DirectAssemblyReference)
            {
                Assembly? asm = null;
                try { asm = r.Visit(AssemblyExtractor.Instance); } catch { }
                if (asm == null) continue;

                var loc = asm.Location;
                if (string.IsNullOrEmpty(loc) || !File.Exists(loc))
                {
                    // In a non-single-file self-contained publish the extraction dir is AppContext.BaseDirectory.
                    // Try to find the assembly file there by assembly simple name.
                    var candidate = Path.Combine(AppContext.BaseDirectory, asm.GetName().Name + ".dll");
                    if (File.Exists(candidate))
                        yield return CompilerReference.From(candidate);
                    // If still not found, skip — don't pass an empty path to Roslyn
                    continue;
                }
            }
            yield return r;
        }
    }

    private class AssemblyExtractor : CompilerReference.ICompilerReferenceVisitor<Assembly?>
    {
        public static readonly AssemblyExtractor Instance = new();
        public Assembly? Visit(Assembly assembly) => assembly;
        public Assembly? Visit(string file) => null;
        public Assembly? Visit(Stream stream) => null;
        public Assembly? Visit(byte[] byteArray) => null;
    }
}

/// <summary>
/// In-memory caching provider — avoids DefaultCachingProvider which calls Directory.Delete("")
/// during construction on some RazorEngine.NetCore builds, crashing before any template runs.
/// razor-runner is a short-lived process so in-memory cache is fine.
/// </summary>
internal class InMemoryCachingProvider : ICachingProvider
{
    private readonly ConcurrentDictionary<string, ICompiledTemplate> _cache = new();

    public void CacheTemplate(ICompiledTemplate template, ITemplateKey templateKey)
        => _cache[templateKey.GetUniqueKeyString()] = template;

    public bool TryRetrieveTemplate(ITemplateKey templateKey, Type modelType, out ICompiledTemplate compiledTemplate)
        => _cache.TryGetValue(templateKey.GetUniqueKeyString(), out compiledTemplate!);

    public void InvalidateCache(ITemplateKey templateKey)
        => _cache.TryRemove(templateKey.GetUniqueKeyString(), out _);

    public RazorEngine.Templating.TypeLoader TypeLoader { get; } = new RazorEngine.Templating.TypeLoader(AppDomain.CurrentDomain, new List<System.Reflection.Assembly>());

    public void Dispose() { }
}

/// <summary>
/// Hub-equivalent json-epic merge (RazorEngine config + model type + init block).
/// </summary>
internal static class HubRazorJsonMergeDocumentBuilderDuplicate
{
	// Razor init only — helpers live on HubEpicTemplateBase<T> (NetCore Razor cannot compile @helper).
	private const string InitHeader = @"
@using System.Collections
@using System.Collections.Generic
@using System.Dynamic
@using Newtonsoft.Json
@using Newtonsoft.Json.Linq
@using System.Text
@using System.Linq
@using RazorJsonMerge
@{
    var modelJson = JObject.Parse(JsonConvert.SerializeObject(Model));

    ViewBag.EpicData = new List<EpicBlock>();
    var EpicData = ViewBag.EpicData as List<EpicBlock>;
    try
    {
        var topLevelEpicDictionary = Model as IDictionary<string, object>;

        if (topLevelEpicDictionary != null && topLevelEpicDictionary.ContainsKey(""data""))
        {
            var epicEnumerable = topLevelEpicDictionary[""data""] as System.Collections.IEnumerable;
            if (epicEnumerable != null)
            {
                foreach (var blockObj in epicEnumerable)
                {
                    if (blockObj is IDictionary<string, object> block)
                        ViewBag.EpicData.Add(new EpicBlock(block));
                }
            }
        }
        else if (topLevelEpicDictionary != null)
        {
            ViewBag.EpicData.Add(new EpicBlock(topLevelEpicDictionary));
        }

        EpicData = ViewBag.EpicData as List<EpicBlock>;
    }
    catch (KeyNotFoundException)
    {
    }
}
";

	private static bool _razorConfigured;
	private static readonly object ConfigurationLock = new();

	internal static string SearchAndReplace(string template, string epicJson)
	{
		EnsureRazorIsConfigured();

		var newTemplate = $"{InitHeader}{Environment.NewLine}{template}";

		var model = JsonConvert.DeserializeObject<ExpandoObject>(epicJson) as IDictionary<string, object>;
		if (model == null)
			throw new Exception("Invalid JSON: expected an object at the root.");

		var cacheKey = HubMergeStringHash.ComputeSha256HexAscii(template);
		return Engine.Razor.RunCompile(newTemplate, cacheKey, typeof(IDictionary<string, object>), model).TrimStart();
	}

	private static void EnsureRazorIsConfigured()
	{
		lock (ConfigurationLock)
		{
			if (_razorConfigured)
				return;

			var config = new TemplateServiceConfiguration
			{
				Language = Language.CSharp,
				EncodedStringFactory = new HtmlEncodedStringFactory(),
				DisableTempFileLocking = true,
				BaseTemplateType = typeof(HubEpicTemplateBase<>),
				CachingProvider = new InMemoryCachingProvider(),
				ReferenceResolver = new SafeReferenceResolver()
			};

			Engine.Razor = RazorEngineService.Create(config);
			_razorConfigured = true;
		}
	}
}
