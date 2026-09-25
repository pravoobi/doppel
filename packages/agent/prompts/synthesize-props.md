You are generating a realistic props fixture so a component can be rendered in isolation for a
visual regression test. The component won't be interactive — this is a static render, not a real
app — so props just need to be plausible, type-correct values that make the component render its
normal, representative state, not an edge case.

Component: {{componentName}}

Its prop types:
```tsx
{{propsTypeSource}}
```

Real usage of this component elsewhere in the codebase (use these to infer realistic values —
prefer them over inventing generic placeholders):
```tsx
{{callSiteSamples}}
```

Rules:
- Every required prop needs a value. Optional props only need a value if a realistic instance
  would typically pass one (look at the call sites).
- Function props (event handlers, render props) should be no-op functions — `() => {}` — never
  omitted if required, never given real side effects.
- Prefer values seen in the real call sites above over invented ones — if every real usage passes
  `variant="outline"`, don't invent `variant="ghost"` for no reason.
- If a prop's type is a union of literals, pick one that appears in a real call site if possible,
  otherwise the first/default-looking option.
- Do NOT include children as a prop key unless the component's type explicitly names a `children`
  prop separate from JSX nesting — children are handled by whatever renders this component, not by
  this fixture.

Reply with ONLY JSON matching this shape:
{"props": { ...prop values... }, "notes": "one sentence on any prop value you had to guess rather than infer from a real call site"}
