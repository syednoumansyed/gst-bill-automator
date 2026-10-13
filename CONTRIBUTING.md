# Contributing

Thanks for helping. Keep changes small and focused.

1. Fork, then create a branch.
2. `npm ci && npm run dev` (Node version in `.nvmrc`).
3. Before opening a PR run `npm run lint`, `npx tsc --noEmit` and `npm run build`
   (and `npm test` if present).
4. Describe what changed and why.

Rules:

- Never commit real invoices, FIRA PDFs, GSTINs, PANs, bank details or tokens.
  Test fixtures must be synthetic.
- Parser changes for new Deel or bank layouts need a redacted or synthetic
  fixture. The app must refuse rather than guess when a layout is unknown.
- Tax-rule changes should cite the relevant CGST/IGST provision or notification.
