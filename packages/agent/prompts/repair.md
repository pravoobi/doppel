Your previous migration failed to typecheck. You get exactly one repair attempt — make it count.

The original hand-rolled code being replaced:
```tsx
{{candidateSource}}
```

{{componentName}}'s props:
{{componentProps}}

{{componentName}}'s variants:
{{componentVariants}}

Your previous replacement:
```tsx
{{previousReplacementJsx}}
```

The compiler error it produced:
```
{{compilerError}}
```

Fix ONLY what the error requires. Do not restructure the migration otherwise — the rest of it was
never reported as broken.

If the error says something like "no corresponding closing tag" or "'{' or JSX element expected",
your previous `replacementJsx` was truncated mid-element — write the COMPLETE element this time,
fully closed, not a partial fragment. Use single quotes for JSX attribute string values
(`variant='destructive'`, not `variant="destructive"`) — `replacementJsx` is itself a JSON string,
and a literal `"` inside it needs escaping as `\"`; single quotes avoid that entirely and may be
why the previous attempt got cut short.

Reply with ONLY JSON matching this shape:
{"replacementJsx": string, "importsToAdd": string[], "notes": string, "confidence": number}
