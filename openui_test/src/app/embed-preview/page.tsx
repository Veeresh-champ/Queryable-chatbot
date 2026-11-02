import { notFound } from "next/navigation";

import { EmbedLauncher } from "@/components/embed-launcher";
import { BRAND } from "@/lib/brand";

export const metadata = { title: `Website embed preview | ${BRAND.productName}` };

/** Internal preview of the website launcher. Brand editions only. */
export default function EmbedPreviewPage() {
  if (!BRAND.id) notFound();
  const site = BRAND.websiteUrl.replace(/^https:\/\/(www\.)?/, "");
  return (
    <main className="qc-embed">
      <header className="qc-embed__bar">
        <img src={BRAND.logo.light} alt={BRAND.logo.alt} width={BRAND.logo.width} height={BRAND.logo.height} />
        <span className="qc-embed__tag">Internal preview</span>
      </header>
      <section className="qc-embed__body">
        <p className="qc-embed__eyebrow">Website embed</p>
        <h1 className="qc-embed__title">How {BRAND.productName} sits on {site}</h1>
        <p className="qc-embed__lede">
          Visitors see one launcher in the bottom right corner of every page. It opens the assistant in a panel they can
          drag, resize, minimise or expand, without leaving the page they were reading. Try it below.
        </p>
        <ol className="qc-embed__steps">
          <li>Open the launcher at the bottom right.</li>
          <li>Ask a question; the answer renders inside the panel.</li>
          <li>Drag the header to move it, or use the controls to minimise, expand or close.</li>
        </ol>
      </section>
      <EmbedLauncher />
    </main>
  );
}
