import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CitationSourcePreview, type CitationPreviewSource } from "../../src/components/chat/citation-source-preview";
import "../../src/app/globals.css";

const fixtureSource: CitationPreviewSource = {
  label: "Employment Rights Act — original source",
  originalUrl: "/api/chat/sources/fixture-message/0?chat=owned#page=2",
  pageNumber: 2,
  passages: [{ pageNumber: 2, quote: "Every worker has the right to fair notice before dismissal." }],
};

function sourceForScenario(scenario: string): CitationPreviewSource {
  switch (scenario) {
    case "page-only": return { ...fixtureSource, passages: undefined };
    case "hash-page": return { ...fixtureSource, pageNumber: undefined, passages: undefined };
    case "mismatch": return { ...fixtureSource, passages: [{ pageNumber: 2, quote: "This unsupported sentence does not appear in the original document." }] };
    case "scan": return { ...fixtureSource, pageNumber: 1, passages: [{ pageNumber: 1, quote: "Every worker has the right to fair notice before dismissal." }] };
    case "duplicate": return { ...fixtureSource, pageNumber: 1, passages: [{ pageNumber: 1, quote: "Every worker has the right to fair notice before dismissal." }] };
    case "multiple": return { ...fixtureSource, passages: [...fixtureSource.passages!, { pageNumber: 3, quote: "The employer must provide a written explanation." }] };
    case "unavailable": return { label: fixtureSource.label };
    case "out-of-range": return { ...fixtureSource, pageNumber: 99, passages: undefined };
    default: return fixtureSource;
  }
}

function App() {
  const [open, setOpen] = useState(false);
  const scenario = new URLSearchParams(window.location.search).get("scenario") ?? "exact";
  return <main className="mx-auto max-w-3xl p-8">
    <h1 className="mb-4 text-2xl font-semibold">Citation preview browser fixture</h1>
    <p className="mb-6 text-muted-foreground">All document bytes are generated locally. No backend, account, or AI provider is used.</p>
    <button type="button" className="rounded-md border px-4 py-2" onClick={() => setOpen(true)}>Open citation</button>
    <a href="#outside" className="ml-4 underline">Outside dialog link</a>
    {open && <CitationSourcePreview source={sourceForScenario(scenario)} onClose={() => setOpen(false)} />}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
