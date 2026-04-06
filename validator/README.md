# RazorGen Validator Stub

This folder is a scaffold for the optional external validator used by RazorGen's `/api/validate` endpoint.

## Goal

Compile a generated Razor template against the same merge-builder behavior your production app uses:

- `merge` mode should validate against `RazorMergeDocumentBuilder`
- `json-epic` mode should validate against `RazorJsonMergeDocumentBuilder`

## Expected CLI contract

RazorGen can call any executable or script via:

```powershell
RAZOR_VALIDATE_COMMAND=dotnet run --project validator\RazorGenValidatorStub.csproj -- --mode {mode} --template {templatePath} --sample {samplePath}
```

RazorGen replaces:

- `{mode}` with `merge` or `json-epic`
- `{templatePath}` with a temp file containing the template
- `{samplePath}` with a temp file containing the sample JSON

The validator should print JSON to stdout in this shape:

```json
{
  "ok": true,
  "messages": [
    "Compiled successfully"
  ]
}
```

If compilation fails:

```json
{
  "ok": false,
  "messages": [
    "Template failed to compile",
    "error details here"
  ]
}
```

## Wiring it to your real engine

Because the actual merge builders live in your internal codebase, finish this stub by:

1. Adding project or assembly references to the assemblies that contain:
   - `Core.BusinessRules.MergeCodes.RazorMergeDocumentBuilder`
   - `Core.BusinessRules.MergeCodes.RazorJsonMergeDocumentBuilder`
2. Replacing the placeholder validation logic in `Program.cs` with real builder calls.
3. Publishing the tool somewhere the Node server can execute it.
4. Setting `RAZOR_VALIDATE_COMMAND` in RazorGen's `.env`.

## Suggested production behavior

- `merge` mode: call `SearchAndReplace(template, sampleObject)`
- `json-epic` mode: call `SearchAndReplace(template, sampleJsonString)`
- Capture compile/runtime exceptions and return them in the `messages` array
