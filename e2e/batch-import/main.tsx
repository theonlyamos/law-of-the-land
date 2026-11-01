import { createRoot } from "react-dom/client";
import { useState } from "react";
import { BatchImport } from "../../src/components/admin/batch-import";
import { resolveDelayedCommit } from "./convex-stub";
import { ReviewFixture } from "./review-fixture";
import "../../src/app/globals.css";

function App() {
  const [visible, setVisible] = useState(true);
  const query = window.location.search;
  const review = new URLSearchParams(query).get("review") === "1";
  function navigate(show: boolean) {
    history.pushState(null, "", `${show ? "/" : "/away"}${query}`);
    setVisible(show);
  }
  return <main className="mx-auto max-w-6xl p-4 sm:p-8">
    <p className="mb-5 text-sm">Isolated browser fixture: local test metadata and generated PDFs only.</p>
    {review ? <ReviewFixture /> : visible ? <BatchImport userId="batch-browser-admin" maxBytes={1_000_000} /> : <p>Fixture route away from batch screen.</p>}
    <a href="/away" className="mt-8 block underline">Fixture navigation away</a>
    <div className="mt-4 flex flex-wrap gap-4">
      <button type="button" onClick={() => navigate(!visible)} className="border p-2">{visible ? "Fixture navigate away" : "Fixture return to batch"}</button>
      <button type="button" onClick={resolveDelayedCommit} className="border p-2">Resolve delayed commit</button>
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
