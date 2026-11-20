"use client";

import { useState } from "react";
import { FloatingPanel } from "@ark-ui/react/floating-panel";
import { Portal } from "@ark-ui/react/portal";
import { ArrowDownLeft, Maximize2, MessageCircle, Minus, X } from "lucide-react";

import { BRAND } from "@/lib/brand";

/* Adapted from 21st.dev Floating Panel, Chat Widget demo (anubra266, id 6327):
   same Ark UI parts and controls; Tailwind classes replaced by app/brand-editions.css
   (.qc-embed-*) since this app has no Tailwind; demo messages replaced by an
   iframe of the real chat at "/". */

function fit() {
  const margin = window.innerWidth < 640 ? 16 : 24;
  const size = {
    width: Math.min(400, window.innerWidth - margin * 2),
    height: Math.min(640, window.innerHeight - 56 - margin * 3),
  };
  return { margin, size };
}

export function EmbedLauncher() {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState({ width: 400, height: 640 });

  return (
    <FloatingPanel.Root
      open={open}
      onOpenChange={(details) => {
        if (details.open) setSize(fit().size);
        setOpen(details.open);
      }}
      size={size}
      onSizeChange={(details) => setSize(details.size)}
      minSize={{ width: 300, height: 360 }}
      // Bottom right, just above the launcher.
      getAnchorPosition={() => {
        const { margin, size: next } = fit();
        return { x: window.innerWidth - next.width - margin, y: window.innerHeight - next.height - 56 - margin * 2 };
      }}
    >
      <FloatingPanel.Trigger className="qc-embed-launcher" aria-label={`Open ${BRAND.productName}`}>
        {open ? <X size={24} aria-hidden="true" /> : <MessageCircle size={24} aria-hidden="true" />}
      </FloatingPanel.Trigger>

      <Portal>
        <FloatingPanel.Positioner className="qc-embed-positioner">
          <FloatingPanel.Content className="qc-embed-panel">
            <FloatingPanel.DragTrigger>
              <FloatingPanel.Header className="qc-embed-panel__header">
                <div className="qc-embed-panel__title-row">
                  <MessageCircle size={18} aria-hidden="true" />
                  <FloatingPanel.Title className="qc-embed-panel__title">{BRAND.productName}</FloatingPanel.Title>
                </div>
                <FloatingPanel.Control className="qc-embed-panel__controls">
                  <FloatingPanel.StageTrigger stage="minimized" className="qc-embed-panel__control" aria-label="Minimise">
                    <Minus size={14} aria-hidden="true" />
                  </FloatingPanel.StageTrigger>
                  <FloatingPanel.StageTrigger stage="maximized" className="qc-embed-panel__control" aria-label="Expand">
                    <Maximize2 size={14} aria-hidden="true" />
                  </FloatingPanel.StageTrigger>
                  <FloatingPanel.StageTrigger stage="default" className="qc-embed-panel__control" aria-label="Restore">
                    <ArrowDownLeft size={14} aria-hidden="true" />
                  </FloatingPanel.StageTrigger>
                  <FloatingPanel.CloseTrigger className="qc-embed-panel__control" aria-label="Close">
                    <X size={14} aria-hidden="true" />
                  </FloatingPanel.CloseTrigger>
                </FloatingPanel.Control>
              </FloatingPanel.Header>
            </FloatingPanel.DragTrigger>

            <FloatingPanel.Body className="qc-embed-panel__body">
              <iframe className="qc-embed-panel__frame" src="/" title={BRAND.productName} />
            </FloatingPanel.Body>

            <FloatingPanel.ResizeTrigger axis="n" />
            <FloatingPanel.ResizeTrigger axis="e" />
            <FloatingPanel.ResizeTrigger axis="w" />
            <FloatingPanel.ResizeTrigger axis="s" />
            <FloatingPanel.ResizeTrigger axis="se" />
            <FloatingPanel.ResizeTrigger axis="sw" />
          </FloatingPanel.Content>
        </FloatingPanel.Positioner>
      </Portal>
    </FloatingPanel.Root>
  );
}
