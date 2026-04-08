// razor-runner — executes a Razor/C# Epic transform against a JSON payload (Hub-compatible).
// Usage:  razor-runner <template-file> <input-json-file>
//         razor-runner --stdin  (first line = JSON, remainder = template)
// Exit 0 = success (rendered output on stdout)
// Exit 1 = error   (JSON error message on stderr)

using System;
using System.Linq;
using Newtonsoft.Json;
using RazorJsonMerge;
using RazorEngine.Templating;

class Program
{
	static int Main(string[] args)
	{
		string templateText, inputJsonText;
		try
		{
			if (args.Length >= 2)
			{
				templateText = File.ReadAllText(args[0], System.Text.Encoding.UTF8);
				inputJsonText = File.ReadAllText(args[1], System.Text.Encoding.UTF8);
			}
			else if (args.Length == 1 && args[0] == "--stdin")
			{
				var all = Console.In.ReadToEnd();
				var nl = all.IndexOf('\n');
				if (nl < 0)
				{
					WriteError("stdin: first line must be JSON, remainder is template");
					return 1;
				}

				inputJsonText = all[..nl].Trim();
				templateText = all[(nl + 1)..];
			}
			else
			{
				WriteError("Usage: razor-runner <template.cshtml> <input.json>  OR  razor-runner --stdin");
				return 1;
			}

			Console.Write(HubRazorJsonMergeDocumentBuilderDuplicate.SearchAndReplace(templateText, inputJsonText));
			return 0;
		}
		catch (TemplateCompilationException tce)
		{
			var realErrors = tce.CompilerErrors
				.Where(e => !e.IsWarning && !e.ErrorText.Contains("Assuming assembly reference"))
				.Select(e => $"  Line {e.Line}: {e.ErrorText}");
			WriteError("Template compilation error:\n" + string.Join("\n", realErrors));
			return 1;
		}
		catch (Exception ex)
		{
			WriteErrorFull(ex);
			return 1;
		}
	}

	static void WriteError(string msg) =>
		Console.Error.WriteLine(JsonConvert.SerializeObject(new { error = msg }));

	static void WriteErrorFull(Exception ex)
	{
		var msg = ex.Message + "\n--- STACK ---\n" + ex.StackTrace;
		if (ex.InnerException != null)
			msg += "\n--- INNER ---\n" + ex.InnerException.Message + "\n" + ex.InnerException.StackTrace;
		Console.Error.WriteLine(JsonConvert.SerializeObject(new { error = msg }));
	}
}
